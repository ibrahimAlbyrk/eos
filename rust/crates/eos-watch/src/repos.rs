//! The git state of working trees.
//!
//! For each watched working tree, four places are observed:
//!
//! | Place | What a change there means |
//! |---|---|
//! | the worktree's own git folder, its direct entries | HEAD, the index, a merge or rebase in progress |
//! | `<common>/refs`, the whole subtree | branches, tags, remote refs, the stash |
//! | the shared git folder's direct entries (a linked worktree only) | packed refs |
//! | the working tree, the whole subtree minus ignored folders | uncommitted edits |
//!
//! The shared git folder is never watched as a whole: `objects/` churns on
//! every commit, fetch and gc. Linked worktrees of one repository share the
//! common folder, so its watches are shared too, and a commit in one worktree
//! tells every working tree that registered them — each under its own name.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use eos_contracts::{GitChangeEvent, GitChangeKind, Num};
use eos_core::git::{GitChangeSink, GitDirs, GitWatcher};
use eos_core::os::WatchLease;
use eos_core::{BoxFuture, Clock};
use eos_domain::fs_ignore::is_ignored;

use crate::source::{Reactor, Source};

/// One git operation touches several paths (a commit rewrites the index, a
/// ref and a reflog): they are gathered this long and sent as one event.
const WINDOW: Duration = Duration::from_millis(200);

/// Where a recursive watch costs a system watch per folder, a working tree
/// with more folders than this is not watched (its git folders still are): a
/// huge checkout would use up the process's file descriptors.
const WORKTREE_DIR_BUDGET: usize = 2000;

const ALL_KINDS: [GitChangeKind; 6] = [
    GitChangeKind::Head,
    GitChangeKind::Index,
    GitChangeKind::Refs,
    GitChangeKind::Stash,
    GitChangeKind::Worktree,
    GitChangeKind::Conflict,
];

/// What a watched place is, which decides what a change in it means.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Place {
    GitDir,
    CommonTop,
    Refs,
    Worktree,
}

fn base_name(path: &Path) -> &str {
    path.file_name().and_then(|name| name.to_str()).unwrap_or_default()
}

impl Place {
    fn recursive(self) -> bool {
        matches!(self, Place::Refs | Place::Worktree)
    }

    /// What a change of `path` under `root` means; `None` when it means
    /// nothing the dashboard shows (`COMMIT_EDITMSG`, `config`, logs, lock files).
    fn classify(self, root: &Path, path: &Path) -> Option<GitChangeKind> {
        match self {
            Place::GitDir => match base_name(path) {
                "HEAD" | "ORIG_HEAD" => Some(GitChangeKind::Head),
                "index" => Some(GitChangeKind::Index),
                "packed-refs" => Some(GitChangeKind::Refs),
                "MERGE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD" | "rebase-merge" | "rebase-apply" => {
                    Some(GitChangeKind::Conflict)
                }
                _ => None,
            },
            Place::CommonTop => (base_name(path) == "packed-refs").then_some(GitChangeKind::Refs),
            Place::Refs => {
                let is_stash = base_name(path) == "stash" && path.parent().is_some_and(|dir| base_name(dir) == "refs");
                Some(if is_stash { GitChangeKind::Stash } else { GitChangeKind::Refs })
            }
            Place::Worktree => (!ignored_below(root, path)).then_some(GitChangeKind::Worktree),
        }
    }
}

/// Version-control internals, dependency caches, build output, and a nested
/// `.eos/` (another agent's worktree must not refresh this one). Judged by the
/// segments below `root` only: an Eos worktree's own path contains `.eos`.
fn ignored_below(root: &Path, path: &Path) -> bool {
    path.strip_prefix(root).is_ok_and(|below| {
        below.components().any(|segment| {
            let segment = segment.as_os_str();
            segment == ".eos" || segment.to_str().is_some_and(is_ignored)
        })
    })
}

/// Whether the working tree has at most `budget` folders, not counting
/// ignored ones. One folder is open at a time, and the walk stops as soon as
/// the budget is passed.
fn within_dir_budget(root: &Path, budget: usize) -> bool {
    let mut count = 0;
    let mut pending = vec![root.to_owned()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.filter_map(Result::ok) {
            if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            let path = entry.path();
            if ignored_below(root, &path) {
                continue;
            }
            count += 1;
            if count > budget {
                return false;
            }
            pending.push(path);
        }
    }
    true
}

