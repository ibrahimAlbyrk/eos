use std::path::{Path, PathBuf};

use crate::BoxFuture;

/// A worktree to make.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeCreate {
    /// The repository it forks from (resolved to its real path).
    pub repo_root: PathBuf,
    /// The new branch.
    pub branch: String,
    /// Where it goes; `None` puts it at `<repo>/.eos/worktrees/<branch>`.
    pub worktree_dir: Option<PathBuf>,
    /// Fork from a snapshot of the uncommitted work instead of HEAD.
    pub carry_uncommitted: bool,
    /// Also bring the source's `.env*` files (dependencies always come).
    pub hydrate_env: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorktreeCreated {
    Created {
        /// The real path of the new worktree.
        worktree_dir: PathBuf,
        /// The commit it forked from: the base its changes are shown against.
        fork_base_sha: Option<String>,
    },
    /// Nothing was made: not a repository, or git said no.
    Refused { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeRef {
    pub repo_root: PathBuf,
    /// `None` = `<repo>/.eos/worktrees/<branch>`.
    pub worktree_dir: Option<PathBuf>,
    pub branch: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorktreeRemoved {
    Removed,
    Refused { reason: &'static str },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeEntry {
    pub path: PathBuf,
    pub branch: Option<String>,
    pub locked: bool,
    pub is_main: bool,
}

/// An agent's own worktree.
pub trait WorktreeManager: Send + Sync {
    fn create<'a>(&'a self, input: &'a WorktreeCreate) -> BoxFuture<'a, WorktreeCreated>;
    /// Removes the worktree and its branch whatever is uncommitted in it. A
    /// worktree or branch that is already gone still counts as removed.
    /// Commits only that branch held stay reachable under an `eos/trash/…` tag.
    fn remove<'a>(&'a self, worktree: &'a WorktreeRef) -> BoxFuture<'a, WorktreeRemoved>;
    fn list_worktrees<'a>(&'a self, repo_root: &'a Path) -> BoxFuture<'a, Vec<WorktreeEntry>>;
}
