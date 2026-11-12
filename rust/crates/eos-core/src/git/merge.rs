use std::path::Path;

use eos_contracts::IntegrateOutcome;
use eos_domain::WorkerBranch;

use crate::BoxFuture;

/// One worker's part in a merge of several.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeWorkerResult {
    pub worker_id: String,
    pub branch: String,
    pub outcome: IntegrateOutcome,
    /// What it brought in (`Merged`) or the files now holding markers (`Conflicted`).
    pub files: Vec<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeAllResult {
    /// `false`: nothing could be merged; `detail` says why.
    pub ok: bool,
    pub results: Vec<MergeWorkerResult>,
    /// Every file the cleanly merged workers brought in.
    pub merged_files: Vec<String>,
    /// Files holding conflict markers: resolve them, then merge again.
    pub conflicted_files: Vec<String>,
    pub detail: Option<String>,
}

/// An orchestrator gathering its workers' work: several worktrees merged into
/// its own checkout in one pass (`core/src/ports/BranchMerge.ts`).
///
/// Nothing is committed and no merge state is left: the result is staged in
/// the index and working tree, and a real overlap is left as git's own
/// conflict (markers and an unmerged index) for the conflict view. Undo is a
/// plain reset.
pub trait BranchMerge: Send + Sync {
    /// Merges each worker's worktree (committed, uncommitted and untracked
    /// work) into `checkout`, in the given order. Workers that merge cleanly
    /// stack; the first that conflicts is left as a conflict and the ones
    /// after it are `Pending`, since git holds one conflict at a time.
    /// Refuses (`ok: false`) to touch a file the checkout has its own edits to.
    fn merge_all<'a>(&'a self, checkout: &'a Path, refs: &'a [WorkerBranch]) -> BoxFuture<'a, MergeAllResult>;
}