struct Repo {
    dir: PathBuf,
    refs: usize,
    /// Tells this registration from an earlier one of the same folder whose
    /// git folders are still being resolved.
    id: u64,
    targets: Vec<(PathBuf, Place)>,
}

/// One folder watched as one kind of place. A folder can be two places at
/// once: the shared git folder is a checkout's own git folder and, for its
/// linked worktrees, only the home of packed refs.
struct Target {
    /// The real path: what the system reports changes under.
    path: PathBuf,
    place: Place,
    /// The working trees told when this place changes.
    consumers: Vec<PathBuf>,
}

#[derive(Default)]
struct State {
    repos: Vec<Repo>,
    targets: Vec<Target>,
    /// What changed per working tree since the last event, in order of arrival.
    pending: Vec<(PathBuf, Vec<GitChangeKind>)>,
    closed: bool,
}

impl State {
    fn note(&mut self, dir: &Path, kind: GitChangeKind) {
        let at = match self.pending.iter().position(|(pending, _)| pending == dir) {
            Some(at) => at,
            None => {
                self.pending.push((dir.to_owned(), Vec::new()));
                self.pending.len() - 1
            }
        };
        if !self.pending[at].1.contains(&kind) {
            self.pending[at].1.push(kind);
        }
    }
}

struct Core {
    state: Mutex<State>,
    clock: Arc<dyn Clock>,
    sink: GitChangeSink,
}

impl Core {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Reactor for Core {
    fn on_path(&self, path: &Path) -> bool {
        let mut state = self.state();
        let mut fired: Vec<(PathBuf, GitChangeKind)> = Vec::new();
        for target in &state.targets {
            let inside = if target.place.recursive() {
                path.starts_with(&target.path)
            } else {
                path.parent() == Some(target.path.as_path())
            };
            if !inside {
                continue;
            }
            if let Some(kind) = target.place.classify(&target.path, path) {
                fired.extend(target.consumers.iter().map(|dir| (dir.clone(), kind)));
            }
        }
        for (dir, kind) in &fired {
            state.note(dir, *kind);
        }
        !fired.is_empty()
    }

    // Events were lost: every watched working tree is told that everything
    // may have changed, and the dashboard reads its state again.
    fn on_overflow(&self) -> bool {
        let mut state = self.state();
        let dirs: Vec<PathBuf> =
            state.repos.iter().filter(|repo| !repo.targets.is_empty()).map(|r| r.dir.clone()).collect();
        for dir in &dirs {
            for kind in ALL_KINDS {
                state.note(dir, kind);
            }
        }
        !dirs.is_empty()
    }

    fn flush(&self) {
        let batch = std::mem::take(&mut self.state().pending);
        let ts = Num::from(self.clock.now_ms());
        for (dir, kinds) in batch {
            if !kinds.is_empty() {
                (self.sink)(GitChangeEvent { dir: dir.to_string_lossy().into_owned(), kinds, ts });
            }
        }
    }
}

struct Inner {
    core: Arc<Core>,
    source: Mutex<Option<Source>>,
    native_recursive: bool,
    next_id: AtomicU64,
}

/// Finds the git folders of a working tree (`GitInfo::git_dirs`); `None`
/// when the folder is not in a repository.
pub type ResolveGitDirs = Arc<dyn Fn(PathBuf) -> BoxFuture<'static, Option<GitDirs>> + Send + Sync>;

/// The `GitWatcher` port.
pub struct RepoWatcher {
    inner: Arc<Inner>,
    resolve: ResolveGitDirs,
}

impl std::fmt::Debug for RepoWatcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RepoWatcher").field("targets", &self.targets()).finish_non_exhaustive()
    }
}

impl Inner {
    fn source(&self) -> MutexGuard<'_, Option<Source>> {
        self.source.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The places to watch for a working tree whose git folders are `dirs`.
    fn places(&self, dirs: &GitDirs) -> Vec<(PathBuf, Place)> {
        let mut places = vec![(dirs.git_dir.clone(), Place::GitDir), (dirs.common_dir.join("refs"), Place::Refs)];
        if dirs.common_dir != dirs.git_dir {
            places.push((dirs.common_dir.clone(), Place::CommonTop));
        }
        if self.native_recursive || within_dir_budget(&dirs.toplevel, WORKTREE_DIR_BUDGET) {
            places.push((dirs.toplevel.clone(), Place::Worktree));
        } else {
            tracing::warn!(
                toplevel = %dirs.toplevel.display(),
                budget = WORKTREE_DIR_BUDGET,
                "git working-tree watch skipped: too many folders; refs are still watched"
            );
        }
        places
    }

