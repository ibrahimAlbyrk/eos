//! Verdicts on a goal: the command check's, the judge's prompt variables and
//! how its answer is read (`core/src/domain/judge-rubric.ts`,
//! `core/src/services/LlmJudgeStrategy.ts`,
//! `infra/src/goalcheck/DeterministicCommandStrategy.ts`).

use std::collections::HashSet;

use eos_contracts::{GoalSpec, GoalVerdict, GoalVerdictCriteriaItem};
use serde_json::{Map, Value};

use crate::text::{utf16_len, utf16_prefix};

/// The judge's prompt in the library.
pub const JUDGE_RUBRIC: &str = "loop/judge-rubric";

const CLAIM_CAP: usize = 4000;

/// `s`, cut after `max` UTF-16 units with a note when it is longer.
pub fn truncate(s: &str, max: usize) -> String {
    if utf16_len(s) > max { format!("{}\n...[truncated]", utf16_prefix(s, max)) } else { s.to_owned() }
}

/// A verify command's result: the strongest evidence there is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MachineSignal {
    pub criterion_id: Option<String>,
    pub command: String,
    pub exit_code: i32,
    pub output: String,
}

/// What the judge grades: artifacts, never the worker's word.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct EvidenceBundle {
    pub machine_signals: Vec<MachineSignal>,
    pub diff: Option<String>,
    /// The base the diff was taken against; set exactly when a worktree diff was collected.
    pub diff_base: Option<String>,
    /// `(path, content)` of the files the criteria name.
    pub files: Vec<(String, String)>,
    /// The worker's report: a claim to verify.
    pub report_claim: Option<String>,
}

fn vars(pairs: Vec<(&str, String)>) -> Map<String, Value> {
    pairs.into_iter().map(|(name, value)| (name.to_owned(), Value::String(value))).collect()
}

