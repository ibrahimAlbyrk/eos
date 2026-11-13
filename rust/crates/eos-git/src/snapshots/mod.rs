//! What the git reads are answered from: per working tree, a few kept parts,
//! each brought up to date by one computation that every caller shares.
//!
//! | Part | Computed by | Stale after |
//! |---|---|---|
//! | where a folder is (its tree, its git folders) | one `git rev-parse` | the tree is dropped |
//! | refs: branches, upstream, ahead/behind, remotes, stash count | gix (`refs`) | HEAD, index, refs, remote refs, stash, settings |
//! | branch picker: remote branches, recent checkouts | git | the same |
//! | short revisions, merge bases, the default base | git | the same |
//! | status + line counts against HEAD | `git status` ∥ `git diff` | HEAD, index, refs, files, merge state, settings |
//! | the same against a base | `git diff --name-status` ∥ `git diff` | the same |
//! | whole patches | `git diff` | the same |
//!
//! The repo watcher tells this service of each change as soon as the system
//! reports it ([`RepoState`]); every git command Eos runs that may write, and
//! every file Eos or an agent changes, does too. A tree the watcher watches
//! keeps its parts until they go stale (at most 30 s, for what no event
//! reports: the global git config, say) and is computed again as soon as the
//! changes of an operation were gathered, when somebody read it lately. A
//! tree nobody watches only shares computations among the reads of one
//! burst (1 s). At most 64 trees and 64 MB of patches are kept; a tree's
//! state goes when its last watch ends.

mod part;
mod reads;
mod refs;
mod status;

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use eos_core::git::{GitDiffs, GitDirs, GitInfo, RepoChange, RepoState};
use eos_kit_fs::path::normalize;
use tokio::runtime::Handle;
use tokio::time::Instant;

use crate::Git;
use part::{Ask, Keyed, Part};
use refs::Refs;
use status::{Against, Listing};

/// How much is kept, and for how long.
#[derive(Debug, Clone)]
pub struct Limits {
    /// Working trees with kept parts.
    pub trees: usize,
    /// Folders whose place (tree, git folders) is kept.
    pub folders: usize,
    /// Parts of one kind kept per tree with different keys (bases, revisions).
    pub keyed: usize,
    /// All kept patches together.
    pub patch_bytes: usize,
    /// A larger patch is handed out, not kept.
    pub patch_max: usize,
    /// How long a part of a watched tree is kept at most.
    pub watched_age: Duration,
    /// How long a part of a tree nobody watches is shared.
    pub unwatched_age: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            trees: 64,
            folders: 256,
            keyed: 8,
            patch_bytes: 64 * 1024 * 1024,
            patch_max: 16 * 1024 * 1024,
            watched_age: Duration::from_secs(30),
            unwatched_age: Duration::from_secs(1),
        }
    }
}

/// How much is kept now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Kept {
    pub trees: usize,
    pub folders: usize,
    pub watched: usize,
    /// Trees being computed again after a change, before anybody asked.
    pub refreshing: usize,
    pub patch_bytes: usize,
    /// Times the refs were read by the git commands because gix could not
    /// be trusted to read them as git does.
    pub refs_by_git: u64,
}

/// A working tree: its top folder and its git folders.
#[derive(Debug)]
pub(crate) struct TreeRef {
    top: PathBuf,
    dirs: GitDirs,
}

/// Where a folder is.
#[derive(Debug)]
pub(crate) enum Place {
    /// In the working tree `tree`, at `prefix` below its top (`sub/`, or
    /// empty at the top); `dirs` as git prints them from this folder.
    In { tree: Arc<TreeRef>, prefix: String, dirs: GitDirs },
    /// git says it is not in a repository: every read answers empty.
    NotRepo,
    /// Anything else (a git folder itself, a folder that is gone, an
    /// untrusted one): the reads ask git directly.
    Unknown,
}

/// What `/fs/branches?remotes=1` adds.
#[derive(Debug)]
pub(crate) struct Picker {
    remote_branches: Vec<String>,
    recent: Vec<String>,
}

