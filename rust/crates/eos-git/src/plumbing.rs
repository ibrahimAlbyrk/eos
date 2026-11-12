//! What merging and Try share: git's plumbing, read the way today's code
//! reads it (`infra/src/git/ChildProcessBranchMerge.ts`,
//! `ChildProcessBranchIntegration.ts`).
//!
//! Here a non-zero exit is often an answer (`merge-tree` exits 1 on a
//! conflict), so commands report their exit code instead of failing.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use eos_domain::WorkerBranch;

use crate::Git;
use crate::run::Limits;
use crate::worktree::{base36, real_path_or};

/// Output kept of one command: a whole tree's binary patch fits.
const CAP: usize = 64 * 1024 * 1024;

/// How a command ended, whatever its exit code.
pub(crate) struct Called {
    /// `-1` when there was no exit status (not started, a signal, too much output).
    pub(crate) code: i32,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: String,
}

impl Called {
    pub(crate) fn ok(&self) -> bool {
        self.code == 0
    }

    pub(crate) fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    pub(crate) fn trimmed(&self) -> String {
        self.text().trim().to_owned()
    }
}

/// `git merge-tree --write-tree` against a base: the merged tree, and the
/// files that would conflict.
pub(crate) struct MergeTree {
    /// `false`: git is older than 2.38, or the command failed otherwise.
    pub(crate) supported: bool,
    pub(crate) conflicts: Vec<String>,
    pub(crate) tree: Option<String>,
}

impl MergeTree {
    /// The merged tree when the merge is clean.
    pub(crate) fn clean_tree(&self) -> Option<&str> {
        self.tree.as_deref().filter(|_| self.supported && self.conflicts.is_empty())
    }
}

/// Why a worktree is snapshotted: a merge skips an unchanged worktree, a Try
/// stands for it by its HEAD.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SnapshotFor {
    Merge,
    Try,
}

/// Without duplicates, first sight first.
pub(crate) fn unique(items: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in items {
        if !out.contains(&item) {
            out.push(item);
        }
    }
    out
}

/// The paths of `git status --porcelain` lines.
fn porcelain_paths(out: &str) -> Vec<String> {
    out.split('\n').map(|line| line.get(3..).unwrap_or_default().trim().to_owned()).filter(|p| !p.is_empty()).collect()
}

/// The folder a worker works in, when it is still there, by its real path.
pub(crate) fn live_worktree(worker: &WorkerBranch) -> Option<PathBuf> {
    worker.worktree_dir.as_deref().filter(|dir| dir.exists()).map(real_path_or)
}

impl Git {
    pub(crate) async fn call_with(&self, cwd: &Path, args: &[&str], env: &[(&str, &str)]) -> Called {
        match self.run_with(cwd, args, env, Limits { cap: CAP, timeout: None }).await {
            Ok(ran) => Called { code: 0, stdout: ran.stdout, stderr: ran.stderr },
            Err(failed) => Called {
                code: failed.code.unwrap_or(-1),
                stdout: failed.stdout.into_bytes(),
                stderr: failed.stderr.unwrap_or_default(),
            },
        }
    }

    pub(crate) async fn call(&self, cwd: &Path, args: &[&str]) -> Called {
        self.call_with(cwd, args, &[]).await
    }

    /// The tree of a worktree's files as `git add -A` sees them (committed,
    /// uncommitted and untracked), written through a throwaway index so the
    /// worktree's own index stays as it is.
    pub(crate) async fn worktree_tree(&self, worktree: &Path, kind: &str, worker_id: &str) -> Option<String> {
        static SERIAL: AtomicU64 = AtomicU64::new(0);
        let now = base36(u64::try_from(self.clock.now_ms()).unwrap_or(0));
        let serial = SERIAL.fetch_add(1, Ordering::Relaxed);
        let index = std::env::temp_dir().join(format!("{kind}-{worker_id}-{}-{now}-{serial}", std::process::id()));
        let index_text = index.to_string_lossy().into_owned();
        let env = [("GIT_INDEX_FILE", index_text.as_str())];
        let tree = async {
            for args in [&["read-tree", "HEAD"][..], &["add", "-A"]] {
                if !self.call_with(worktree, args, &env).await.ok() {
                    return None;
                }
            }
            let tree = self.call_with(worktree, &["write-tree"], &env).await;
            tree.ok().then(|| tree.trimmed())
        }
        .await;
        let _ = fs::remove_file(&index);
        tree
    }

