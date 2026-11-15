//! The git state of working trees.
//!
//! For each watched working tree, five places are observed:
//!
//! | Place | What a change there means |
//! |---|---|
//! | the worktree's own git folder, its direct entries | HEAD, the index, a merge or rebase in progress, its settings |
//! | `<common>/refs`, the whole subtree | branches, tags, remote refs, the stash |
//! | the shared git folder's direct entries (a linked worktree only) | packed refs, the shared settings |
//! | `<common>/info`, its direct entries | the repository's own ignore and attribute rules |
//! | the working tree, the whole subtree minus ignored folders | uncommitted edits |
//!
//! The shared git folder is never watched as a whole: `objects/` churns on
//! every commit, fetch and gc. Linked worktrees of one repository share the
//! common folder, so its watches are shared too, and a commit in one worktree
//! tells every working tree that registered them — each under its own name.
//!
//! Given a way to ask git ([`RepoWatcher::ignoring`]), the folders a working
//! tree's own rules ignore whole (build output, caches) are dropped in the
//! system's callback, before they take a place in the queue. Never one that
//! holds a tracked file or a watched place, or that another watched tree does
//! not ignore; asked again whenever the rules or the index may have changed,
//! and a folder that stops being ignored is reported as a change.
//!
//! When given a [`RepoState`], the watcher tells it of each change as soon as
//! the system reports it (before gathering, so a read the `git:change` event
//! triggers never meets what was there before), that the changes of an
//! operation were gathered (just before the event goes out), and which trees
//! it watches. Settings and rule files tell only the state: the dashboard has
//! nothing to show for them.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError, RwLock, Weak};
use std::time::Duration;

use eos_contracts::{GitChangeEvent, GitChangeKind, Num};
use eos_core::git::{GitChangeSink, GitDirs, GitWatcher, RepoChange, RepoState};
use eos_core::os::WatchLease;
use eos_core::{BoxFuture, Clock};
use eos_domain::fs_ignore::is_ignored;

use crate::source::{Reactor, Skip, Source};

/// One git operation touches several paths (a commit rewrites the index, a
/// ref and a reflog): they are gathered this long and sent as one event.
const WINDOW: Duration = Duration::from_millis(200);

/// Where a recursive watch costs a system watch per folder, a working tree
/// with more folders than this is not watched (its git folders still are): a
/// huge checkout would use up the process's file descriptors.
const WORKTREE_DIR_BUDGET: usize = 2000;

/// Ignored folders kept per working tree; past it the rest stay watched.
const MAX_IGNORED: usize = 1024;

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
    Info,
    Worktree,
}

/// What a change means: to the kept state, and on the wire (`None`: the
/// dashboard has nothing to show for it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Change {
    state: RepoChange,
    wire: Option<GitChangeKind>,
}

const fn both(state: RepoChange, wire: GitChangeKind) -> Option<Change> {
    Some(Change { state, wire: Some(wire) })
}

const SETTINGS: Option<Change> = Some(Change { state: RepoChange::Settings, wire: None });

fn base_name(path: &Path) -> &str {
    path.file_name().and_then(|name| name.to_str()).unwrap_or_default()
}

impl Place {
    fn recursive(self) -> bool {
        matches!(self, Place::Refs | Place::Worktree)
    }

    /// Whether a change of `path` under `root` may change which folders git
    /// ignores: the rules, the settings that name them, or the index (a file
    /// added inside an ignored folder).
    fn touches_rules(self, root: &Path, path: &Path) -> bool {
        match self {
            Place::GitDir => matches!(base_name(path), "index" | "config" | "config.worktree" | "info"),
            Place::CommonTop => matches!(base_name(path), "config" | "info"),
            Place::Info => base_name(path) == "exclude",
            Place::Worktree => base_name(path) == ".gitignore" && !ignored_below(root, path),
            Place::Refs => false,
        }
    }

