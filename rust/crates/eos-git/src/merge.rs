//! An orchestrator merging its workers' worktrees into its own checkout
//! (`infra/src/git/ChildProcessBranchMerge.ts`).
//!
//! 1. Each worktree's whole state becomes a snapshot commit.
//! 2. The snapshots that merge cleanly stack, one `merge-tree --write-tree`
//!    at a time; a synthetic merge commit gives the next one a sane base.
//! 3. The clean stack goes into the index and working tree; then the first
//!    snapshot that conflicts is merged with git's own low-level merge
//!    (`read-tree -m`, `checkout-index`, `merge-index git-merge-one-file`),
//!    which leaves a real unmerged index and markers. The later conflicting
//!    ones wait: git holds one conflict at a time.
//!
//! Nothing is committed and no `MERGE_HEAD` is made.

use std::path::Path;

use eos_contracts::IntegrateOutcome;
use eos_core::BoxFuture;
use eos_core::git::{BranchMerge, MergeAllResult, MergeWorkerResult};
use eos_domain::WorkerBranch;

use crate::Git;
use crate::plumbing::{SnapshotFor, unique};
use crate::worktree::real_path_or;

/// A worker's snapshot commit.
struct Snapshot<'a> {
    worker: &'a WorkerBranch,
    sha: String,
}

/// The commit and tree the next snapshot merges onto.
struct Base {
    commit: String,
    tree: String,
}

fn outcome(
    worker: &WorkerBranch,
    outcome: IntegrateOutcome,
    files: Vec<String>,
    reason: Option<&str>,
) -> MergeWorkerResult {
    MergeWorkerResult {
        worker_id: worker.worker_id.clone(),
        branch: worker.branch.clone(),
        outcome,
        files,
        reason: reason.map(str::to_owned),
    }
}

fn failed(results: Vec<MergeWorkerResult>, detail: impl Into<String>) -> MergeAllResult {
    MergeAllResult {
        ok: false,
        results,
        merged_files: Vec::new(),
        conflicted_files: Vec::new(),
        detail: Some(detail.into()),
    }
}

fn merged_all(
    results: Vec<MergeWorkerResult>,
    merged_files: Vec<String>,
    conflicted_files: Vec<String>,
) -> MergeAllResult {
    MergeAllResult { ok: true, results, merged_files, conflicted_files, detail: None }
}

impl Git {
    /// Writes `paths` from the index into the working tree. Only these paths:
    /// the checkout's other work is never touched.
    async fn checkout_paths(&self, root: &Path, paths: &[String]) {
        if paths.is_empty() {
            return;
        }
        let mut args = vec!["checkout-index", "-f", "--"];
        args.extend(paths.iter().map(String::as_str));
        self.call(root, &args).await;
    }

    async fn unmerged_paths(&self, root: &Path) -> Vec<String> {
        let out = self.call(root, &["ls-files", "-u"]).await;
        if !out.ok() {
            return Vec::new();
        }
        let text = out.text();
        unique(text.split('\n').filter_map(|line| line.split_once('\t')).map(|(_, path)| path.to_owned()))
    }