    /// A commit of the worker's whole worktree state on top of its HEAD,
    /// without touching the worktree. A worktree that is gone is stood for by
    /// its branch's tip. `None` when it fails, and for a merge when nothing
    /// changed since HEAD.
    pub(crate) async fn snapshot(&self, worker: &WorkerBranch, root: &Path, purpose: SnapshotFor) -> Option<String> {
        let Some(worktree) = live_worktree(worker) else {
            let branch = worker.branch.as_str();
            let args: &[&str] = match purpose {
                SnapshotFor::Merge => &["rev-parse", "--verify", "--quiet", branch],
                SnapshotFor::Try => &["rev-parse", "--verify", branch],
            };
            let tip = self.call(root, args).await;
            let sha = tip.trimmed();
            return (tip.ok() && (purpose == SnapshotFor::Try || !sha.is_empty())).then_some(sha);
        };
        let kind = match purpose {
            SnapshotFor::Merge => "eos-merge",
            SnapshotFor::Try => "eos-snap",
        };
        let tree = self.worktree_tree(&worktree, kind, &worker.worker_id).await?;
        let head = self.call(&worktree, &["rev-parse", "HEAD"]).await;
        let head_tree = self.call(&worktree, &["rev-parse", "HEAD^{tree}"]).await;
        if !head.ok() || !head_tree.ok() {
            return None;
        }
        let head = head.trimmed();
        if tree == head_tree.trimmed() {
            // Nothing beyond HEAD: nothing to merge, and a Try is HEAD itself.
            return (purpose == SnapshotFor::Try).then_some(head);
        }
        let message = match purpose {
            SnapshotFor::Merge => format!("eos integrate snapshot {}", worker.worker_id),
            SnapshotFor::Try => format!("eos try snapshot {}", worker.worker_id),
        };
        let commit = self.call(&worktree, &["commit-tree", &tree, "-p", &head, "-m", &message]).await;
        commit.ok().then(|| commit.trimmed())
    }

    pub(crate) async fn merge_tree(&self, root: &Path, base: &str, snapshot: &str) -> MergeTree {
        let out = self.call(root, &["merge-tree", "--write-tree", "--name-only", base, snapshot]).await;
        if out.code != 0 && out.code != 1 {
            return MergeTree { supported: false, conflicts: Vec::new(), tree: None };
        }
        let text = out.text();
        let mut lines = text.trim().split('\n');
        let tree = lines.next().map(str::trim).filter(|t| !t.is_empty()).map(str::to_owned);
        // The conflicted paths follow the tree, up to the blank line before git's messages.
        let conflicts = if out.code == 1 {
            lines.map(str::trim).take_while(|l| !l.is_empty()).map(str::to_owned).collect()
        } else {
            Vec::new()
        };
        MergeTree { supported: true, conflicts, tree }
    }

    /// The files that differ between two trees or commits.
    pub(crate) async fn diff_names(&self, root: &Path, from: &str, to: &str) -> Vec<String> {
        let out = self.call(root, &["diff", "--name-only", from, to]).await;
        if !out.ok() {
            return Vec::new();
        }
        out.text().split('\n').map(str::trim).filter(|l| !l.is_empty()).map(str::to_owned).collect()
    }

    /// Those of `paths` the checkout has its own changes to (untracked included).
    pub(crate) async fn dirty_among(&self, root: &Path, paths: &[String]) -> Vec<String> {
        if paths.is_empty() {
            return Vec::new();
        }
        let mut args = vec!["status", "--porcelain", "--"];
        args.extend(paths.iter().map(String::as_str));
        let out = self.call(root, &args).await;
        if out.ok() { porcelain_paths(&out.text()) } else { Vec::new() }
    }

    /// The blob of a file in the working tree, as git would store it; `None`
    /// when the file is not there.
    pub(crate) async fn hash_of(&self, root: &Path, path: &str) -> Option<String> {
        if !root.join(path).exists() {
            return None;
        }
        let out = self.call(root, &["hash-object", "--", path]).await;
        out.ok().then(|| out.trimmed())
    }

    /// The blob of a file in a tree; `None` when the tree has no such file.
    pub(crate) async fn blob_in_tree(&self, root: &Path, tree: &str, path: &str) -> Option<String> {
        let out = self.call(root, &["rev-parse", "--verify", "--quiet", &format!("{tree}:{path}")]).await;
        let blob = out.trimmed();
        (out.ok() && !blob.is_empty()).then_some(blob)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcelain_lines_give_their_paths() {
        assert_eq!(porcelain_paths(" M a.txt\n?? new dir/b.txt\n\n"), vec!["a.txt", "new dir/b.txt"]);
        assert!(porcelain_paths("").is_empty());
    }

    #[test]
    fn unique_keeps_the_first_of_each() {
        let items = ["b", "a", "b", "c", "a"].map(String::from);
        assert_eq!(unique(items), vec!["b", "a", "c"]);
    }
}