/// The kept parts of one working tree.
struct Tree {
    at: Arc<TreeRef>,
    used: Instant,
    /// gix's handle, opened when the refs were first read; reopened after
    /// a settings change and when it is older than the watched age.
    repo: Option<(gix::ThreadSafeRepository, Instant)>,
    refreshing: bool,
    refs: Keyed<Refs>,
    picker: Keyed<Picker>,
    revs: Keyed<Option<String>>,
    merge_bases: Keyed<Option<String>>,
    default_base: Keyed<Option<String>>,
    listing: Keyed<Listing>,
    against: Keyed<Against>,
    patches: Keyed<Option<String>>,
}

/// Which parts a change makes stale: (what refs say, what the files say).
fn reach(change: RepoChange) -> (bool, bool) {
    match change {
        RepoChange::Head | RepoChange::Index | RepoChange::Refs | RepoChange::Settings => (true, true),
        RepoChange::RemoteRefs | RepoChange::Stash => (true, false),
        RepoChange::Worktree | RepoChange::Conflict => (false, true),
    }
}

fn stale<T>(parts: &mut Keyed<T>, generations: &mut u64) {
    for (_, part) in parts.iter_mut() {
        *generations += 1;
        part.invalidate(*generations);
    }
}

/// A part somebody read lately and that is no longer kept.
enum Wanted {
    Refs,
    Picker,
    Rev(String),
    MergeBase(String),
    DefaultBase,
    Listing,
    Against(String),
}

impl Tree {
    fn new(at: Arc<TreeRef>, limits: &Limits, now: Instant) -> Self {
        Self {
            at,
            used: now,
            repo: None,
            refreshing: false,
            refs: Keyed::new(1),
            picker: Keyed::new(1),
            revs: Keyed::new(limits.keyed),
            merge_bases: Keyed::new(limits.keyed),
            default_base: Keyed::new(1),
            listing: Keyed::new(1),
            against: Keyed::new(limits.keyed),
            patches: Keyed::new(limits.keyed),
        }
    }

    /// `None`: everything.
    fn invalidate(&mut self, change: Option<RepoChange>, generations: &mut u64) {
        let (refs, files) = change.map_or((true, true), reach);
        if refs {
            stale(&mut self.refs, generations);
            stale(&mut self.picker, generations);
            stale(&mut self.revs, generations);
            stale(&mut self.merge_bases, generations);
            stale(&mut self.default_base, generations);
        }
        if files {
            stale(&mut self.listing, generations);
            stale(&mut self.against, generations);
            stale(&mut self.patches, generations);
        }
        if change.is_none_or(|change| change == RepoChange::Settings) {
            self.repo = None;
        }
    }

    fn wanted(&self, now: Instant, window: Duration) -> Vec<Wanted> {
        fn keys<T>(parts: &Keyed<T>, now: Instant, window: Duration) -> impl Iterator<Item = String> + '_ {
            parts.iter().filter(move |(_, part)| part.wants_refresh(now, window)).map(|(key, _)| key.to_owned())
        }
        let mut wanted = Vec::new();
        wanted.extend(keys(&self.refs, now, window).map(|_| Wanted::Refs));
        wanted.extend(keys(&self.picker, now, window).map(|_| Wanted::Picker));
        wanted.extend(keys(&self.revs, now, window).map(Wanted::Rev));
        wanted.extend(keys(&self.merge_bases, now, window).map(Wanted::MergeBase));
        wanted.extend(keys(&self.default_base, now, window).map(|_| Wanted::DefaultBase));
        wanted.extend(keys(&self.listing, now, window).map(|_| Wanted::Listing));
        wanted.extend(keys(&self.against, now, window).map(Wanted::Against));
        wanted
    }

    fn patch_bytes(&self) -> usize {
        self.patches
            .iter()
            .filter_map(|(_, part)| part.kept())
            .map(|patch| patch.as_ref().as_ref().map_or(0, String::len))
            .sum()
    }
}

