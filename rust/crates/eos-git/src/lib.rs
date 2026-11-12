//! The `git` program behind the core's git ports.
//!
//! Every command runs as `git -C <cwd> …` through `eos-kit-proc`: its own
//! process tree, a deadline, capped output, no shell. Arguments are passed as
//! a list, so a path or a branch name cannot inject anything.
//!
//! One value, [`Git`], implements every port: `GitInfo`, `GitDiffs`,
//! `WorkingTree`, `BranchAdmin`, `RemoteSync`, `BranchPush`,
//! `ConflictResolution`, `WorkingTreeRestore`, `WorktreeManager`,
//! `BranchMerge` and `CandidateFiles`. The composition root hands it out as
//! whichever trait a feature asks for. [`GitTries`] is Try
//! (`BranchIntegration`), which keeps state in a folder of its own.
//! [`GitProjectKeys`] names project folders by their
//! repository's remote (`ProjectKeys`); [`ScratchRepos`] makes the folders of
//! chats started without one (`ScratchFolders`).
//!
//! Reads collapse every failure (no repository, no `git`, a bad revision) to
//! an empty answer; writes return git's own message.

mod branch;
mod diffs;
mod files;
mod hydrate;
mod info;
mod merge;
mod plumbing;
mod project_keys;
mod records;
mod run;
mod scratch;
mod tries;
mod worktree;

use std::sync::Arc;

use eos_core::Clock;
use eos_kit_proc::Runner;

pub use files::list_candidate_files;
pub use project_keys::{GitProjectKeys, KnownFolders};
pub use scratch::ScratchRepos;
pub use tries::GitTries;

/// The git adapter. Cheap to clone.
#[derive(Clone)]
pub struct Git {
    runner: Runner,
    clock: Arc<dyn Clock>,
}

impl Git {
    /// `runner` starts the `git` found on `PATH`; `clock` stamps the tags that
    /// keep a removed worktree's commits reachable.
    pub fn new(runner: Runner, clock: Arc<dyn Clock>) -> Self {
        Self { runner, clock }
    }
}

impl std::fmt::Debug for Git {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Git").finish_non_exhaustive()
    }
}
