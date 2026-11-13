use std::path::Path;

use super::GitDirs;

/// What changed under a working tree, as the watcher saw it. Finer than the
/// wire's `git:change` kinds: what each one makes stale differs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RepoChange {
    Head,
    Index,
    /// Local branches, tags, packed refs.
    Refs,
    /// Remote-tracking branches (`refs/remotes/**`).
    RemoteRefs,
    Stash,
    /// The files of the working tree.
    Worktree,
    /// A merge, rebase, cherry-pick or revert started or ended.
    Conflict,
    /// `config`, `config.worktree`, `info/*`: how git reads everything else.
    Settings,
}

/// The state of working trees Eos keeps between requests (what the git reads
/// are answered from), and what tells it that state went stale.
///
/// The watcher reports each change as soon as the system does, before it
/// gathers them into a `git:change` event, so a read that event triggers
/// never meets what was there before.
pub trait RepoState: Send + Sync {
    /// The watcher set up one watch of the working tree behind `dirs`;
    /// `whole` when its files are watched too, not only its git folders.
    fn watching(&self, dirs: &GitDirs, whole: bool);
    /// One watch set up by [`watching`](Self::watching) ended (same arguments).
    fn unwatching(&self, dirs: &GitDirs, whole: bool);
    /// Something changed under the working tree at `toplevel`.
    fn changed(&self, toplevel: &Path, change: RepoChange);
    /// The changes of one operation under `toplevel` were gathered: its
    /// `git:change` event goes out next.
    fn settled(&self, toplevel: &Path);
    /// Changes were lost (the watcher's queue overflowed): nothing kept holds.
    fn lost(&self);
    /// Eos changed something at `path` (a git command it ran, a file it
    /// wrote, an agent's tool call): every working tree holding it is stale.
    fn touched(&self, path: &Path);
}
