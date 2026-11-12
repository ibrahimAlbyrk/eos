//! Whether a goal is met (`infra/src/goalcheck/*`, `core/src/services/LlmJudgeStrategy.ts`,
//! `HybridStrategy.ts`).
//!
//! - `command`: each criterion's verify command, in parallel; exit 0 is met,
//!   and the first failure cancels the rest (a cancelled one is unknown, not failed).
//! - `judge`: a model grades the criteria over artifacts (command outputs, the
//!   worker's diff, the files the criteria name), never over the worker's word.
//!   A check that cannot run (no evidence, no readable answer after one retry)
//!   is unmet and `indeterminate`.
//! - `hybrid`: the commands first; a failing one decides, the judge is not asked.

use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use eos_contracts::{GoalSpec, GoalVerdict, LoopCheckPhase, LoopStrategy};
use eos_core::agent::{OneShot, OneShotRequest};
use eos_core::git::GitDiffs;
use eos_domain::loops::verdict::{
    Checked, EvidenceBundle, JUDGE_RUBRIC, MachineSignal, command_verdict, fail_closed, judge_vars, normalize,
    parse_verdict, truncate,
};
use eos_kit_fs::path::normalize as normalize_path;
use eos_prompts::PromptService;
use eos_prompts::service::no_values;
use futures_util::StreamExt;
use futures_util::stream::FuturesUnordered;
use regress::Regex;
use serde_json::Value;

use crate::commands::Memo;

const OUTPUT_CAP: usize = 8000;
const DIFF_CAP: usize = 40000;
const FILE_CAP: usize = 8000;
const MAX_FILES: usize = 10;
const MAX_FILE_BYTES: u64 = 1024 * 1024;
/// A judge's answer is one completion; past this the check could not run.
const JUDGE_TIMEOUT: Duration = Duration::from_secs(120);

/// Path-like tokens of a criterion: ones with a separator (bare names would
/// catch versions and prose), a Windows path whole.
static PATH_TOKEN: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"(?<!\w)[A-Za-z]:[\\/][\w.\\/~-]+|[\w./~-]+").ok());

/// The worker being checked.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct Subject {
    pub(crate) worker_id: String,
    /// Its own worktree: the diff is read there.
    pub(crate) worktree_dir: Option<PathBuf>,
    /// Its folder when it has no worktree.
    pub(crate) cwd: Option<PathBuf>,
    pub(crate) fork_base_sha: Option<String>,
    /// The worker's held report: a claim to verify.
    pub(crate) report: Option<String>,
}

impl Subject {
    /// Where its commands run and the criteria's paths are read.
    fn dir(&self) -> Option<&Path> {
        self.worktree_dir.as_deref().or(self.cwd.as_deref())
    }
}

/// What a check uses.
pub(crate) struct Checker {
    pub(crate) diffs: Arc<dyn GitDiffs>,
    pub(crate) judge: Arc<dyn OneShot>,
    pub(crate) prompts: Arc<PromptService>,
    pub(crate) judge_model: String,
}

/// Reports which phase a check is in, and the criterion being verified.
pub(crate) type Progress<'a> = &'a (dyn Fn(LoopCheckPhase, Option<&str>) + Send + Sync);

async fn run_in(memo: &Memo, subject: &Subject, line: &str) -> (i32, String) {
    match subject.dir() {
        Some(dir) => {
            let result = memo.run(dir, line).await;
            (result.exit_code, result.output)
        }
        None => (127, "the worker has no folder to run in".to_owned()),
    }
}

impl Checker {
    pub(crate) async fn evaluate(
        &self,
        strategy: LoopStrategy,
        goal: &GoalSpec,
        subject: &Subject,
        memo: &Memo,
        progress: Progress<'_>,
    ) -> GoalVerdict {
        match strategy {
            LoopStrategy::Command => command(goal, subject, memo, progress).await,
            LoopStrategy::Judge => self.judge(goal, subject, memo, progress).await,
            LoopStrategy::Hybrid => {
                let checked = command(goal, subject, memo, progress).await;
                // A real verify command that failed decides: the judge must not overrule a red command.
                let failed = goal
                    .criteria
                    .iter()
                    .any(|c| c.verify.is_some() && checked.criteria.iter().any(|row| row.id == c.id && !row.met));
                if failed { checked } else { self.judge(goal, subject, memo, progress).await }
            }
        }
    }

    async fn judge(&self, goal: &GoalSpec, subject: &Subject, memo: &Memo, progress: Progress<'_>) -> GoalVerdict {
        progress(LoopCheckPhase::Judging, None);
        let bundle = self.evidence(goal, subject, memo).await;
        let vars = judge_vars(goal, &bundle);
        for retry in [false, true] {
            let mut vars = vars.clone();
            if retry {
                vars.insert("RETRY".into(), Value::String("1".into()));
            }
            if let Some(verdict) = self.ask_judge(&vars).await {
                return normalize(verdict);
            }
        }
        tracing::warn!(worker_id = subject.worker_id, "the judge's answer could not be read");
        fail_closed(goal, "judge output unparseable")
    }

