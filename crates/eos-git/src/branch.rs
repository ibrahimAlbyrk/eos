use std::path::Path;

use eos_contracts::{BranchDeleteResponse, BranchOpResponse, ConflictKind, FetchResponse, RemoteBranchDeleteResponse};
use eos_core::BoxFuture;
use eos_core::git::{
    BranchAdmin, BranchPush, CommandFailed, ConflictResolution, ConflictSide, OpResult, PullExec, PushExec, RemoteSync,
    WorkingTree, WorkingTreeRestore,
};
use eos_domain::git::pull_plan::PullExecReason;
use eos_domain::git::push_plan::{PushExecReason, PushKind, PushTarget};

use crate::Git;
use crate::run::{DEFAULT_CAP, Failed, Limits, REMOTE_TIMEOUT};

/// Fetch and pull print a line per ref.
const REMOTE_CAP: usize = 8 * 1024 * 1024;

fn failed(e: Failed) -> CommandFailed {
    CommandFailed(e.message)
}

fn branch_failed(e: &Failed) -> BranchOpResponse {
    BranchOpResponse { ok: false, branch: None, error: Some(e.first_line()) }
}

/// `word` appears in `text` with no letter, digit or underscore on either side.
fn has_word(text: &str, word: &str) -> bool {
    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    text.match_indices(word).any(|(at, _)| {
        !text[..at].chars().next_back().is_some_and(is_word)
            && !text[at + word.len()..].chars().next().is_some_and(is_word)
    })
}

fn contains_any(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| text.contains(needle))
}

/// Why a push failed, from what git printed. A stale lease also prints
/// `[rejected]`, so the lease and sign-in cases are looked for first.
fn classify_push(stderr: &str) -> PushExecReason {
    let s = stderr.to_lowercase();
    if contains_any(&s, &["stale info", "force-with-lease", "cannot lock ref", "would clobber"]) {
        PushExecReason::LeaseStale
    } else if contains_any(
        &s,
        &[
            "authentication",
            "could not read username",
            "permission denied",
            "access denied",
            "terminal prompts disabled",
        ],
    ) || has_word(&s, "403")
    {
        PushExecReason::Auth
    } else if has_word(&s, "rejected")
        || contains_any(&s, &["fetch first", "non-fast-forward", "tip of your current branch is behind"])
    {
        PushExecReason::Rejected
    } else {
        PushExecReason::Failed
    }
}

/// Local changes in the way ("commit or stash first") read apart from a
/// remote that moved since the last fetch.
fn classify_pull(stderr: &str, stdout: &str) -> PullExecReason {
    let s = format!("{stderr}\n{stdout}").to_lowercase();
    if contains_any(&s, &["would be overwritten", "local changes", "please commit", "please, commit", "stash"]) {
        PullExecReason::Conflict
    } else if contains_any(
        &s,
        &["not possible to fast-forward", "have diverged", "diverging", "non-fast-forward", "reconcile divergent"],
    ) {
        PullExecReason::Unrelated
    } else {
        PullExecReason::Failed
    }
}

/// Stage the file, or stage its removal, for one side of an add/delete conflict.
fn keeps_file(kind: ConflictKind, side: ConflictSide) -> bool {
    let ours = side == ConflictSide::Ours;
    match kind {
        ConflictKind::TheirsDeleted | ConflictKind::OursAdded => ours,
        ConflictKind::OursDeleted | ConflictKind::TheirsAdded => !ours,
        ConflictKind::BothDeleted => false,
        ConflictKind::Content => true,
    }
}

impl Git {
    async fn op(&self, cwd: &Path, args: &[&str]) -> OpResult {
        match self.run(cwd, args).await {
            Ok(_) => OpResult::ok(),
            Err(e) => OpResult::failed(e.first_line()),
        }
    }

    async fn stash_op(&self, cwd: &Path, verb: &str, index: u32) -> OpResult {
        match self.run(cwd, &["stash", verb, &format!("stash@{{{index}}}")]).await {
            Ok(_) => OpResult::ok(),
            Err(e) => OpResult::failed(e.detail()),
        }
    }
}

impl WorkingTree for Git {
    fn checkout<'a>(&'a self, cwd: &'a Path, branch: &'a str) -> BoxFuture<'a, Result<(), CommandFailed>> {
        Box::pin(async move { self.run(cwd, &["checkout", branch]).await.map(drop).map_err(failed) })
    }

    fn stash_push<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Result<(), CommandFailed>> {
        Box::pin(async move { self.run(cwd, &["stash", "push"]).await.map(drop).map_err(failed) })
    }

    fn stash_apply<'a>(&'a self, cwd: &'a Path, index: u32) -> BoxFuture<'a, OpResult> {
        Box::pin(self.stash_op(cwd, "apply", index))
    }

    fn stash_drop<'a>(&'a self, cwd: &'a Path, index: u32) -> BoxFuture<'a, OpResult> {
        Box::pin(self.stash_op(cwd, "drop", index))
    }
}