/// The judge rubric's variables. An empty `FILES` drops the files section.
pub fn judge_vars(goal: &GoalSpec, bundle: &EvidenceBundle) -> Map<String, Value> {
    let criteria = goal
        .criteria
        .iter()
        .map(|c| format!("- [{}] {}   (verify: {})", c.id, c.text, c.verify.as_deref().unwrap_or("—")))
        .collect::<Vec<_>>()
        .join("\n");
    let machine_signals = if bundle.machine_signals.is_empty() {
        "(none)".to_owned()
    } else {
        bundle
            .machine_signals
            .iter()
            .flat_map(|s| {
                let output = if s.output.is_empty() { "(no output)".to_owned() } else { s.output.clone() };
                [
                    format!("[{}] $ {}  ->  exit {}", s.criterion_id.as_deref().unwrap_or("—"), s.command, s.exit_code),
                    output,
                ]
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    // An empty diff says why: no worktree to read, or nothing changed against its base.
    let diff = match (&bundle.diff, &bundle.diff_base) {
        (Some(diff), _) if !diff.is_empty() => diff.clone(),
        (_, Some(_)) => "(empty against base)".to_owned(),
        _ => "(no worktree — not collected)".to_owned(),
    };
    let files =
        bundle.files.iter().map(|(path, content)| format!("=== {path} ===\n{content}")).collect::<Vec<_>>().join("\n");
    vars(vec![
        ("GOAL_SUMMARY", goal.summary.clone()),
        ("CRITERIA", criteria),
        ("MACHINE_SIGNALS", machine_signals),
        ("DIFF_BASE", format!("base {}", bundle.diff_base.as_deref().unwrap_or("HEAD"))),
        ("DIFF", diff),
        ("FILES", files),
        ("CLAIM", truncate(bundle.report_claim.as_deref().unwrap_or("(none)"), CLAIM_CAP)),
    ])
}

/// The judge's answer as a verdict: the JSON object in it (a code fence
/// around it allowed), or `None` when there is none or it is not a verdict.
pub fn parse_verdict(raw: &str) -> Option<GoalVerdict> {
    let mut text = raw.trim();
    if text.len() >= 3 && text[..3].eq_ignore_ascii_case("```") {
        text = &text[3..];
        if text.len() >= 4 && text[..4].eq_ignore_ascii_case("json") {
            text = &text[4..];
        }
        text = text.trim_start();
    }
    if let Some(body) = text.strip_suffix("```") {
        text = body.trim_end();
    }
    let (start, end) = (text.find('{')?, text.rfind('}')?);
    if end <= start {
        return None;
    }
    let value: Value = serde_json::from_str(&text[start..=end]).ok()?;
    eos_contracts::parse(&value).ok()
}

/// `met` only when the judge says so and every criterion agrees: a reading
/// that only ever tightens. An unverifiable criterion is never met, and every
/// unmet criterion is in `unmet`.
pub fn normalize(verdict: GoalVerdict) -> GoalVerdict {
    let criteria: Vec<GoalVerdictCriteriaItem> = verdict
        .criteria
        .into_iter()
        .map(|c| if c.unverifiable == Some(true) && c.met { GoalVerdictCriteriaItem { met: false, ..c } } else { c })
        .collect();
    let met = verdict.met && !criteria.is_empty() && criteria.iter().all(|c| c.met);
    let mut unmet = verdict.unmet;
    let mut seen: HashSet<String> = unmet.iter().cloned().collect();
    for c in criteria.iter().filter(|c| !c.met) {
        if seen.insert(c.id.clone()) {
            unmet.push(c.id.clone());
        }
    }
    GoalVerdict { met, criteria, unmet, ..verdict }
}

/// The check itself failed (no evidence, no readable answer): every criterion
/// unmet, flagged `indeterminate` so it is never taken as a judgment of the work.
pub fn fail_closed(goal: &GoalSpec, reason: &str) -> GoalVerdict {
    GoalVerdict {
        met: false,
        criteria: goal
            .criteria
            .iter()
            .map(|c| GoalVerdictCriteriaItem {
                id: c.id.clone(),
                met: false,
                evidence: reason.to_owned(),
                unverifiable: None,
            })
            .collect(),
        unmet: goal.criteria.iter().map(|c| c.id.clone()).collect(),
        confidence: 0.0.into(),
        reason: reason.to_owned(),
        indeterminate: Some(true),
    }
}

/// What a criterion's verify command found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Checked {
    /// No command: the judge owns it.
    NoVerify,
    /// Cancelled because another criterion failed first: its status is unknown.
    Skipped,
    Exit {
        code: i32,
        command: String,
    },
}

/// The command check's verdict: a criterion is met when its command exits 0;
/// one with no command is unmet; a skipped one is unknown, not failed, so it
/// stays out of `unmet`.
pub fn command_verdict(goal: &GoalSpec, checked: &[Checked]) -> GoalVerdict {
    let rows: Vec<(GoalVerdictCriteriaItem, bool)> = goal
        .criteria
        .iter()
        .zip(checked)
        .map(|(c, result)| {
            let (met, skipped, evidence) = match result {
                Checked::NoVerify => (false, false, "no deterministic verify; needs judge".to_owned()),
                Checked::Skipped => (false, true, "skipped: another criterion already failed".to_owned()),
                Checked::Exit { code, command } => (*code == 0, false, format!("exit {code}: {command}")),
            };
            (GoalVerdictCriteriaItem { id: c.id.clone(), met, evidence, unverifiable: None }, skipped)
        })
        .collect();
    let unmet: Vec<String> = rows.iter().filter(|(c, skipped)| !c.met && !skipped).map(|(c, _)| c.id.clone()).collect();
    let met = rows.iter().all(|(c, _)| c.met);
    GoalVerdict {
        met,
        criteria: rows.into_iter().map(|(c, _)| c).collect(),
        reason: if met { "all verify commands passed".to_owned() } else { format!("unmet: {}", unmet.join(", ")) },
        unmet,
        confidence: 1.0.into(),
        indeterminate: None,
    }
}

#[cfg(test)]
mod tests {
    use eos_contracts::GoalSpecCriteriaItem;

    use super::*;

    fn goal() -> GoalSpec {
        GoalSpec {
            summary: "Ship".into(),
            criteria: vec![
                GoalSpecCriteriaItem { id: "c1".into(), text: "tests pass".into(), verify: Some("npm test".into()) },
                GoalSpecCriteriaItem { id: "c2".into(), text: "README updated".into(), verify: None },
            ],
        }
    }

    // core/src/__tests__/LlmJudgeStrategy.test.ts
    #[test]
    fn the_answer_is_read_through_a_fence_and_surrounding_prose() {
        let json = r#"{"met":true,"criteria":[{"id":"c1","met":true,"evidence":"exit 0"}],"unmet":[],"confidence":0.9,"reason":"ok"}"#;
        assert!(parse_verdict(json).is_some_and(|v| v.met));
        assert!(parse_verdict(&format!("```json\n{json}\n```")).is_some());
        assert!(parse_verdict(&format!("Here you go: {json} done")).is_some());
        assert_eq!(parse_verdict("not json at all"), None);
        assert_eq!(parse_verdict(r#"{"met": "yes"}"#), None);
    }

    #[test]
    fn met_only_holds_when_every_criterion_agrees() {
        let row = |id: &str, met: bool, unverifiable: Option<bool>| GoalVerdictCriteriaItem {
            id: id.into(),
            met,
            evidence: "e".into(),
            unverifiable,
        };
        let claimed = GoalVerdict {
            met: true,
            criteria: vec![row("c1", true, None), row("c2", true, Some(true))],
            unmet: vec![],
            confidence: 1.0.into(),
            reason: "r".into(),
            indeterminate: None,
        };
        let read = normalize(claimed);
        assert!(!read.met && !read.criteria[1].met);
        assert_eq!(read.unmet, ["c2"]);
        let empty = GoalVerdict { criteria: vec![], ..read.clone() };
        assert!(!normalize(GoalVerdict { met: true, ..empty }).met, "no criteria proves nothing");
    }

    #[test]
    fn a_failed_check_is_unmet_and_indeterminate() {
        let v = fail_closed(&goal(), "judge output unparseable");
        assert_eq!((v.met, v.unmet.len(), v.indeterminate), (false, 2, Some(true)));
    }

    // infra/src/__tests__/DeterministicCommandStrategy.test.ts
    #[test]
    fn the_command_check_meets_on_exit_zero_and_skips_are_not_failures() {
        let exit = |code| Checked::Exit { code, command: "npm test".into() };
        let all = command_verdict(&goal(), &[exit(0), Checked::NoVerify]);
        assert_eq!((all.met, all.unmet.clone(), all.reason.as_str()), (false, vec!["c2".to_owned()], "unmet: c2"));
        let skipped = command_verdict(&goal(), &[exit(1), Checked::Skipped]);
        assert_eq!(skipped.unmet, ["c1"]);
        let one = GoalSpec { criteria: goal().criteria[..1].to_vec(), ..goal() };
        let passed = command_verdict(&one, &[exit(0)]);
        assert_eq!((passed.met, passed.reason.as_str()), (true, "all verify commands passed"));
    }

    #[test]
    fn the_judge_sees_why_a_diff_is_empty_and_files_only_when_there_are_some() {
        let none = judge_vars(&goal(), &EvidenceBundle::default());
        assert_eq!(none["DIFF"], "(no worktree — not collected)");
        assert_eq!((none["MACHINE_SIGNALS"].as_str(), none["FILES"].as_str()), (Some("(none)"), Some("")));
        assert_eq!(none["CRITERIA"], "- [c1] tests pass   (verify: npm test)\n- [c2] README updated   (verify: —)");
        let worktree = EvidenceBundle { diff_base: Some("abc".into()), ..EvidenceBundle::default() };
        let read = judge_vars(&goal(), &worktree);
        assert_eq!(
            (read["DIFF"].as_str(), read["DIFF_BASE"].as_str()),
            (Some("(empty against base)"), Some("base abc"))
        );
        assert_eq!(truncate("abcdef", 3), "abc\n...[truncated]");
    }
}
