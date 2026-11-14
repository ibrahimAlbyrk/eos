use std::path::Path;

use eos_contracts::{ActiveTry, TryPreviewResponse};
use eos_domain::WorkerBranch;

use crate::BoxFuture;

/// Why a Try could not be applied. The text is today's `reason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TryApplyRefusal {
    /// Conflicts with the checkout's HEAD: a job for the git agent.
    Conflicts,
    /// Clean against HEAD, conflicts with a Try applied before (`detail` names its workers).
    ConflictsWithTry,
    /// Updating this Try would break one applied after it (`detail` names that worker).
    BlockedByOverlay,
    /// The checkout's own edits are in the way.
    DirtyFiles,
    NothingToApply,
    /// git older than 2.38 (no `merge-tree --write-tree`).
    Unsupported,
    GitError,
}

impl TryApplyRefusal {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Conflicts => "conflicts",
            Self::ConflictsWithTry => "conflicts-with-try",
            Self::BlockedByOverlay => "blocked-by-overlay",
            Self::DirtyFiles => "dirty-files",
            Self::NothingToApply => "nothing-to-apply",
            Self::Unsupported => "unsupported",
            Self::GitError => "git-error",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TryApplied {
    /// `files` are the ones this call changed: all of the worker's on a first
    /// apply, only what is new since on a later one.
    Applied {
        files: Vec<String>,
        lockfile_changed: bool,
    },
    Refused {
        reason: TryApplyRefusal,
        files: Option<Vec<String>>,
        detail: Option<String>,
    },
}

/// Why a Try could not be discarded. The text is today's `reason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TryDiscardRefusal {
    NoActiveTry,
    /// The user edited a file the Try touched; nothing was reverted.
    UserEdited,
    /// A Try applied after it touches the same files (`detail` names that worker).
    BlockedByOverlay,
    GitError,
}

impl TryDiscardRefusal {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NoActiveTry => "no-active-try",
            Self::UserEdited => "user-edited",
            Self::BlockedByOverlay => "blocked-by-overlay",
            Self::GitError => "git-error",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TryDiscarded {
    Discarded,
    Refused { reason: TryDiscardRefusal, files: Option<Vec<String>>, detail: Option<String> },
}

/// Whether a worktree moved on past what its Try holds, and what a new apply would change.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TrySync {
    pub syncable: bool,
    pub files: Vec<String>,
}

/// Try: a worker's work shown in the user's checkout as unstaged edits, kept or
/// discarded later.
///
/// No index write, no merge state. Tries stack: several workers' Tries can be
/// in one checkout at once, each merged over the ones before it. Keeping
/// never touches the tree, so any Try can be kept in any order; discarding
/// reverses a patch, so a Try can only go while none after it touches the
/// same files. A Try's state lives outside the worktree, so it outlives the
/// app and the worker.
pub trait BranchIntegration: Send + Sync {
    /// What applying would do, without doing it.
    fn preview<'a>(&'a self, worker: &'a WorkerBranch) -> BoxFuture<'a, TryPreviewResponse>;
    /// Brings the checkout in step with the worktree: the whole merged result
    /// the first time, only what the worker changed since on later calls,
    /// whether the Try is still open or kept.
    fn apply<'a>(&'a self, worker: &'a WorkerBranch) -> BoxFuture<'a, TryApplied>;
    /// Reverses all of the worker's Try. Refused, with nothing reverted,
    /// while the user edited a touched file or a later Try overlaps.
    fn discard<'a>(&'a self, repo_root: &'a Path, worker_id: &'a str) -> BoxFuture<'a, TryDiscarded>;
    /// Accepts the worker's Try: it leaves the Keep/Discard deck but stays in
    /// the stack, so its edits count as expected and it can still be synced.
    /// `false` when there is no such Try.
    fn keep<'a>(&'a self, repo_root: &'a Path, worker_id: &'a str) -> BoxFuture<'a, bool>;
    /// The open Tries (the deck), oldest first.
    fn active_tries<'a>(&'a self, repo_root: &'a Path) -> BoxFuture<'a, Vec<ActiveTry>>;
    /// The worker's Try is kept.
    fn was_kept<'a>(&'a self, repo_root: &'a Path, worker_id: &'a str) -> BoxFuture<'a, bool>;
    /// Whether the worktree moved on since its Try was applied. Nothing to
    /// sync when the worker has no Try yet. Changes nothing.
    fn sync_status<'a>(&'a self, worker: &'a WorkerBranch) -> BoxFuture<'a, TrySync>;
    /// After the worker is gone: an open Try stays (it can still be
    /// discarded), a kept one is settled (its edits stay as the user's own),
    /// and the snapshot ref goes otherwise.
    fn cleanup_snapshot<'a>(&'a self, repo_root: &'a Path, worker_id: &'a str) -> BoxFuture<'a, ()>;
}
