//! Folders nobody uses any more (`core/src/use-cases/PruneOrphanWorktrees.ts`,
//! `ReapWorktreeRemovals.ts`, `PruneOrphanScratch.ts`).
//!
//! A removed worker's worktree is queued and deleted after a grace period;
//! at start-up, worktrees and scratch folders Eos made whose worker no longer
//! exists are deleted too. Each only ever touches a folder that is provably
//! Eos's and provably unused: a chat that exists in the data, archived or
//! not, keeps its worktree and its scratch folder.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use eos_core::Error;
use eos_core::agent::ScratchFolders;
use eos_core::git::{BranchIntegration, WorktreeManager, WorktreeRef, WorktreeRemoved};
use eos_core::store::Store;

/// Where Eos puts the worktrees it makes, inside a repository.
const MANAGED_SEGMENT: &str = "/.eos/worktrees/";
/// What Eos names the branches of the worktrees it makes.
const MANAGED_BRANCH_PREFIX: &str = "eos-";

/// Deletes the worktrees Eos made in the repositories its workers forked
/// from, when no worker row (archived ones included) names their branch.
///
/// A worktree is removed only when all of this holds: it is not the main
/// checkout and not locked; its branch starts with `eos-`; it sits under
/// `<repo>/.eos/worktrees/`; no worker row has that branch. A repository in
/// which some worktree worker has no branch on its row is skipped whole:
/// that worker's worktree cannot be told apart from an orphan.
pub async fn prune_orphan_worktrees(store: &dyn Store, worktrees: &dyn WorktreeManager) -> Result<Vec<PathBuf>, Error> {
    let rows = store.read(|tx| tx.workers().list_all()).await?;
    let mut repos: Vec<String> = Vec::new();
    let mut live_branches = HashSet::new();
    let mut ambiguous = HashSet::new();
    for row in &rows {
        let Some(repo) = &row.worktree_from else { continue };
        if !repos.contains(repo) {
            repos.push(repo.clone());
        }
        match &row.branch {
            Some(branch) => {
                live_branches.insert(branch.clone());
            }
            None => {
                ambiguous.insert(repo.clone());
            }
        }
    }
    let mut removed = Vec::new();
    for repo in repos {
        if ambiguous.contains(&repo) {
            tracing::warn!(repo, "worktree prune skipped: a worktree worker of this repository has no recorded branch");
            continue;
        }
        let repo_root = PathBuf::from(&repo);
        for entry in worktrees.list_worktrees(&repo_root).await {
            let Some(branch) = entry.branch.as_deref().filter(|b| b.starts_with(MANAGED_BRANCH_PREFIX)) else {
                continue;
            };
            let managed = entry.path.to_string_lossy().contains(MANAGED_SEGMENT);
            if entry.is_main || entry.locked || !managed || live_branches.contains(branch) {
                continue;
            }
            let orphan = WorktreeRef {
                repo_root: repo_root.clone(),
                worktree_dir: Some(entry.path.clone()),
                branch: branch.to_owned(),
            };
            let outcome = worktrees.remove(&orphan).await;
            tracing::info!(repo, path = %entry.path.display(), branch, ?outcome, "pruned an orphan worktree");
            if outcome == WorktreeRemoved::Removed {
                removed.push(entry.path);
            }
        }
    }
    Ok(removed)
}

/// Deletes the queued worktrees whose grace period is over. A worktree
/// another worker still works in (same repository and branch) is kept; its
/// entry leaves the queue either way. The removed worker's Try snapshot,
/// which lives outside the worktree, is settled in both cases.
pub async fn reap_worktree_removals(
    store: &dyn Store,
    worktrees: &dyn WorktreeManager,
    tries: &dyn BranchIntegration,
    now: i64,
) -> Result<usize, Error> {
    let (queue, rows) = store.read(|tx| Ok((tx.worktree_removals().list()?, tx.workers().list_all()?))).await?;
    let mut reaped = 0;
    for entry in queue.into_iter().filter(|e| e.scheduled_at <= now) {
        tries.cleanup_snapshot(Path::new(&entry.repo_root), &entry.worker_id).await;
        let shared = rows.iter().any(|w| {
            w.branch.as_deref() == Some(&entry.branch) && w.worktree_from.as_deref() == Some(&entry.repo_root)
        });
        if shared {
            tracing::info!(
                worker_id = entry.worker_id,
                branch = entry.branch,
                "worktree kept: another worker works in it"
            );
        } else {
            let gone = WorktreeRef {
                repo_root: PathBuf::from(&entry.repo_root),
                worktree_dir: entry.worktree_dir.as_ref().map(PathBuf::from),
                branch: entry.branch.clone(),
            };
            let outcome = worktrees.remove(&gone).await;
            tracing::info!(worker_id = entry.worker_id, branch = entry.branch, ?outcome, "reaped a worktree");
            reaped += 1;
        }
        let id = entry.id.clone();
        store.write(move |tx, _| tx.worktree_removals().delete(&id)).await?;
    }
    Ok(reaped)
}

/// Deletes the scratch folders no worker row works in (a removal that was cut
/// short, a spawn that failed half-way). An archived chat still owns its folder.
pub async fn prune_orphan_scratch(store: &dyn Store, scratch: &dyn ScratchFolders) -> Result<Vec<String>, Error> {
    let rows = store.read(|tx| tx.workers().list_all()).await?;
    let owned: HashSet<&str> = rows.iter().filter_map(|w| w.cwd.as_deref()).collect();
    let mut removed = Vec::new();
    for dir in scratch.list() {
        if owned.contains(dir.as_str()) {
            continue;
        }
        scratch.remove(&dir).await;
        tracing::info!(dir, "removed an orphan scratch folder");
        removed.push(dir);
    }
    Ok(removed)
}