    async fn merge_workers(&self, checkout: &Path, refs: &[WorkerBranch]) -> MergeAllResult {
        let root = real_path_or(checkout);
        let mut results = Vec::new();
        let head = self.call(&root, &["rev-parse", "HEAD"]).await;
        let head_tree = self.call(&root, &["rev-parse", "HEAD^{tree}"]).await;
        if !head.ok() || !head_tree.ok() {
            return failed(results, "not a git repo / no HEAD");
        }
        let head_tree = head_tree.trimmed();

        let mut snapshots = Vec::new();
        for worker in refs {
            match self.snapshot(worker, &root, SnapshotFor::Merge).await {
                Some(sha) => snapshots.push(Snapshot { worker, sha }),
                None => results.push(outcome(
                    worker,
                    IntegrateOutcome::Skipped,
                    Vec::new(),
                    Some("no changes to integrate"),
                )),
            }
        }
        if snapshots.is_empty() {
            return merged_all(results, Vec::new(), Vec::new());
        }

        let mut base = Base { commit: head.trimmed(), tree: head_tree.clone() };
        let mut merged: Vec<(&WorkerBranch, Vec<String>)> = Vec::new();
        let mut conflicting: Vec<Snapshot<'_>> = Vec::new();
        for snapshot in snapshots {
            let merge = self.merge_tree(&root, &base.commit, &snapshot.sha).await;
            if !merge.supported {
                return failed(results, "git >= 2.38 required (merge-tree --write-tree)");
            }
            let Some(tree) = merge.clean_tree().map(str::to_owned) else {
                conflicting.push(snapshot);
                continue;
            };
            let files = self.diff_names(&root, &base.tree, &tree).await;
            let stacked = ["commit-tree", &tree, "-p", &base.commit, "-p", &snapshot.sha, "-m", "eos integrate stack"];
            let wrap = self.call(&root, &stacked).await;
            if !wrap.ok() {
                return failed(results, "stack commit-tree failed");
            }
            base = Base { commit: wrap.trimmed(), tree };
            merged.push((snapshot.worker, files));
        }

        let clean_files = self.diff_names(&root, "HEAD", &base.tree).await;
        let conflict = conflicting.first();
        let (conflict_tree, conflict_files) = match conflict {
            Some(c) => {
                let tree = self.call(&root, &["rev-parse", &format!("{}^{{tree}}", c.sha)]).await.trimmed();
                let files = self.diff_names(&root, "HEAD", &tree).await;
                (tree, files)
            }
            None => (String::new(), Vec::new()),
        };

        // The snapshots change nothing (they re-create what is there already).
        let touched = unique(clean_files.iter().chain(&conflict_files).cloned());
        if touched.is_empty() {
            for (worker, files) in merged {
                results.push(outcome(worker, IntegrateOutcome::Merged, files, None));
            }
            return merged_all(results, Vec::new(), Vec::new());
        }

        // Never over the user's own uncommitted edits.
        let dirty = self.dirty_among(&root, &touched).await;
        if !dirty.is_empty() {
            let named = dirty.iter().take(10).map(String::as_str).collect::<Vec<_>>().join(", ");
            return failed(
                results,
                format!("checkout has local changes to: {named} — commit or stash before integrating"),
            );
        }

        if !clean_files.is_empty() {
            if !self.call(&root, &["read-tree", &base.tree]).await.ok() {
                return failed(results, "read-tree (clean stack) failed");
            }
            self.checkout_paths(&root, &clean_files).await;
        }

        let mut conflicted_paths = Vec::new();
        if let Some(conflict) = conflict {
            let merge_base = self.call(&root, &["merge-base", &base.commit, &conflict.sha]).await;
            let merge_base_text = merge_base.trimmed();
            let base_tree = match merge_base_text.split('\n').next() {
                Some(first) if merge_base.ok() && !first.is_empty() => {
                    self.call(&root, &["rev-parse", &format!("{first}^{{tree}}")]).await.trimmed()
                }
                _ => head_tree.clone(),
            };
            let three_way = self.call(&root, &["read-tree", "-m", "-i", &base_tree, &base.tree, &conflict_tree]).await;
            if !three_way.ok() {
                let said = three_way.stderr.trim();
                return failed(
                    results,
                    format!("read-tree -m failed: {}", if said.is_empty() { "unknown" } else { said }),
                );
            }
            conflicted_paths = self.unmerged_paths(&root).await;
            // The merged files are written here; merge-index writes the markers of the others.
            let clean: Vec<String> = touched.iter().filter(|p| !conflicted_paths.contains(p)).cloned().collect();
            self.checkout_paths(&root, &clean).await;
            // Exits 1 on a conflict, which is what is expected here.
            self.call(&root, &["merge-index", "-o", "git-merge-one-file", "-a"]).await;
        }

        let merged_files = unique(merged.iter().flat_map(|(_, files)| files.iter().cloned()));
        for (worker, files) in merged {
            results.push(outcome(worker, IntegrateOutcome::Merged, files, None));
        }
        if let Some(conflict) = conflict {
            results.push(outcome(conflict.worker, IntegrateOutcome::Conflicted, conflicted_paths.clone(), None));
            for waiting in &conflicting[1..] {
                let reason = Some("resolve the active conflict, then re-run");
                results.push(outcome(waiting.worker, IntegrateOutcome::Pending, Vec::new(), reason));
            }
        }
        merged_all(results, merged_files, conflicted_paths)
    }
}

impl BranchMerge for Git {
    fn merge_all<'a>(&'a self, checkout: &'a Path, refs: &'a [WorkerBranch]) -> BoxFuture<'a, MergeAllResult> {
        Box::pin(self.merge_workers(checkout, refs))
    }
}