impl BranchAdmin for Git {
    fn create<'a>(
        &'a self,
        cwd: &'a Path,
        name: &'a str,
        start_point: Option<&'a str>,
        checkout: bool,
    ) -> BoxFuture<'a, BranchOpResponse> {
        Box::pin(async move {
            // `checkout -b`, as the plain checkout path uses `checkout`.
            let mut args = if checkout { vec!["checkout", "-b", name] } else { vec!["branch", name] };
            args.extend(start_point.filter(|s| !s.is_empty()));
            match self.run(cwd, &args).await {
                Ok(_) => BranchOpResponse { ok: true, branch: Some(name.to_owned()), error: None },
                Err(e) => branch_failed(&e),
            }
        })
    }

    fn rename<'a>(&'a self, cwd: &'a Path, from: &'a str, to: &'a str) -> BoxFuture<'a, BranchOpResponse> {
        Box::pin(async move {
            match self.run(cwd, &["branch", "-m", from, to]).await {
                Ok(_) => BranchOpResponse { ok: true, branch: Some(to.to_owned()), error: None },
                Err(e) => branch_failed(&e),
            }
        })
    }

    fn remove<'a>(&'a self, cwd: &'a Path, name: &'a str, force: bool) -> BoxFuture<'a, BranchDeleteResponse> {
        Box::pin(async move {
            match self.run(cwd, &["branch", if force { "-D" } else { "-d" }, name]).await {
                Ok(_) => BranchDeleteResponse { ok: true, deleted: Some(true), not_merged: None, error: None },
                Err(e) => {
                    let not_merged = !force && e.stderr_or_message().to_lowercase().contains("not fully merged");
                    BranchDeleteResponse {
                        ok: false,
                        deleted: None,
                        not_merged: not_merged.then_some(true),
                        error: Some(e.first_line()),
                    }
                }
            }
        })
    }
}

impl RemoteSync for Git {
    fn fetch<'a>(&'a self, cwd: &'a Path, remote: Option<&'a str>, prune: bool) -> BoxFuture<'a, FetchResponse> {
        Box::pin(async move {
            let remote = remote.filter(|r| !r.is_empty());
            let mut args = vec!["fetch"];
            args.extend(prune.then_some("--prune"));
            args.push(remote.unwrap_or("--all"));
            let limits = Limits { cap: REMOTE_CAP, timeout: Some(REMOTE_TIMEOUT) };
            match self.run_with(cwd, &args, &[], limits).await {
                Ok(_) => FetchResponse {
                    ok: true,
                    summary: Some(remote.map_or_else(|| "Fetched all remotes".to_owned(), |r| format!("Fetched {r}"))),
                    error: None,
                },
                Err(e) => FetchResponse { ok: false, summary: None, error: Some(e.first_line()) },
            }
        })
    }

    fn pull<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, PullExec> {
        Box::pin(async move {
            let limits = Limits { cap: REMOTE_CAP, timeout: Some(REMOTE_TIMEOUT) };
            match self.run_with(cwd, &["pull", "--ff-only"], &[], limits).await {
                Ok(ran) => PullExec {
                    ok: true,
                    code: 0,
                    stdout: ran.text(),
                    stderr: ran.stderr,
                    reason: PullExecReason::Pulled,
                },
                Err(e) => {
                    let stderr = e.stderr_or_message().to_owned();
                    let reason = classify_pull(&stderr, &e.stdout);
                    PullExec { ok: false, code: e.code.unwrap_or(1), stdout: e.stdout, stderr, reason }
                }
            }
        })
    }

    fn delete_remote_branch<'a>(
        &'a self,
        cwd: &'a Path,
        remote: &'a str,
        branch: &'a str,
    ) -> BoxFuture<'a, RemoteBranchDeleteResponse> {
        Box::pin(async move {
            let limits = Limits { cap: DEFAULT_CAP, timeout: Some(REMOTE_TIMEOUT) };
            match self.run_with(cwd, &["push", remote, "--delete", branch], &[], limits).await {
                Ok(_) => RemoteBranchDeleteResponse { ok: true, error: None },
                Err(e) => RemoteBranchDeleteResponse { ok: false, error: Some(e.first_line()) },
            }
        })
    }
}