#[derive(Default)]
struct Watches {
    all: usize,
    /// Watches that see the files too, not only the git folders.
    whole: usize,
}

#[derive(Default)]
struct State {
    trees: HashMap<PathBuf, Tree>,
    places: HashMap<PathBuf, Part<Place>>,
    watched: HashMap<PathBuf, Watches>,
    /// Every generation handed out is new: a computation of a tree that was
    /// dropped and made again never passes for a current one.
    generations: u64,
}

impl State {
    fn is_watched(&self, top: &Path) -> bool {
        self.watched.get(top).is_some_and(|w| w.whole > 0)
    }

    fn max_age(&self, top: &Path, limits: &Limits) -> Duration {
        if self.is_watched(top) { limits.watched_age } else { limits.unwatched_age }
    }

    /// The tree of `at`, made when missing; the one used longest ago (one
    /// nobody watches first) makes room.
    fn tree(&mut self, at: &Arc<TreeRef>, limits: &Limits, now: Instant) -> &mut Tree {
        if !self.trees.contains_key(&at.top) && self.trees.len() >= limits.trees {
            let oldest = |watched: bool| {
                self.trees
                    .iter()
                    .filter(|(top, _)| self.is_watched(top) == watched)
                    .min_by_key(|(_, tree)| tree.used)
                    .map(|(top, _)| top.clone())
            };
            if let Some(top) = oldest(false).or_else(|| oldest(true)) {
                self.trees.remove(&top);
            }
        }
        let tree = self.trees.entry(at.top.clone()).or_insert_with(|| Tree::new(at.clone(), limits, now));
        tree.used = now;
        tree
    }

    fn next_generation(&mut self) -> u64 {
        self.generations += 1;
        self.generations
    }

    fn invalidate(&mut self, top: &Path, change: Option<RepoChange>) {
        let State { trees, generations, .. } = self;
        if let Some(tree) = trees.get_mut(top) {
            tree.invalidate(change, generations);
        }
    }

    /// Keeps the patches within their budget: those read longest ago go first.
    fn trim_patches(&mut self, limits: &Limits) {
        while self.trees.values().map(Tree::patch_bytes).sum::<usize>() > limits.patch_bytes {
            let oldest = self
                .trees
                .iter()
                .flat_map(|(top, tree)| {
                    tree.patches
                        .iter()
                        .filter(|(_, part)| part.kept().is_some())
                        .map(move |(key, part)| (part.read_at(), top.clone(), key.to_owned()))
                })
                .min_by_key(|(read_at, _, _)| *read_at);
            let Some((_, top, key)) = oldest else { return };
            if let Some(part) = self.trees.get_mut(&top).and_then(|tree| tree.patches.get_mut(&key)) {
                part.forget();
            }
        }
    }
}

struct Inner {
    /// Reads only: what the parts are computed with.
    git: Git,
    limits: Limits,
    state: Mutex<State>,
    /// Where the refresh after a change runs (the watcher calls from its own thread).
    runtime: OnceLock<Handle>,
    refs_by_git: AtomicU64,
}

/// The git reads (`GitInfo`, `GitDiffs`) answered from what is kept per
/// working tree, and the `RepoState` told what went stale. Cheap to clone.
#[derive(Clone)]
pub struct Snapshots {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for Snapshots {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Snapshots").field("kept", &self.kept()).finish_non_exhaustive()
    }
}

/// The folder line `git rev-parse --show-toplevel --show-prefix
/// --absolute-git-dir --git-common-dir` printed for `cwd`, as `git_dirs` reads each.
fn place_of(cwd: &Path, out: &str) -> Option<Place> {
    let lines: Vec<&str> = out.split('\n').collect();
    let [top, prefix, git_dir, common, ""] = lines.as_slice() else { return None };
    let (top, git_dir, common) = (top.trim(), git_dir.trim(), common.trim());
    if top.is_empty() || git_dir.is_empty() {
        return None;
    }
    let git_dir = normalize(Path::new(git_dir));
    let common_dir = if common.is_empty() { git_dir.clone() } else { normalize(&cwd.join(common)) };
    let toplevel = normalize(Path::new(top));
    let dirs = GitDirs { toplevel: toplevel.clone(), git_dir, common_dir };
    let tree = Arc::new(TreeRef { top: toplevel, dirs: dirs.clone() });
    Some(Place::In { tree, prefix: (*prefix).to_owned(), dirs })
}