    async fn ask_judge(&self, vars: &serde_json::Map<String, Value>) -> Option<GoalVerdict> {
        let prompt = match self.prompts.render(JUDGE_RUBRIC, vars, &no_values()) {
            Ok(prompt) => prompt.trim().to_owned(),
            Err(e) => {
                tracing::warn!(error = %e, "the judge's rubric could not be rendered");
                return None;
            }
        };
        let request = OneShotRequest {
            model: Some(self.judge_model.clone()),
            timeout: Some(JUDGE_TIMEOUT),
            ..OneShotRequest::new(prompt)
        };
        match self.judge.complete(request).await {
            Ok(answer) => parse_verdict(&answer.text),
            Err(e) => {
                tracing::warn!(error = %e, "the judge could not be asked");
                None
            }
        }
    }

    /// What the judge grades: each verify command's result, the worktree's
    /// whole contribution since its fork, and the files the criteria name.
    async fn evidence(&self, goal: &GoalSpec, subject: &Subject, memo: &Memo) -> EvidenceBundle {
        let mut machine_signals = Vec::new();
        for c in &goal.criteria {
            let Some(line) = &c.verify else { continue };
            let (exit_code, output) = run_in(memo, subject, line).await;
            machine_signals.push(MachineSignal {
                criterion_id: Some(c.id.clone()),
                command: line.clone(),
                exit_code,
                output: truncate(&output, OUTPUT_CAP),
            });
        }
        let (mut diff, mut diff_base) = (None, None);
        if let Some(worktree) = &subject.worktree_dir {
            diff_base = Some(subject.fork_base_sha.clone().unwrap_or_else(|| "HEAD".to_owned()));
            let whole = self.diffs.full_diff(worktree, subject.fork_base_sha.as_deref()).await;
            diff = whole.filter(|d| !d.is_empty()).map(|d| truncate(&d, DIFF_CAP));
        }
        let files = match subject.dir() {
            Some(dir) => named_files(goal, dir.to_owned()).await,
            None => Vec::new(),
        };
        EvidenceBundle { machine_signals, diff, diff_base, files, report_claim: subject.report.clone() }
    }
}

/// The verify commands, in parallel; the first that fails cancels the others.
async fn command(goal: &GoalSpec, subject: &Subject, memo: &Memo, progress: Progress<'_>) -> GoalVerdict {
    let mut checked: Vec<Checked> =
        goal.criteria.iter().map(|c| if c.verify.is_some() { Checked::Skipped } else { Checked::NoVerify }).collect();
    let mut running = FuturesUnordered::new();
    for (index, c) in goal.criteria.iter().enumerate() {
        let Some(line) = c.verify.clone() else { continue };
        progress(LoopCheckPhase::Verifying, Some(&c.id));
        running.push(async move {
            let (code, _) = run_in(memo, subject, &line).await;
            (index, code, line)
        });
    }
    while let Some((index, code, command)) = running.next().await {
        checked[index] = Checked::Exit { code, command };
        if code != 0 {
            // Dropping the rest ends their commands.
            break;
        }
    }
    drop(running);
    command_verdict(goal, &checked)
}

/// The tokens of a criterion that read as paths.
fn path_tokens(text: &str) -> Vec<String> {
    let Some(re) = PATH_TOKEN.as_ref() else { return Vec::new() };
    re.find_iter(text)
        .map(|m| &text[m.range()])
        .filter(|t| !t.contains("://") && !t.starts_with("//"))
        .map(|t| t.trim_end_matches(['.', '/', '\\']).to_owned())
        .filter(|t| t.contains('/') || t.contains('\\'))
        .collect()
}

/// The files the criteria name, read from disk (never from the worker's
/// report): regular files of at most a megabyte, ten at most.
async fn named_files(goal: &GoalSpec, dir: PathBuf) -> Vec<(String, String)> {
    let tokens: Vec<String> = goal.criteria.iter().flat_map(|c| path_tokens(&c.text)).collect();
    let read = tokio::task::spawn_blocking(move || {
        let mut seen = std::collections::HashSet::new();
        let mut files = Vec::new();
        for token in tokens {
            if files.len() >= MAX_FILES {
                break;
            }
            let token = if token.starts_with("~/") { eos_platform::expand_path(&token) } else { token };
            let path = normalize_path(&dir.join(&token));
            if !seen.insert(path.clone()) {
                continue;
            }
            let readable = std::fs::metadata(&path).is_ok_and(|m| m.is_file() && m.len() <= MAX_FILE_BYTES);
            if let (true, Ok(bytes)) = (readable, std::fs::read(&path)) {
                let content = String::from_utf8_lossy(&bytes);
                files.push((path.to_string_lossy().into_owned(), truncate(&content, FILE_CAP)));
            }
        }
        files
    });
    read.await.unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    // infra/src/__tests__/GitEvidenceCollector.test.ts
    #[test]
    fn criteria_name_files_by_paths_with_a_separator() {
        assert_eq!(path_tokens("writes /tmp/h.txt."), ["/tmp/h.txt"]);
        assert_eq!(path_tokens("src/game.ts exports run, see v1.2 and https://x.dev/a"), ["src/game.ts"]);
        assert_eq!(path_tokens("Note:/tmp/x and ~/notes/a.md"), ["/tmp/x", "~/notes/a.md"]);
        assert!(path_tokens("index.html has a title").is_empty());
    }
}
