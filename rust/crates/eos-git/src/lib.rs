//! The `git` program behind the core's git ports.
//!
//! Every command runs as `git -C <cwd> …` through `eos-kit-proc`: its own
//! process tree, a deadline, capped output, no shell. Arguments are passed as
//! a list, so a path or a branch name cannot inject anything. git is started
//! by the path of its real binary, found once (`program`), and every read
//! runs with `--no-optional-locks`.
//!
//! One value, [`Git`], implements every port: `GitInfo`, `GitDiffs`,
//! `WorkingTree`, `BranchAdmin`, `RemoteSync`, `BranchPush`,
//! `ConflictResolution`, `WorkingTreeRestore`, `WorktreeManager`,
//! `BranchMerge` and `CandidateFiles`. The composition root hands it out as
//! whichever trait a feature asks for. [`GitTries`] is Try
//! (`BranchIntegration`), which keeps state in a folder of its own.
//! [`GitProjectKeys`] names project folders by their
//! repository's remote (`ProjectKeys`); [`ScratchRepos`] makes the folders of
//! chats started without one (`ScratchFolders`); [`PluginClones`] clones a
//! plugin's repository for an install (`PluginCloner`).
//!
//! [`Snapshots`] answers the hot reads (`GitInfo`, `GitDiffs`) from what it
//! keeps per working tree, and is the `RepoState` the watcher and every
//! write tell what went stale.
//!
//! Reads collapse every failure (no repository, no `git`, a bad revision) to
//! an empty answer; writes return git's own message.

mod branch;
mod clone;
mod diffs;
mod files;
mod hydrate;
mod info;
mod merge;
mod plumbing;
mod program;
mod project_keys;
mod records;
mod run;
mod scratch;
mod snapshots;
mod tries;
mod worktree;

use std::path::Path;
use std::sync::Arc;

use eos_core::Clock;
use eos_core::git::RepoState;
use eos_kit_proc::Runner;
use program::Program;

pub use clone::PluginClones;
pub use files::list_candidate_files;
pub use project_keys::{GitProjectKeys, KnownFolders};
pub use scratch::ScratchRepos;
pub use snapshots::{Limits as SnapshotLimits, Snapshots};
pub use tries::GitTries;

/// Told the folder of each git command that may have changed something, once it ended.
pub(crate) type WriteHook = Arc<dyn Fn(&Path) + Send + Sync>;

/// The git adapter. Cheap to clone.
#[derive(Clone)]
pub struct Git {
    runner: Runner,
    clock: Arc<dyn Clock>,
    program: Arc<Program>,
    on_write: Option<WriteHook>,
}

impl Git {
    /// `runner` starts git (the real binary behind `git` on `PATH`, found on
    /// first use); `clock` stamps the tags that keep a removed worktree's
    /// commits reachable.
    pub fn new(runner: Runner, clock: Arc<dyn Clock>) -> Self {
        Self { runner, clock, program: Arc::default(), on_write: None }
    }

    /// The same adapter, telling `state` the folder of every command that may
    /// change a working tree, once it ended.
    pub fn telling(self, state: Arc<dyn RepoState>) -> Self {
        Self { on_write: Some(Arc::new(move |dir: &Path| state.touched(dir))), ..self }
    }
}

impl std::fmt::Debug for Git {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Git").field("program", &self.program).finish_non_exhaustive()
    }
}
