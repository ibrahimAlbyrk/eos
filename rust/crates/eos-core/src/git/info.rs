use std::path::{Path, PathBuf};

use eos_contracts::{CommitDetail, FsStashEntry, UnpushedCommit};
use eos_domain::git::pull_plan::PullState;
use eos_domain::git::push_plan::PushState;

use crate::BoxFuture;

/// Commits ahead of and behind the upstream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyncStatus {
    pub ahead: u32,
    pub behind: u32,
}

/// One file in conflict. `xy` is git's two-letter status (`UU`, `AA`, `DU`, …).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConflictEntry {
    pub path: String,
    pub xy: String,
}

/// The folders behind a working tree — what a watcher has to observe. In a
/// plain checkout `git_dir` and `common_dir` are the same; in a linked
/// worktree `git_dir` is the worktree's own (HEAD, index, merge state) and
/// `common_dir` the shared `.git` (refs, packed-refs, stash). All absolute.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitDirs {
    pub toplevel: PathBuf,
    pub git_dir: PathBuf,
    pub common_dir: PathBuf,
}

/// Where a working tree stands. `cwd` is any folder inside it.
pub trait GitInfo: Send + Sync {
    /// True inside a working tree, including one with no commit yet (where
    /// branch listing and HEAD both come back empty).
    fn is_repo<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, bool>;
    fn git_dirs<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Option<GitDirs>>;
    fn list_branches<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Vec<String>>;
    /// Remote-tracking branches (`origin/main`), without each remote's `HEAD` pointer.
    fn remote_branches<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Vec<String>>;
    fn remotes<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Vec<String>>;
    /// `None` on a detached HEAD. A repository with no commit yet still names its branch.
    fn current_branch<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Option<String>>;
    /// Branch names by most recent checkout, from the HEAD reflog (so switches
    /// made in a terminal or an editor count too).
    fn recent_checkouts<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Vec<String>>;
    /// `origin`'s URL as a web address: `git@host:o/r.git` → `https://host/o/r`.
    fn remote_url<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Option<String>>;
    /// `None` without an upstream.
    fn sync_status<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Option<SyncStatus>>;
    fn stash_count<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, u32>;
    /// Newest first; an entry's position is its stash index.
    fn stash_list<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Vec<FsStashEntry>>;
    fn conflict_count<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, u32>;
    fn conflict_list<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Vec<ConflictEntry>>;
    /// Commits the upstream lacks, newest first.
    fn unpushed_commits<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Vec<UnpushedCommit>>;
    /// HEAD's history, newest first. Returns up to `limit + 1` rows: the extra
    /// one only tells the caller there is more.
    fn log<'a>(&'a self, cwd: &'a Path, limit: u32, skip: u32) -> BoxFuture<'a, Vec<UnpushedCommit>>;
    /// The short sha `rev` resolves to.
    fn rev_parse<'a>(&'a self, cwd: &'a Path, rev: &'a str) -> BoxFuture<'a, Option<String>>;
    fn commit_detail<'a>(&'a self, cwd: &'a Path, sha: &'a str) -> BoxFuture<'a, Option<CommitDetail>>;
    /// The fork point of `cwd`'s HEAD and `other_root`'s HEAD (a worktree and
    /// the checkout it was made from: one object store).
    fn merge_base<'a>(&'a self, cwd: &'a Path, other_root: &'a Path) -> BoxFuture<'a, Option<String>>;
    /// `git merge-base HEAD <rev>`.
    fn merge_base_ref<'a>(&'a self, cwd: &'a Path, rev: &'a str) -> BoxFuture<'a, Option<String>>;
    /// What a branch is usually compared against: the remote's default branch,
    /// else `origin/main`, `origin/master`, `main`, `master` — the first that exists.
    fn default_base_ref<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Option<String>>;
    fn push_state<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, PushState>;
    fn pull_state<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, PullState>;
    /// The working tree has changes that are not committed (worktrees Eos
    /// keeps under `.eos/` do not count).
    fn has_uncommitted_changes<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, bool>;
}