    /// What a change of `path` under `root` means; `None` when it means
    /// nothing (`COMMIT_EDITMSG`, logs, lock files).
    fn classify(self, root: &Path, path: &Path) -> Option<Change> {
        match self {
            Place::GitDir => match base_name(path) {
                "HEAD" | "ORIG_HEAD" => both(RepoChange::Head, GitChangeKind::Head),
                "index" => both(RepoChange::Index, GitChangeKind::Index),
                "packed-refs" => both(RepoChange::Refs, GitChangeKind::Refs),
                "MERGE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD" | "rebase-merge" | "rebase-apply" => {
                    both(RepoChange::Conflict, GitChangeKind::Conflict)
                }
                // `git branch -u` and `git remote set-url` change only these.
                "config" | "config.worktree" => SETTINGS,
                _ => None,
            },
            Place::CommonTop => match base_name(path) {
                "packed-refs" => both(RepoChange::Refs, GitChangeKind::Refs),
                "config" => SETTINGS,
                _ => None,
            },
            Place::Refs => {
                let below = path.strip_prefix(root).ok();
                let first = below.and_then(|below| below.components().next()).map(|c| c.as_os_str());
                let is_stash = base_name(path) == "stash" && path.parent().is_some_and(|dir| base_name(dir) == "refs");
                if is_stash {
                    both(RepoChange::Stash, GitChangeKind::Stash)
                } else if first.is_some_and(|first| first == "remotes") {
                    both(RepoChange::RemoteRefs, GitChangeKind::Refs)
                } else {
                    both(RepoChange::Refs, GitChangeKind::Refs)
                }
            }
            Place::Info => {
                matches!(base_name(path), "exclude" | "attributes" | "sparse-checkout").then_some(SETTINGS).flatten()
            }
            Place::Worktree => {
                (!ignored_below(root, path)).then(|| both(RepoChange::Worktree, GitChangeKind::Worktree)).flatten()
            }
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
    /// Once its watches are set up: its git folders, and whether its files
    /// are watched too.
    watched: Option<(GitDirs, bool)>,
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
    /// Per watched working tree (its real top folder): the real paths of the
    /// folders its own rules ignore whole, as git last said.
    ignored: Vec<(PathBuf, Vec<PathBuf>)>,
    /// Working trees git is being asked about, and whether to ask once more.
    checking: Vec<(PathBuf, bool)>,
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

    /// The real top folders of the working trees whose files `consumers` watch.
    fn worktrees_of(&self, consumers: &[PathBuf]) -> Vec<PathBuf> {
        let repos = self.repos.iter().filter(|repo| consumers.contains(&repo.dir));
        let tops = repos.flat_map(|repo| repo.targets.iter().filter(|(_, place)| *place == Place::Worktree));
        let mut out: Vec<PathBuf> = Vec::new();
        for (top, _) in tops {
            if !out.contains(top) {
                out.push(top.clone());
            }
        }
        out
    }

    fn watches_files_of(&self, top: &Path) -> bool {
        self.targets.iter().any(|t| t.place == Place::Worktree && t.path == top)
    }

    /// The git folders of a working tree whose files are watched at `top`.
    fn dirs_at(&self, top: &Path) -> Option<GitDirs> {
        self.repos.iter().find_map(|repo| {
            let (dirs, _) = repo.watched.as_ref()?;
            repo.targets.iter().any(|(path, place)| *place == Place::Worktree && path == top).then(|| dirs.clone())
        })
    }

    /// The ignored folders whose changes no watched place has a use for: no
    /// place lies inside one, and every other watched tree it lies in
    /// ignores it too.
    fn skippable(&self) -> HashSet<PathBuf> {
        let ignores = |top: &Path, folder: &Path| {
            ignored_below(top, folder)
                || self.ignored.iter().any(|(t, folders)| t == top && folders.iter().any(|f| folder.starts_with(f)))
        };
        let mut out = HashSet::new();
        for (top, folders) in self.ignored.iter().filter(|(top, _)| self.watches_files_of(top)) {
            for folder in folders {
                let holds_a_place = self.targets.iter().any(|t| t.path.starts_with(folder));
                let others_ignore = self
                    .targets
                    .iter()
                    .filter(|t| t.place.recursive() && folder.starts_with(&t.path))
                    .filter(|t| !(t.place == Place::Worktree && t.path == *top))
                    .all(|t| t.place == Place::Worktree && ignores(&t.path, folder));
                if !holds_a_place && others_ignore {
                    out.insert(folder.clone());
                }
            }
        }
        out
    }

    /// The top folder of the working tree watched as `dir`.
    fn toplevel(&self, dir: &Path) -> Option<&Path> {
        self.repos
            .iter()
            .find(|repo| repo.dir == dir)
            .and_then(|repo| repo.watched.as_ref())
            .map(|(dirs, _)| dirs.toplevel.as_path())
    }
}

struct Core {
    state: Mutex<State>,
    clock: Arc<dyn Clock>,
    sink: GitChangeSink,
    repo_state: Option<Arc<dyn RepoState>>,
    /// The folders dropped in the system's callback ([`State::skippable`]).
    skip: Arc<RwLock<HashSet<PathBuf>>>,
    /// Asks git again which folders these working trees ignore.
    rules_changed: OnceLock<Box<dyn Fn(Vec<PathBuf>) + Send + Sync>>,
}

impl Core {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Recomputes the dropped folders; returns the ones no longer dropped.
    fn refresh_skip(&self, state: &State) -> Vec<PathBuf> {
        let next = state.skippable();
        let mut skip = self.skip.write().unwrap_or_else(PoisonError::into_inner);
        let freed = skip.iter().filter(|folder| !next.contains(*folder)).cloned().collect();
        *skip = next;
        freed
    }

    fn ask_again(&self, tops: Vec<PathBuf>) {
        if let (false, Some(ask)) = (tops.is_empty(), self.rules_changed.get()) {
            ask(tops);
        }
    }
}

fn skip_of(skip: Arc<RwLock<HashSet<PathBuf>>>) -> Skip {
    Arc::new(move |path: &Path| {
        let skip = skip.read().unwrap_or_else(PoisonError::into_inner);
        !skip.is_empty() && path.ancestors().any(|above| skip.contains(above))
    })
}

impl Reactor for Core {
    fn on_path(&self, path: &Path) -> bool {
        let mut state = self.state();
        let mut fired: Vec<(PathBuf, Change)> = Vec::new();
        let mut rules: Vec<PathBuf> = Vec::new();
        for target in &state.targets {
            let inside = if target.place.recursive() {
                path.starts_with(&target.path)
            } else {
                path.parent() == Some(target.path.as_path())
            };
            if !inside {
                continue;
            }
            if let Some(change) = target.place.classify(&target.path, path) {
                fired.extend(target.consumers.iter().map(|dir| (dir.clone(), change)));
            }
            if target.place.touches_rules(&target.path, path) {
                rules.extend(state.worktrees_of(&target.consumers));
            }
        }
        // The repository's own rules file, reported through a watch that holds it (the
        // working tree around a checkout's git folder) though no rules folder is a place:
        // one made after the watch was set up.
        for target in state.targets.iter().filter(|t| matches!(t.place, Place::GitDir | Place::CommonTop)) {
            if path.parent().is_some_and(|info| info == target.path.join("info")) && base_name(path) == "exclude" {
                rules.extend(state.worktrees_of(&target.consumers));
            }
        }
        if let Some(repo_state) = &self.repo_state {
            let mut told: Vec<(&Path, RepoChange)> = Vec::new();
            for (dir, change) in &fired {
                if let Some(top) = state.toplevel(dir)
                    && !told.contains(&(top, change.state))
                {
                    repo_state.changed(top, change.state);
                    told.push((top, change.state));
                }
            }
        }
        let mut waiting = false;
        for (dir, change) in &fired {
            if let Some(kind) = change.wire {
                state.note(dir, kind);
                waiting = true;
            }
        }
        drop(state);
        rules.sort_unstable();
        rules.dedup();
        self.ask_again(rules);
        waiting
    }

    // Events were lost: every watched working tree is told that everything
    // may have changed, and the dashboard reads its state again.
    fn on_overflow(&self) -> bool {
        if let Some(repo_state) = &self.repo_state {
            repo_state.lost();
        }
        let mut state = self.state();
        let dirs: Vec<PathBuf> =
            state.repos.iter().filter(|repo| !repo.targets.is_empty()).map(|r| r.dir.clone()).collect();
        for dir in &dirs {
            for kind in ALL_KINDS {
                state.note(dir, kind);
            }
        }
        // A lost rule change: every tree's ignored folders are asked for again.
        let tops = state.worktrees_of(&dirs);
        drop(state);
        self.ask_again(tops);
        !dirs.is_empty()
    }

    fn flush(&self) {
        let (batch, tops) = {
            let mut state = self.state();
            let batch = std::mem::take(&mut state.pending);
            let mut tops: Vec<PathBuf> =
                batch.iter().filter_map(|(dir, _)| state.toplevel(dir)).map(Path::to_owned).collect();
            tops.dedup();
            (batch, tops)
        };
        // Recomputed before the dashboard hears of it, so its reads join the refresh.
        if let Some(repo_state) = &self.repo_state {
            for top in &tops {
                repo_state.settled(top);
            }
        }
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
    list_ignored: OnceLock<ListIgnored>,
    /// Where git is asked; the runtime of the first watch.
    runtime: OnceLock<tokio::runtime::Handle>,
}

/// Finds the git folders of a working tree (`GitInfo::git_dirs`); `None`
/// when the folder is not in a repository.
pub type ResolveGitDirs = Arc<dyn Fn(PathBuf) -> BoxFuture<'static, Option<GitDirs>> + Send + Sync>;

/// The folders a working tree's own rules ignore by name, so that whatever is
/// made in one later is ignored too, relative to its top folder (none holds a
/// tracked file); `None` when git cannot tell.
pub type ListIgnored = Arc<dyn Fn(GitDirs) -> BoxFuture<'static, Option<Vec<PathBuf>>> + Send + Sync>;

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
        // Not every repository has one; a missing one is no failure.
        let info = dirs.common_dir.join("info");
        if info.is_dir() {
            places.push((info, Place::Info));
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
        let planned = places.len();
        // Joined: the place is watched already; `None`: a new place on a folder
        // watched already; `Some(i)`: a new place that needs `adds[i]`.
        let mut plan: Vec<(PathBuf, Place, Option<Option<usize>>)> = Vec::new();
        let mut adds: Vec<(PathBuf, bool)> = Vec::new();
        for (path, place) in places {
            let real = fs::canonicalize(&path).unwrap_or(path);
            if let Some(target) = state.targets.iter_mut().find(|t| t.path == real && t.place == place) {
                if !target.consumers.iter().any(|consumer| consumer == dir) {
                    target.consumers.push(dir.to_owned());
                }
                plan.push((real, place, None));
            } else if state.targets.iter().any(|t| t.path == real) {
                plan.push((real, place, Some(None)));
            } else {
                let at = adds.iter().position(|(added, _)| *added == real).unwrap_or_else(|| {
                    adds.push((real.clone(), place.recursive()));
                    adds.len() - 1
                });
                plan.push((real, place, Some(Some(at))));
            }
        }
        // One restart of the system's stream for every new folder.
        let started = match source.as_mut() {
            Some(source) => source.change(&adds, &[]),
            None => adds.iter().map(|_| Ok(())).collect(),
        };
        let mut registered = Vec::new();
        for (real, place, step) in plan {
            if let Some(add) = step {
                // A folder that vanished after it was resolved cannot be watched.
                if let Some(Err(error)) = add.and_then(|at| started.get(at)) {
                    tracing::warn!(path = %real.display(), %error, "git watch error");
                    continue;
                }
                state.targets.push(Target { path: real.clone(), place, consumers: vec![dir.to_owned()] });
            }
            registered.push((real, place));
        }
        // Every change is seen only when every place is watched, the files included.
        let whole = source.is_some()
            && registered.len() == planned
            && registered.iter().any(|(_, place)| *place == Place::Worktree);
        let files = registered.iter().find(|(_, place)| *place == Place::Worktree).map(|(top, _)| top.clone());
        if let Some(repo) = state.repos.iter_mut().find(|repo| repo.id == id) {
            repo.targets = registered;
            repo.watched = Some((dirs.clone(), whole));
        }
        // A new place may lie in a folder dropped so far: it is watched from now on.
        self.core.refresh_skip(&state);
        if let Some(repo_state) = &self.core.repo_state {
            repo_state.watching(dirs, whole);
        }
        drop(state);
        drop(source);
        self.core.ask_again(files.into_iter().collect());
    }

    /// Asks git which folders the working tree at `top` ignores, one ask at a
    /// time per tree: one asked for meanwhile runs once more after it.
    fn ask_ignored(self: &Arc<Self>, tops: Vec<PathBuf>) {
        let (Some(list), Some(runtime)) = (self.list_ignored.get(), self.runtime.get()) else { return };
        for top in tops {
            {
                let mut state = self.core.state();
                if state.closed || !state.watches_files_of(&top) {
                    continue;
                }
                if let Some((_, again)) = state.checking.iter_mut().find(|(checking, _)| *checking == top) {
                    *again = true;
                    continue;
                }
                state.checking.push((top.clone(), false));
            }
            let (inner, list) = (Arc::downgrade(self), list.clone());
            // Each step off the async threads: the watcher's locks are held across the system's watch calls.
            runtime.spawn(async move {
                loop {
                    let (weak, at) = (inner.clone(), top.clone());
                    let prepared = tokio::task::spawn_blocking(move || weak.upgrade().map(|inner| inner.prepare(&at)));
                    let Ok(Some(dirs)) = prepared.await else { return };
                    let found = match dirs {
                        Some(dirs) => list(dirs).await,
                        None => None,
                    };
                    let (weak, at) = (inner.clone(), top.clone());
                    let kept = tokio::task::spawn_blocking(move || {
                        weak.upgrade().is_some_and(|inner| inner.keep_ignored(&at, found))
                    });
                    if !kept.await.unwrap_or(false) {
                        return;
                    }
                }
            });
        }
    }

    /// Before git is asked about the working tree at `top`: watches the rules
    /// folder of its repository if it appeared since and no watch holds it yet
    /// (so a rule written there from now on is seen, and one written before is
    /// what git reads), and returns its git folders.
    fn prepare(&self, top: &Path) -> Option<GitDirs> {
        let mut source = self.source();
        let mut state = self.core.state();
        let dirs = state.dirs_at(top)?;
        let info = dirs.common_dir.join("info");
        let consumers: Vec<PathBuf> = state
            .repos
            .iter()
            .filter(|repo| repo.watched.as_ref().is_some_and(|(watched, _)| watched.common_dir == dirs.common_dir))
            .filter(|repo| !repo.targets.iter().any(|(_, place)| *place == Place::Info))
            .map(|repo| repo.dir.clone())
            .collect();
        if state.closed || consumers.is_empty() || !info.is_dir() {
            return Some(dirs);
        }
        let real = fs::canonicalize(&info).unwrap_or(info);
        // Inside a watched working tree (a checkout's own git folder) its changes are
        // reported already: no restart of the system's stream for it.
        if state.targets.iter().any(|t| t.place.recursive() && real.starts_with(&t.path)) {
            return Some(dirs);
        }
        if !state.targets.iter().any(|t| t.path == real) {
            let added = match source.as_mut() {
                Some(source) => source.change(&[(real.clone(), false)], &[]).pop().unwrap_or(Ok(())),
                None => Ok(()),
            };
            if let Err(error) = added {
                tracing::warn!(path = %real.display(), %error, "git watch error");
                return Some(dirs);
            }
        }
        match state.targets.iter_mut().find(|t| t.path == real && t.place == Place::Info) {
            Some(target) => {
                for dir in &consumers {
                    if !target.consumers.contains(dir) {
                        target.consumers.push(dir.clone());
                    }
                }
            }
            None => state.targets.push(Target { path: real.clone(), place: Place::Info, consumers: consumers.clone() }),
        }
        for repo in state.repos.iter_mut().filter(|repo| consumers.contains(&repo.dir)) {
            repo.targets.push((real.clone(), Place::Info));
        }
        self.core.refresh_skip(&state);
        Some(dirs)
    }

    /// Keeps what git said of `top` (`None`: nothing is dropped there), and
    /// reports each folder no longer dropped as changed. Returns whether to ask
    /// once more.
    fn keep_ignored(&self, top: &Path, found: Option<Vec<PathBuf>>) -> bool {
        let source = self.source();
        let mut state = self.core.state();
        let Some(at) = state.checking.iter().position(|(checking, _)| checking == top) else { return false };
        let watched = !state.closed && state.watches_files_of(top);
        let again = watched && state.checking[at].1;
        if again {
            state.checking[at].1 = false;
        } else {
            state.checking.remove(at);
        }
        state.ignored.retain(|(t, _)| t != top);
        let folders: Vec<PathBuf> = found
            .unwrap_or_default()
            .into_iter()
            .map(|folder| top.join(folder))
            .filter(|folder| folder.starts_with(top) && folder != top)
            .take(MAX_IGNORED)
            .collect();
        if watched && !folders.is_empty() {
            state.ignored.push((top.to_owned(), folders));
        }
        let freed = self.core.refresh_skip(&state);
        drop(state);
        // What changed there while it was dropped is seen now.
        if let Some(source) = source.as_ref() {
            for folder in freed {
                source.poke(folder);
            }
        }
        again
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
        let mut removes = Vec::new();
        for (path, place) in repo.targets {
            let Some(at) = state.targets.iter().position(|t| t.path == path && t.place == place) else { continue };
            state.targets[at].consumers.retain(|consumer| consumer != dir);
            if state.targets[at].consumers.is_empty() {
                state.targets.remove(at);
                if !state.targets.iter().any(|t| t.path == path) && !removes.contains(&path) {
                    removes.push(path);
                }
            }
        }
        // One restart of the system's stream for every folder given back.
        if let Some(source) = source.as_mut() {
            source.change(&[], &removes);
        }
        let gone: Vec<PathBuf> =
            state.ignored.iter().map(|(top, _)| top.clone()).filter(|top| !state.watches_files_of(top)).collect();
        state.ignored.retain(|(top, _)| !gone.contains(top));
        self.core.refresh_skip(&state);
        if let (Some(repo_state), Some((dirs, whole))) = (&self.core.repo_state, &repo.watched) {
            repo_state.unwatching(dirs, *whole);
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
        Self::build(resolve, clock, sink, native_recursive, None)
    }

    /// The same watcher, telling `repo_state` what it sees (on its own
    /// thread; the calls must not block).
    pub fn telling(
        resolve: ResolveGitDirs,
        clock: Arc<dyn Clock>,
        sink: GitChangeSink,
        native_recursive: bool,
        repo_state: Arc<dyn RepoState>,
    ) -> Self {
        Self::build(resolve, clock, sink, native_recursive, Some(repo_state))
    }

    fn build(
        resolve: ResolveGitDirs,
        clock: Arc<dyn Clock>,
        sink: GitChangeSink,
        native_recursive: bool,
        repo_state: Option<Arc<dyn RepoState>>,
    ) -> Self {
        let skip = Arc::new(RwLock::new(HashSet::new()));
        let core = Arc::new(Core {
            state: Mutex::new(State::default()),
            clock,
            sink,
            repo_state,
            skip: skip.clone(),
            rules_changed: OnceLock::new(),
        });
        let source = match Source::start("eos-git-watch", core.clone(), WINDOW, Some(skip_of(skip))) {
            Ok(source) => Some(source),
            Err(error) => {
                tracing::error!(%error, "the git watcher could not start; git state will not update live");
                None
            }
        };
        let inner = Arc::new(Inner {
            core,
            source: Mutex::new(source),
            native_recursive,
            next_id: AtomicU64::new(1),
            list_ignored: OnceLock::new(),
            runtime: OnceLock::new(),
        });
        let weak = Arc::downgrade(&inner);
        let _ = inner.core.rules_changed.set(Box::new(move |tops| {
            if let Some(inner) = weak.upgrade() {
                inner.ask_ignored(tops);
            }
        }));
        Self { inner, resolve }
    }

    /// The same watcher, dropping the folders `list` says a working tree's
    /// rules ignore.
    pub fn ignoring(self, list: ListIgnored) -> Self {
        let _ = self.inner.list_ignored.set(list);
        self
    }

    /// Whether what changes at `path` (a real path) is dropped in the system's callback.
    pub fn skips(&self, path: &Path) -> bool {
        skip_of(self.inner.core.skip.clone())(path)
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
            state.repos.push(Repo { dir: dir.to_owned(), refs: 1, id, targets: Vec::new(), watched: None });
            id
        };
        // Finding the git folders asks git, so the watches start once it answers.
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            tracing::error!(dir = %dir.display(), "a git watch was asked for outside the async runtime; not started");
            return WatchLease::new(release);
        };
        let _ = self.inner.runtime.set(runtime.clone());
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
        let watched: Vec<(GitDirs, bool)> = {
            let mut state = self.inner.core.state();
            state.closed = true;
            let watched = state.repos.drain(..).filter_map(|repo| repo.watched).collect();
            state.targets.clear();
            state.pending.clear();
            state.ignored.clear();
            state.checking.clear();
            self.inner.core.refresh_skip(&state);
            watched
        };
        if let Some(repo_state) = &self.inner.core.repo_state {
            for (dirs, whole) in &watched {
                repo_state.unwatching(dirs, *whole);
            }
        }
        drop(source);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wire(place: Place, root: &str, path: &str) -> Option<GitChangeKind> {
        place.classify(Path::new(root), Path::new(path)).and_then(|change| change.wire)
    }

    fn state(place: Place, root: &str, path: &str) -> Option<RepoChange> {
        place.classify(Path::new(root), Path::new(path)).map(|change| change.state)
    }

    #[test]
    fn a_git_folders_top_level_files_say_what_changed() {
        let git = "/r/.git";
        assert_eq!(wire(Place::GitDir, git, "/r/.git/HEAD"), Some(GitChangeKind::Head));
        assert_eq!(wire(Place::GitDir, git, "/r/.git/ORIG_HEAD"), Some(GitChangeKind::Head));
        assert_eq!(wire(Place::GitDir, git, "/r/.git/index"), Some(GitChangeKind::Index));
        assert_eq!(wire(Place::GitDir, git, "/r/.git/packed-refs"), Some(GitChangeKind::Refs));
        for marker in ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"] {
            assert_eq!(wire(Place::GitDir, git, &format!("/r/.git/{marker}")), Some(GitChangeKind::Conflict));
        }
        for quiet in ["COMMIT_EDITMSG", "config", "index.lock", "logs", "FETCH_HEAD"] {
            assert_eq!(wire(Place::GitDir, git, &format!("/r/.git/{quiet}")), None, "{quiet}");
        }
        assert_eq!(wire(Place::CommonTop, git, "/r/.git/packed-refs"), Some(GitChangeKind::Refs));
        assert_eq!(wire(Place::CommonTop, git, "/r/.git/HEAD"), None);
    }

    #[test]
    fn settings_and_rules_tell_the_state_only() {
        let git = "/r/.git";
        for settings in ["/r/.git/config", "/r/.git/config.worktree"] {
            assert_eq!(state(Place::GitDir, git, settings), Some(RepoChange::Settings), "{settings}");
            assert_eq!(wire(Place::GitDir, git, settings), None, "{settings}");
        }
        assert_eq!(state(Place::CommonTop, git, "/r/.git/config"), Some(RepoChange::Settings));
        assert_eq!(state(Place::Info, "/r/.git/info", "/r/.git/info/exclude"), Some(RepoChange::Settings));
        assert_eq!(wire(Place::Info, "/r/.git/info", "/r/.git/info/exclude"), None);
        assert_eq!(state(Place::Info, "/r/.git/info", "/r/.git/info/exclude.lock"), None);
        assert_eq!(state(Place::GitDir, git, "/r/.git/COMMIT_EDITMSG"), None);
    }

    #[test]
    fn refs_are_refs_except_the_stash() {
        let refs = "/r/.git/refs";
        assert_eq!(wire(Place::Refs, refs, "/r/.git/refs/heads/main"), Some(GitChangeKind::Refs));
        assert_eq!(wire(Place::Refs, refs, "/r/.git/refs/remotes/origin/main"), Some(GitChangeKind::Refs));
        assert_eq!(wire(Place::Refs, refs, "/r/.git/refs/stash"), Some(GitChangeKind::Stash));
        assert_eq!(wire(Place::Refs, refs, "/r/.git/refs/heads/stash"), Some(GitChangeKind::Refs));
        // Only a remote-tracking ref leaves the working tree's changes standing.
        assert_eq!(state(Place::Refs, refs, "/r/.git/refs/remotes/origin/main"), Some(RepoChange::RemoteRefs));
        assert_eq!(state(Place::Refs, refs, "/r/.git/refs/heads/remotes"), Some(RepoChange::Refs));
    }

    #[test]
    fn ignored_folders_below_the_working_tree_do_not_count() {
        let root = "/r/.eos/worktrees/w1";
        assert_eq!(wire(Place::Worktree, root, "/r/.eos/worktrees/w1/src/a.rs"), Some(GitChangeKind::Worktree));
        assert_eq!(wire(Place::Worktree, root, root), Some(GitChangeKind::Worktree));
        for noise in [".git/index", "node_modules/p/i.js", "a/dist/x.js", ".eos/worktrees/w2/a.rs", "x/.DS_Store"] {
            assert_eq!(wire(Place::Worktree, root, &format!("{root}/{noise}")), None, "{noise}");
        }
    }

    #[test]
    fn an_ignored_folder_is_dropped_only_when_no_watched_place_needs_it() {
        let target = |path: &str, place| Target { path: PathBuf::from(path), place, consumers: Vec::new() };
        let ignored = |top: &str, folders: &[&str]| {
            (PathBuf::from(top), folders.iter().map(|f| PathBuf::from(format!("{top}/{f}"))).collect())
        };
        let state = State {
            targets: vec![
                target("/r", Place::Worktree),
                target("/r/.git", Place::GitDir),
                target("/r/.git/refs", Place::Refs),
                // A worktree inside a folder `/r` ignores, and a repository nested in `/r`.
                target("/r/.eos/worktrees/w", Place::Worktree),
                target("/r/inner", Place::Worktree),
            ],
            ignored: vec![
                ignored("/r", &["target", ".eos", "inner/build", "inner/out"]),
                ignored("/r/inner", &["build"]),
                // A tree whose files are not watched (any more) counts for nothing.
                ignored("/gone", &["target"]),
            ],
            ..State::default()
        };
        let mut skipped: Vec<_> = state.skippable().into_iter().collect();
        skipped.sort();
        // `.eos` holds a watched tree; `inner/out` is not ignored by `inner` itself.
        assert_eq!(skipped, [PathBuf::from("/r/inner/build"), PathBuf::from("/r/target")]);
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
