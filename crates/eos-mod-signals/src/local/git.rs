//! A branch of a repository on this computer (02 §4.5 "git"). The cursor
//! is `{sha}`, the branch's tip last seen. A new tip is one signal for the
//! whole range since: how many commits, by whom, which paths, and
//! `rewritten` when the old tip is no longer in the branch's history (a
//! force-push). The first read only keeps the tip.

use std::path::Path;

use eos_contracts::{Fact, Facts, Num};
use eos_core::signals::SignalDraft;
use eos_core::store::StoredSignalSource;
use eos_domain::signals::key;
use serde_json::json;

use super::{GIT_PATHS_MAX, Local, Read, cursor_of, page};

/// The commits one range reads at most; `count` stops there.
const RANGE_MAX: u32 = 1_000;

impl Local {
    /// Reads the branch's tip and answers the page of the range since the
    /// last, or `None` when the tip did not move.
    pub(super) async fn read_git(&self, row: &StoredSignalSource, repo: &Path) -> Read {
        let scope: serde_json::Value = serde_json::from_str(&row.scope_json).unwrap_or_default();
        let branch = scope["branch"].as_str().unwrap_or_default();
        let Some(tip) = self.git_info.branch_tip(repo, branch).await else { return Err("missing") };
        let last = cursor_of(row).and_then(|cursor| cursor["sha"].as_str().map(str::to_owned));
        let cursor = json!({ "sha": tip });
        let Some(last) = last else { return Ok(Some(page(Vec::new(), cursor))) };
        if last == tip {
            return Ok(None);
        }
        let rewritten = !self.git_info.is_ancestor(repo, &last, &tip).await;
        // The old tip may be gone after a force-push: the tip stands alone.
        let commits = match self.git_info.log_range(repo, Some(&last), &tip, RANGE_MAX).await {
            Some(commits) => commits,
            None => self.git_info.log_range(repo, None, &tip, 1).await.unwrap_or_default(),
        };
        let mut authors: Vec<String> = Vec::new();
        let mut paths: Vec<String> = Vec::new();
        for commit in &commits {
            if !authors.contains(&commit.author) {
                authors.push(commit.author.clone());
            }
            for path in &commit.paths {
                if paths.len() < GIT_PATHS_MAX && !paths.contains(path) {
                    paths.push(path.clone());
                }
            }
        }
        let repo_text = repo.to_string_lossy().into_owned();
        let key = key::git(&repo_text, branch, &tip);
        let mut facts = Facts::new();
        facts.insert("repo".into(), Fact::Text(repo_text.clone()));
        facts.insert("branch".into(), Fact::Text(branch.to_owned()));
        facts.insert("count".into(), Fact::Number(Num::from(commits.len() as i64)));
        facts.insert("authors".into(), Fact::List(authors));
        facts.insert("paths".into(), Fact::List(paths));
        facts.insert("rewritten".into(), Fact::Bool(rewritten));
        let item = json!({
            "kind": "git.commits", "key": key, "title": branch, "path": repo_text, "version": tip, "untrusted": false,
        });
        let draft = SignalDraft {
            key,
            subject: format!("git:{repo_text}:{branch}"),
            version: Some(tip.clone()),
            kind: "commits".into(),
            occurred_at: self.clock.now_ms(),
            facts,
            item,
        };
        Ok(Some(page(vec![draft], cursor)))
    }
}