    /// Registers the watches of a working tree once its git folders are
    /// known — unless it was released, or the watcher closed, meanwhile.
    fn set_up(&self, dir: &Path, id: u64, dirs: &GitDirs) {
        let places = self.places(dirs);
        let mut source = self.source();
        let mut state = self.core.state();
        if state.closed || !state.repos.iter().any(|repo| repo.id == id) {
            return;
        }
        let mut registered = Vec::new();
        for (path, place) in places {
            let real = fs::canonicalize(&path).unwrap_or(path);
            if let Some(target) = state.targets.iter_mut().find(|t| t.path == real && t.place == place) {
                if !target.consumers.iter().any(|consumer| consumer == dir) {
                    target.consumers.push(dir.to_owned());
                }
            } else {
                if !state.targets.iter().any(|t| t.path == real) {
                    // A folder that vanished after it was resolved cannot be watched.
                    let started = source.as_mut().map(|source| source.watch(&real, place.recursive()));
                    if let Some(Err(error)) = started {
                        tracing::warn!(path = %real.display(), %error, "git watch error");
                        continue;
                    }
                }
                state.targets.push(Target { path: real.clone(), place, consumers: vec![dir.to_owned()] });
            }
            registered.push((real, place));
        }
        if let Some(repo) = state.repos.iter_mut().find(|repo| repo.id == id) {
            repo.targets = registered;
        }
    }

    fn release(&self, dir: &Path) {
        let mut source = self.source();
        let mut state = self.core.state();
        let Some(at) = state.repos.iter().position(|repo| repo.dir == dir) else { return };
        state.repos[at].refs -= 1;
        if state.repos[at].refs > 0 {
            return;
        }
        let repo = state.repos.remove(at);
        state.pending.retain(|(pending, _)| pending != dir);
        for (path, place) in repo.targets {
            let Some(at) = state.targets.iter().position(|t| t.path == path && t.place == place) else { continue };
            state.targets[at].consumers.retain(|consumer| consumer != dir);
            if state.targets[at].consumers.is_empty() {
                state.targets.remove(at);
                if !state.targets.iter().any(|t| t.path == path)
                    && let Some(source) = source.as_mut()
                {
                    source.unwatch(&path);
                }
            }
        }
    }
}

impl RepoWatcher {
    /// `resolve` finds a working tree's git folders. `native_recursive` is
    /// the platform's answer to "a recursive watch costs no file descriptor
    /// per file". `sink` receives each event on the watcher's own thread and
    /// must not block.
    ///
    /// [`watch`](GitWatcher::watch) must be called inside a tokio runtime: the
    /// lookup of the git folders runs on it.
    pub fn new(resolve: ResolveGitDirs, clock: Arc<dyn Clock>, sink: GitChangeSink, native_recursive: bool) -> Self {
        let core = Arc::new(Core { state: Mutex::new(State::default()), clock, sink });
        let source = match Source::start("eos-git-watch", core.clone(), WINDOW) {
            Ok(source) => Some(source),
            Err(error) => {
                tracing::error!(%error, "the git watcher could not start; git state will not update live");
                None
            }
        };
        let inner = Inner { core, source: Mutex::new(source), native_recursive, next_id: AtomicU64::new(1) };
        Self { inner: Arc::new(inner), resolve }
    }

    /// How many places hold a system watch.
    pub fn targets(&self) -> usize {
        self.inner.core.state().targets.len()
    }
}