impl BranchPush for Git {
    fn push<'a>(&'a self, cwd: &'a Path, target: &'a PushTarget) -> BoxFuture<'a, PushExec> {
        Box::pin(async move {
            let (remote, branch) = (target.remote.as_str(), target.branch.as_str());
            let args = match target.kind {
                PushKind::SetUpstream => vec!["push", "-u", remote, branch],
                PushKind::FastForward => vec!["push", remote, branch],
                PushKind::ForceWithLease => vec!["push", "--force-with-lease", remote, branch],
            };
            let limits = Limits { cap: DEFAULT_CAP, timeout: Some(REMOTE_TIMEOUT) };
            match self.run_with(cwd, &args, &[], limits).await {
                Ok(ran) => PushExec {
                    ok: true,
                    code: 0,
                    stdout: ran.text(),
                    stderr: ran.stderr,
                    reason: PushExecReason::Pushed,
                },
                Err(e) => {
                    let stderr = e.stderr_or_message().to_owned();
                    let reason = classify_push(&stderr);
                    PushExec { ok: false, code: e.code.unwrap_or(1), stdout: e.stdout, stderr, reason }
                }
            }
        })
    }
}

impl ConflictResolution for Git {
    fn write_resolved<'a>(
        &'a self,
        cwd: &'a Path,
        path: &'a str,
        content: &'a str,
    ) -> BoxFuture<'a, Result<(), CommandFailed>> {
        Box::pin(async move {
            let (file, bytes) = (cwd.join(path), content.as_bytes().to_vec());
            let display = file.display().to_string();
            tokio::task::spawn_blocking(move || std::fs::write(file, bytes))
                .await
                .map_err(|e| CommandFailed(e.to_string()))?
                .map_err(|e| CommandFailed(format!("{display}: {e}")))?;
            self.run(cwd, &["add", "--", path]).await.map(drop).map_err(failed)
        })
    }

    fn take_side<'a>(
        &'a self,
        cwd: &'a Path,
        path: &'a str,
        side: ConflictSide,
        kind: ConflictKind,
    ) -> BoxFuture<'a, Result<(), CommandFailed>> {
        Box::pin(async move {
            // `-f`: the path is unmerged or modified; the removal is staged anyway.
            let args: &[&str] = if keeps_file(kind, side) { &["add", "--", path] } else { &["rm", "-f", "--", path] };
            self.run(cwd, args).await.map(drop).map_err(failed)
        })
    }
}

impl WorkingTreeRestore for Git {
    fn restore_to_base<'a>(
        &'a self,
        cwd: &'a Path,
        paths: &'a [String],
        base: Option<&'a str>,
    ) -> BoxFuture<'a, OpResult> {
        Box::pin(async move {
            if paths.is_empty() {
                return OpResult::ok();
            }
            let mut args = vec!["restore", "--source", base.unwrap_or("HEAD"), "--staged", "--worktree", "--"];
            args.extend(paths.iter().map(String::as_str));
            self.op(cwd, &args).await
        })
    }

    fn remove_untracked<'a>(&'a self, cwd: &'a Path, paths: &'a [String]) -> BoxFuture<'a, OpResult> {
        Box::pin(async move {
            if paths.is_empty() {
                return OpResult::ok();
            }
            let mut args = vec!["clean", "-f", "--"];
            args.extend(paths.iter().map(String::as_str));
            self.op(cwd, &args).await
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_failures_are_told_apart_by_what_git_printed() {
        assert_eq!(classify_push(" ! [rejected] main -> main (stale info)"), PushExecReason::LeaseStale);
        assert_eq!(classify_push("fatal: Authentication failed for 'https://x'"), PushExecReason::Auth);
        assert_eq!(classify_push("The requested URL returned error: 403"), PushExecReason::Auth);
        assert_eq!(classify_push("error 4031 happened"), PushExecReason::Failed);
        assert_eq!(classify_push(" ! [rejected] main -> main (fetch first)"), PushExecReason::Rejected);
        assert_eq!(classify_push("fatal: unable to access"), PushExecReason::Failed);
    }

    #[test]
    fn pull_failures_separate_local_changes_from_a_moved_remote() {
        let local = "error: Your local changes to the following files would be overwritten by merge";
        assert_eq!(classify_pull(local, ""), PullExecReason::Conflict);
        assert_eq!(classify_pull("fatal: Not possible to fast-forward, aborting.", ""), PullExecReason::Unrelated);
        assert_eq!(classify_pull("fatal: no such remote", ""), PullExecReason::Failed);
    }

    #[test]
    fn each_side_of_an_add_delete_conflict_keeps_or_removes_the_file() {
        use ConflictKind::*;
        use ConflictSide::*;
        assert!(keeps_file(TheirsDeleted, Ours) && !keeps_file(TheirsDeleted, Theirs));
        assert!(!keeps_file(OursDeleted, Ours) && keeps_file(OursDeleted, Theirs));
        assert!(keeps_file(OursAdded, Ours) && !keeps_file(OursAdded, Theirs));
        assert!(!keeps_file(TheirsAdded, Ours) && keeps_file(TheirsAdded, Theirs));
        assert!(!keeps_file(BothDeleted, Ours) && !keeps_file(BothDeleted, Theirs));
    }
}
