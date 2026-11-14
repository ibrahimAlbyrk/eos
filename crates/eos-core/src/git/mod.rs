//! Ports over the `git` program: repository facts, diffs, branch operations, worktrees and the watcher
//! of a repository's state.
//!
//! Reads never fail: a folder that is not a repository, a missing `git` or a
//! command that errors reads as "nothing there" (`false`, `None`, empty), so
//! a view shows a quiet empty state. Writes answer with a result the route
//! hands to the dashboard as it is.
//!
//! | Trait | What it is for |
//! |---|---|
//! | [`GitInfo`] | where a working tree stands: branches, remotes, history, stashes, conflicts |
//! | [`GitDiffs`] | what changed: file lists, patches, blobs |
//! | [`WorkingTree`] | switching branches and moving stashes |
//! | [`BranchAdmin`] | create / rename / delete a local branch |
//! | [`RemoteSync`], [`BranchPush`] | fetch, pull, push, delete a remote branch |
//! | [`ConflictResolution`], [`WorkingTreeRestore`] | staging a resolved conflict, discarding changes |
//! | [`WorktreeManager`] | an agent's own worktree: create, remove, list |
//! | [`BranchIntegration`] | Try: a worker's work shown in the user's checkout, kept or discarded |
//! | [`BranchMerge`] | an orchestrator merging its workers' work into its checkout |
//! | [`GitWatcher`] | live `git:change` events for a working tree |
//! | [`RepoState`] | the working-tree state kept between reads, told when it goes stale |
//! | [`CandidateFiles`] | the files of a project that search and the symbol index look at |
//! | [`ProjectKeys`] | a project folder ⇄ the key it travels under between computers |

mod branch;
mod diffs;
mod files;
mod info;
mod merge;
mod project_keys;
mod resolve;
mod state;
mod tries;
mod watch;
mod worktree;

pub use branch::{BranchAdmin, BranchPush, PullExec, PushExec, RemoteSync, WorkingTree};
pub use diffs::{DiffStat, GitDiffs};
pub use files::CandidateFiles;
pub use info::{ConflictEntry, GitDirs, GitInfo, SyncStatus};
pub use merge::{BranchMerge, MergeAllResult, MergeWorkerResult};
pub use project_keys::ProjectKeys;
pub use resolve::{ConflictResolution, ConflictSide, WorkingTreeRestore};
pub use state::{RepoChange, RepoState};
pub use tries::{BranchIntegration, TryApplied, TryApplyRefusal, TryDiscardRefusal, TryDiscarded, TrySync};
pub use watch::{GitChangeSink, GitWatcher};
pub use worktree::{WorktreeCreate, WorktreeCreated, WorktreeEntry, WorktreeManager, WorktreeRef, WorktreeRemoved};

use serde::Serialize;

/// How a git command that changes something ended. On failure `error` is
/// git's own message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OpResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl OpResult {
    pub fn ok() -> Self {
        Self { ok: true, error: None }
    }

    pub fn failed(error: impl Into<String>) -> Self {
        Self { ok: false, error: Some(error.into()) }
    }
}

/// A git command that failed where the caller reads the message. The text is
/// what today's code saw: `Command failed: git -C <cwd> <args…>`, then git's
/// stderr on the following lines.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct CommandFailed(pub String);