impl Snapshots {
    /// Reads over `git`, which should not tell these snapshots of its writes
    /// (it runs only reads here).
    pub fn new(git: Git) -> Self {
        Self::with_limits(git, Limits::default())
    }

    pub fn with_limits(git: Git, limits: Limits) -> Self {
        let runtime = OnceLock::new();
        if let Ok(handle) = Handle::try_current() {
            let _ = runtime.set(handle);
        }
        Self {
            inner: Arc::new(Inner { git, limits, state: Mutex::default(), runtime, refs_by_git: AtomicU64::new(0) }),
        }
    }

    /// What is kept now.
    pub fn kept(&self) -> Kept {
        let state = self.state();
        Kept {
            trees: state.trees.len(),
            folders: state.places.len(),
            watched: state.watched.len(),
            refreshing: state.trees.values().filter(|tree| tree.refreshing).count(),
            patch_bytes: state.trees.values().map(Tree::patch_bytes).sum(),
            refs_by_git: self.inner.refs_by_git.load(Ordering::Relaxed),
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.inner.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn git(&self) -> &Git {
        &self.inner.git
    }

    /// Where `cwd` is, kept as long as its tree's parts are.
    async fn place(&self, cwd: &Path) -> Arc<Place> {
        if self.inner.runtime.get().is_none()
            && let Ok(handle) = Handle::try_current()
        {
            let _ = self.inner.runtime.set(handle);
        }
        // `git -C` into a folder that is gone fails; asking git says so.
        if !cwd.is_dir() {
            return Arc::new(Place::Unknown);
        }
        let limits = &self.inner.limits;
        let ask = {
            let mut state = self.state();
            let now = Instant::now();
            if !state.places.contains_key(cwd)
                && state.places.len() >= limits.folders
                && let Some(oldest) =
                    state.places.iter().min_by_key(|(_, part)| part.read_at()).map(|(cwd, _)| cwd.clone())
            {
                state.places.remove(&oldest);
            }
            let generation = state.next_generation();
            let State { places, watched, .. } = &mut *state;
            let part = places.entry(cwd.to_owned()).or_insert_with(|| Part::new(generation));
            part.ask(now, |place| match place {
                Place::In { tree, .. } if watched.get(&tree.top).is_some_and(|w| w.whole > 0) => limits.watched_age,
                _ => limits.unwatched_age,
            })
        };
        match ask {
            Ask::Kept(place) => place,
            Ask::Wait { generation, flight } => {
                let running = flight.clone();
                let compute = async move {
                    let started = Instant::now();
                    let args =
                        ["rev-parse", "--show-toplevel", "--show-prefix", "--absolute-git-dir", "--git-common-dir"];
                    let place = match self.git().run(cwd, &args).await {
                        Ok(ran) => place_of(cwd, &ran.text()).unwrap_or(Place::Unknown),
                        Err(failed) if failed.stderr_or_message().contains("not a git repository") => Place::NotRepo,
                        Err(_) => Place::Unknown,
                    };
                    let place = Arc::new(place);
                    if let Some(part) = self.state().places.get_mut(cwd) {
                        part.settle(generation, &running, place.clone(), started, true);
                    }
                    place
                };
                flight.get_or_init(|| compute).await.clone()
            }
        }
    }

    /// One part of `tree`, kept or computed by `compute` (shared with every
    /// caller of the same generation).
    async fn part<T, F>(
        &self,
        tree: &Arc<TreeRef>,
        slot: fn(&mut Tree) -> &mut Keyed<T>,
        key: &str,
        compute: impl FnOnce() -> F,
    ) -> Arc<T>
    where
        T: Send + Sync + 'static,
        F: Future<Output = T>,
    {
        let limits = &self.inner.limits;
        let ask = {
            let mut state = self.state();
            let now = Instant::now();
            let max_age = state.max_age(&tree.top, limits);
            let generation = state.next_generation();
            slot(state.tree(tree, limits, now)).entry(key, || generation).ask(now, |_| max_age)
        };
        match ask {
            Ask::Kept(value) => value,
            Ask::Wait { generation, flight } => {
                let running = flight.clone();
                let compute = async move {
                    let started = Instant::now();
                    let value = Arc::new(compute().await);
                    let mut state = self.state();
                    if let Some(part) = state.trees.get_mut(&tree.top).and_then(|t| slot(t).get_mut(key)) {
                        part.settle(generation, &running, value.clone(), started, true);
                    }
                    value
                };
                flight.get_or_init(|| compute).await.clone()
            }
        }
    }

    async fn refs(&self, tree: &Arc<TreeRef>) -> Arc<Refs> {
        self.part(tree, |t| &mut t.refs, "", || self.read_refs(tree)).await
    }

    /// gix's handle for the tree, opened on the blocking pool when needed.
    async fn repo(&self, tree: &Arc<TreeRef>) -> Option<gix::ThreadSafeRepository> {
        let limits = &self.inner.limits;
        {
            let state = self.state();
            if let Some((repo, opened)) = state.trees.get(&tree.top).and_then(|t| t.repo.as_ref())
                && opened.elapsed() < limits.watched_age
            {
                return Some(repo.clone());
            }
        }
        let top = tree.top.clone();
        let opened = match tokio::task::spawn_blocking(move || refs::open(&top)).await {
            Ok(Ok(repo)) => repo,
            Ok(Err(why)) => {
                tracing::debug!(top = %tree.top.display(), reason = why.0, "refs are read by git");
                return None;
            }
            Err(_) => return None,
        };
        if let Some(t) = self.state().trees.get_mut(&tree.top) {
            t.repo = Some((opened.clone(), Instant::now()));
        }
        Some(opened)
    }

    async fn read_refs(&self, tree: &Arc<TreeRef>) -> Refs {
        if let Some(repo) = self.repo(tree).await {
            let dirs = tree.dirs.clone();
            match tokio::task::spawn_blocking(move || refs::read(&repo.to_thread_local(), &dirs)).await {
                Ok(Ok(read)) if !read.detached => return read.refs,
                Ok(Ok(mut read)) => {
                    read.refs.branches = self.git().list_branches(&tree.top).await;
                    return read.refs;
                }
                Ok(Err(why)) => tracing::debug!(top = %tree.top.display(), reason = why.0, "refs are read by git"),
                Err(_) => {}
            }
        }
        self.inner.refs_by_git.fetch_add(1, Ordering::Relaxed);
        refs::by_git(self.git(), &tree.top).await
    }

    async fn picker(&self, tree: &Arc<TreeRef>) -> Arc<Picker> {
        self.part(
            tree,
            |t| &mut t.picker,
            "",
            || async {
                let (remote_branches, recent) =
                    tokio::join!(self.git().remote_branches(&tree.top), self.git().recent_checkouts(&tree.top));
                Picker { remote_branches, recent }
            },
        )
        .await
    }

    async fn rev(&self, tree: &Arc<TreeRef>, rev: &str) -> Arc<Option<String>> {
        self.part(tree, |t| &mut t.revs, rev, || self.git().rev_parse(&tree.top, rev)).await
    }

    async fn merge_base(&self, tree: &Arc<TreeRef>, rev: &str) -> Arc<Option<String>> {
        self.part(tree, |t| &mut t.merge_bases, rev, || self.git().merge_base_ref(&tree.top, rev)).await
    }

    async fn default_base(&self, tree: &Arc<TreeRef>) -> Arc<Option<String>> {
        self.part(tree, |t| &mut t.default_base, "", || self.git().default_base_ref(&tree.top)).await
    }

    async fn listing(&self, tree: &Arc<TreeRef>) -> Arc<Listing> {
        self.part(
            tree,
            |t| &mut t.listing,
            "",
            || async {
                let diff_args = status::diff_args("HEAD");
                let (status, diff) =
                    tokio::join!(self.git().run(&tree.top, &status::STATUS), self.git().run(&tree.top, &diff_args));
                Listing::read(status, diff)
            },
        )
        .await
    }

    async fn against(&self, tree: &Arc<TreeRef>, base: &str) -> Arc<Against> {
        self.part(
            tree,
            |t| &mut t.against,
            base,
            || async {
                let (names_args, diff_args) = (status::name_status_args(base), status::diff_args(base));
                let (names, diff) =
                    tokio::join!(self.git().run(&tree.top, &names_args), self.git().run(&tree.top, &diff_args));
                Against::read(names, diff)
            },
        )
        .await
    }

    /// The whole patch against `base`; kept when it fits the budget.
    async fn patch(&self, tree: &Arc<TreeRef>, base: Option<&str>) -> Arc<Option<String>> {
        let key = base.unwrap_or("HEAD");
        let limits = &self.inner.limits;
        let ask = {
            let mut state = self.state();
            let now = Instant::now();
            let max_age = state.max_age(&tree.top, limits);
            let generation = state.next_generation();
            state.tree(tree, limits, now).patches.entry(key, || generation).ask(now, |_| max_age)
        };
        match ask {
            Ask::Kept(patch) => patch,
            Ask::Wait { generation, flight } => {
                let running = flight.clone();
                let compute = async move {
                    let started = Instant::now();
                    let patch = Arc::new(self.git().full_diff(&tree.top, base).await);
                    let fits = patch.as_ref().as_ref().is_none_or(|p| p.len() <= limits.patch_max);
                    let mut state = self.state();
                    if let Some(part) = state.trees.get_mut(&tree.top).and_then(|t| t.patches.get_mut(key)) {
                        part.settle(generation, &running, patch.clone(), started, fits);
                    }
                    state.trim_patches(limits);
                    patch
                };
                flight.get_or_init(|| compute).await.clone()
            }
        }
    }

    /// Computes again what of `top` was read lately, once its changes were gathered.
    fn refresh(&self, top: &Path) {
        let Some(runtime) = self.inner.runtime.get() else { return };
        let (tree, wanted) = {
            let mut state = self.state();
            if !state.is_watched(top) {
                return;
            }
            let Some(tree) = state.trees.get_mut(top) else { return };
            let wanted = tree.wanted(Instant::now(), self.inner.limits.watched_age);
            if tree.refreshing || wanted.is_empty() {
                return;
            }
            tree.refreshing = true;
            (tree.at.clone(), wanted)
        };
        let this = self.clone();
        runtime.spawn(async move {
            let mut all = tokio::task::JoinSet::new();
            for want in wanted {
                let (this, tree) = (this.clone(), tree.clone());
                all.spawn(async move {
                    match want {
                        Wanted::Refs => drop(this.refs(&tree).await),
                        Wanted::Picker => drop(this.picker(&tree).await),
                        Wanted::Rev(rev) => drop(this.rev(&tree, &rev).await),
                        Wanted::MergeBase(rev) => drop(this.merge_base(&tree, &rev).await),
                        Wanted::DefaultBase => drop(this.default_base(&tree).await),
                        Wanted::Listing => drop(this.listing(&tree).await),
                        Wanted::Against(base) => drop(this.against(&tree, &base).await),
                    }
                });
            }
            while all.join_next().await.is_some() {}
            if let Some(tree) = this.state().trees.get_mut(&tree.top) {
                tree.refreshing = false;
            }
        });
    }

    /// The trees `path` (its real path `real`) is in, and the trees sharing their repository.
    fn trees_holding(state: &State, path: &Path, real: Option<&Path>) -> Vec<PathBuf> {
        let inside = |top: &Path| path.starts_with(top) || real.is_some_and(|real| real.starts_with(top));
        let mut hit: Vec<PathBuf> = state.trees.keys().filter(|top| inside(top)).cloned().collect();
        for (cwd, place) in &state.places {
            if path.starts_with(cwd)
                && let Some(Place::In { tree, .. }) = place.kept().map(Arc::as_ref)
            {
                hit.push(tree.top.clone());
            }
        }
        let commons: Vec<&Path> =
            hit.iter().filter_map(|top| state.trees.get(top)).map(|t| t.at.dirs.common_dir.as_path()).collect();
        let shared: Vec<PathBuf> = state
            .trees
            .iter()
            .filter(|(_, tree)| commons.contains(&tree.at.dirs.common_dir.as_path()))
            .map(|(top, _)| top.clone())
            .collect();
        hit.extend(shared);
        hit.sort();
        hit.dedup();
        hit
    }
}

impl RepoState for Snapshots {
    fn watching(&self, dirs: &GitDirs, whole: bool) {
        let mut state = self.state();
        let watches = state.watched.entry(dirs.toplevel.clone()).or_default();
        watches.all += 1;
        if whole {
            watches.whole += 1;
            // What was kept while nobody watched may have missed a change.
            if watches.whole == 1 {
                state.invalidate(&dirs.toplevel, None);
            }
        }
    }

    fn unwatching(&self, dirs: &GitDirs, whole: bool) {
        let mut state = self.state();
        let top = &dirs.toplevel;
        let Some(watches) = state.watched.get_mut(top) else { return };
        watches.all = watches.all.saturating_sub(1);
        if whole {
            watches.whole = watches.whole.saturating_sub(1);
        }
        if watches.all > 0 {
            return;
        }
        state.watched.remove(top);
        state.trees.remove(top);
        state.places.retain(
            |_, part| !matches!(part.kept().map(Arc::as_ref), Some(Place::In { tree, .. }) if tree.top == *top),
        );
    }

    fn changed(&self, toplevel: &Path, change: RepoChange) {
        self.state().invalidate(toplevel, Some(change));
    }

    fn settled(&self, toplevel: &Path) {
        self.refresh(toplevel);
    }

    fn lost(&self) {
        let mut state = self.state();
        let State { trees, places, generations, .. } = &mut *state;
        for tree in trees.values_mut() {
            tree.invalidate(None, generations);
        }
        for part in places.values_mut() {
            *generations += 1;
            part.invalidate(*generations);
        }
    }

    fn touched(&self, path: &Path) {
        let real = std::fs::canonicalize(path).ok();
        let mut state = self.state();
        for top in Self::trees_holding(&state, path, real.as_deref()) {
            state.invalidate(&top, None);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_line_reads_as_git_dirs_does() {
        let out = "/r\nsub/\n/r/.git\n../.git\n";
        let Some(Place::In { tree, prefix, dirs }) = place_of(Path::new("/r/sub"), out) else { panic!("in a tree") };
        assert_eq!((tree.top.as_path(), prefix.as_str()), (Path::new("/r"), "sub/"));
        assert_eq!(dirs.common_dir, PathBuf::from("/r/.git"));
        assert!(place_of(Path::new("/r"), "/r\n\n/r/.git\n").is_none(), "a line is missing");
        assert!(place_of(Path::new("/r"), "/r\nx\ny\n/r/.git\n.git\n").is_none(), "a path held a newline");
    }

    #[test]
    fn changes_reach_the_parts_they_make_stale() {
        assert_eq!(reach(RepoChange::Worktree), (false, true));
        assert_eq!(reach(RepoChange::RemoteRefs), (true, false));
        assert_eq!(reach(RepoChange::Stash), (true, false));
        assert_eq!(reach(RepoChange::Refs), (true, true), "a commit moves the branch HEAD points at");
    }
}