impl GitWatcher for RepoWatcher {
    fn watch(&self, dir: &Path) -> WatchLease {
        let release = {
            let (inner, dir): (Weak<Inner>, PathBuf) = (Arc::downgrade(&self.inner), dir.to_owned());
            move || {
                if let Some(inner) = inner.upgrade() {
                    inner.release(&dir);
                }
            }
        };
        let id = {
            let mut state = self.inner.core.state();
            if state.closed {
                return WatchLease::new(|| {});
            }
            if let Some(repo) = state.repos.iter_mut().find(|repo| repo.dir == dir) {
                repo.refs += 1;
                return WatchLease::new(release);
            }
            let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
            state.repos.push(Repo { dir: dir.to_owned(), refs: 1, id, targets: Vec::new() });
            id
        };
        // Finding the git folders asks git, so the watches start once it answers.
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            tracing::error!(dir = %dir.display(), "a git watch was asked for outside the async runtime; not started");
            return WatchLease::new(release);
        };
        let (inner, resolving, dir) = (Arc::downgrade(&self.inner), (self.resolve)(dir.to_owned()), dir.to_owned());
        runtime.spawn(async move {
            let Some(dirs) = resolving.await else { return };
            let Some(inner) = inner.upgrade() else { return };
            // The folder count and the watch calls block.
            let _ = tokio::task::spawn_blocking(move || inner.set_up(&dir, id, &dirs)).await;
        });
        WatchLease::new(release)
    }

    fn close_all(&self) {
        let source = self.inner.source().take();
        {
            let mut state = self.inner.core.state();
            state.closed = true;
            state.repos.clear();
            state.targets.clear();
            state.pending.clear();
        }
        drop(source);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind(place: Place, root: &str, path: &str) -> Option<GitChangeKind> {
        place.classify(Path::new(root), Path::new(path))
    }

    #[test]
    fn a_git_folders_top_level_files_say_what_changed() {
        let git = "/r/.git";
        assert_eq!(kind(Place::GitDir, git, "/r/.git/HEAD"), Some(GitChangeKind::Head));
        assert_eq!(kind(Place::GitDir, git, "/r/.git/ORIG_HEAD"), Some(GitChangeKind::Head));
        assert_eq!(kind(Place::GitDir, git, "/r/.git/index"), Some(GitChangeKind::Index));
        assert_eq!(kind(Place::GitDir, git, "/r/.git/packed-refs"), Some(GitChangeKind::Refs));
        for marker in ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"] {
            assert_eq!(kind(Place::GitDir, git, &format!("/r/.git/{marker}")), Some(GitChangeKind::Conflict));
        }
        for quiet in ["COMMIT_EDITMSG", "config", "index.lock", "logs", "FETCH_HEAD"] {
            assert_eq!(kind(Place::GitDir, git, &format!("/r/.git/{quiet}")), None, "{quiet}");
        }
        assert_eq!(kind(Place::CommonTop, git, "/r/.git/packed-refs"), Some(GitChangeKind::Refs));
        assert_eq!(kind(Place::CommonTop, git, "/r/.git/HEAD"), None);
    }

    #[test]
    fn refs_are_refs_except_the_stash() {
        let refs = "/r/.git/refs";
        assert_eq!(kind(Place::Refs, refs, "/r/.git/refs/heads/main"), Some(GitChangeKind::Refs));
        assert_eq!(kind(Place::Refs, refs, "/r/.git/refs/remotes/origin/main"), Some(GitChangeKind::Refs));
        assert_eq!(kind(Place::Refs, refs, "/r/.git/refs/stash"), Some(GitChangeKind::Stash));
        assert_eq!(kind(Place::Refs, refs, "/r/.git/refs/heads/stash"), Some(GitChangeKind::Refs));
    }

    #[test]
    fn ignored_folders_below_the_working_tree_do_not_count() {
        let root = "/r/.eos/worktrees/w1";
        assert_eq!(kind(Place::Worktree, root, "/r/.eos/worktrees/w1/src/a.rs"), Some(GitChangeKind::Worktree));
        assert_eq!(kind(Place::Worktree, root, root), Some(GitChangeKind::Worktree));
        for noise in [".git/index", "node_modules/p/i.js", "a/dist/x.js", ".eos/worktrees/w2/a.rs", "x/.DS_Store"] {
            assert_eq!(kind(Place::Worktree, root, &format!("{root}/{noise}")), None, "{noise}");
        }
    }

    #[test]
    fn the_folder_budget_counts_only_what_would_be_watched() {
        let dir = tempfile::tempdir().expect("dir");
        for folder in ["a/b", "c", "node_modules/x/y/z", ".git/objects/aa"] {
            fs::create_dir_all(dir.path().join(folder)).expect("dirs");
        }
        assert!(within_dir_budget(dir.path(), 3));
        assert!(!within_dir_budget(dir.path(), 2));
    }
}
