//! The Files and git panels: every `/fs/*` route, `/symbols/*`, and the
//! raw-content routes.
//!
//! | Module | Routes |
//! |---|---|
//! | `read` | `/fs/stat`, `/fs/list` (one level, or search), `/fs/read`, `/fs/image`, `/fs/icon`, `/fs/default-app`, `/fs/editors` |
//! | `write` | `/fs/write`, `/fs/paste`, `/fs/paste-b64`, `/fs/create`, `/fs/rename`, `/fs/move`, `/fs/trash` |
//! | `open` | `/fs/open`, `/fs/reveal`, `/fs/open-in`, `/pick-directory`, `/pick-file` |
//! | `watch` | `/fs/watch`, `/fs/unwatch`, `/fs/git/watch`, `/fs/git/unwatch` |
//! | `git` | `/fs/branches`, `/fs/unpushed`, `/fs/commit`, `/fs/log`, `/fs/stashes`, `/fs/changes`, `/fs/changes/file`, `/fs/blob`, `/fs/checkout`, `/fs/stash/*`, `/fs/branch/*`, `/fs/fetch`, `/fs/remote-branch/delete` |
//! | `symbols` | `/symbols/lookup`, `/symbols/file`, `/symbols/search` (when a symbol index is given) |
//! | `raw` | `/fs/raw/*`, `/pdfjs/*` — [`FsModule::raw_routes`], for the raw-content origin's own router |
//!
//! The watchers publish through the sinks [`fs_change_sink`] and
//! [`git_change_sink`] build; the module declares their topics, gives a tab's
//! watches back when its stream closes, and keeps the candidate-file lists
//! and the symbol index fresh from the same events.

mod branches;
mod git;
mod http;
mod open;
mod raw;
mod read;
mod search;
mod symbols;
mod watch;
mod write;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use eos_contracts::stream::topics;
use eos_contracts::{FsChangeEvent, FsChangeKind, GitChangeEvent};
use eos_core::git::{BranchAdmin, GitChangeSink, GitDiffs, GitInfo, GitWatcher, RemoteSync, RepoState, WorkingTree};
use eos_core::os::{DesktopFiles, FileSystem, FileWatcher, FsChangeSink, SymbolIndex};
use eos_core::shell::FilePicker;
use eos_runtime::Kernel;
use eos_runtime::bus::{Bus, Subscription, Topic, TopicDecl};
use eos_runtime::module::{Module, ModuleError};
use eos_runtime::router::{BoxFuture, RouteDef};

pub use search::CandidateCache;
use watch::WatchLeases;

/// Entries of watched folders changed.
pub const FS_CHANGE: Topic<FsChangeEvent> = Topic::new(topics::FS_CHANGE);
/// The git state of a working tree changed.
pub const GIT_CHANGE: Topic<GitChangeEvent> = Topic::new(topics::GIT_CHANGE);

/// What the folder watcher is built with: its batches go out as `fs:change`.
pub fn fs_change_sink(bus: Bus) -> FsChangeSink {
    Arc::new(move |event| bus.publish(&FS_CHANGE, &event))
}

/// What the git watcher is built with: its events go out as `git:change`.
pub fn git_change_sink(bus: Bus) -> GitChangeSink {
    Arc::new(move |event| bus.publish(&GIT_CHANGE, &event))
}

/// The outside systems the routes reach, as ports.
#[derive(Clone)]
pub struct Ports {
    pub files: Arc<dyn FileSystem>,
    pub desktop: Arc<dyn DesktopFiles>,
    /// The shell's open panel; `None` answers the pick routes 501.
    pub picker: Option<Arc<dyn FilePicker>>,
    pub file_watcher: Arc<dyn FileWatcher>,
    pub git: Arc<dyn GitInfo>,
    pub git_diffs: Arc<dyn GitDiffs>,
    pub tree: Arc<dyn WorkingTree>,
    pub branches: Arc<dyn BranchAdmin>,
    pub remotes: Arc<dyn RemoteSync>,
    pub git_watcher: Arc<dyn GitWatcher>,
    /// Told of every file the routes change: the git reads keep each working tree's state.
    pub repo_state: Arc<dyn RepoState>,
    /// The per-project file lists, shared with the symbol index.
    pub candidates: Arc<CandidateCache>,
    /// `None` leaves the `/symbols/*` routes out.
    pub symbols: Option<Arc<dyn SymbolIndex>>,
    /// The folder of the bundled PDF viewer; `None` leaves `/pdfjs/*` out.
    pub pdfjs_root: Option<PathBuf>,
}

impl std::fmt::Debug for Ports {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ports")
            .field("symbols", &self.symbols.is_some())
            .field("pdfjs_root", &self.pdfjs_root)
            .finish_non_exhaustive()
    }
}

/// The ports plus the module's own state, as every handler holds them.
#[derive(Clone)]
pub(crate) struct Deps {
    files: Arc<dyn FileSystem>,
    desktop: Arc<dyn DesktopFiles>,
    picker: Option<Arc<dyn FilePicker>>,
    file_watcher: Arc<dyn FileWatcher>,
    git: Arc<dyn GitInfo>,
    git_diffs: Arc<dyn GitDiffs>,
    tree: Arc<dyn WorkingTree>,
    branches: Arc<dyn BranchAdmin>,
    remotes: Arc<dyn RemoteSync>,
    git_watcher: Arc<dyn GitWatcher>,
    repo_state: Arc<dyn RepoState>,
    candidates: Arc<CandidateCache>,
    file_leases: Arc<WatchLeases>,
    git_leases: Arc<WatchLeases>,
}

pub struct FsModule {
    deps: Deps,
    symbols: Option<Arc<dyn SymbolIndex>>,
    pdfjs_root: Option<PathBuf>,
    kernel: Kernel,
    /// Held while the app runs: the reactions to `fs:change` and `git:change`.
    wiring: Mutex<Vec<Subscription>>,
}

impl std::fmt::Debug for FsModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FsModule").field("symbols", &self.symbols.is_some()).finish_non_exhaustive()
    }
}

fn is_under(root: &Path, path: &Path) -> bool {
    path.starts_with(root)
}

/// One contains the other.
fn overlaps(root: &Path, dir: &Path) -> bool {
    is_under(root, dir) || is_under(dir, root)
}

impl FsModule {
    pub fn new(kernel: Kernel, ports: Ports) -> Self {
        let (file_leases, git_leases) = (Arc::new(WatchLeases::default()), Arc::new(WatchLeases::default()));
        // A tab whose stream closed gives its watches back, even if it never asked to.
        let (files, git) = (file_leases.clone(), git_leases.clone());
        kernel.stream.on_client_gone(move |tab| {
            files.drop_tab(tab);
            git.drop_tab(tab);
        });
        let deps = Deps {
            files: ports.files,
            desktop: ports.desktop,
            picker: ports.picker,
            file_watcher: ports.file_watcher,
            git: ports.git,
            git_diffs: ports.git_diffs,
            tree: ports.tree,
            branches: ports.branches,
            remotes: ports.remotes,
            git_watcher: ports.git_watcher,
            repo_state: ports.repo_state,
            candidates: ports.candidates,
            file_leases,
            git_leases,
        };
        Self { deps, symbols: ports.symbols, pdfjs_root: ports.pdfjs_root, kernel, wiring: Mutex::new(Vec::new()) }
    }

    /// The routes of the raw-content origin. They go on that origin's own
    /// router and never on the API router (see the `raw` module).
    pub fn raw_routes(&self) -> Vec<RouteDef> {
        raw::routes(&self.deps, self.pdfjs_root.clone())
    }

    /// An entry was added or removed under a project: its file list is stale.
    /// Changed files under an indexed project are read again.
    fn on_fs_change(&self) -> impl Fn(&eos_runtime::bus::Event) + Send + Sync + 'static {
        let (candidates, symbols) = (self.deps.candidates.clone(), self.symbols.clone());
        move |event| {
            let Ok(batch) = event.payload_as::<FsChangeEvent>() else { return };
            for root in candidates.roots() {
                let listed_anew =
                    batch.changes.iter().any(|c| c.kind != FsChangeKind::Change && is_under(&root, Path::new(&c.path)));
                if listed_anew {
                    candidates.invalidate(&root);
                }
            }
            let Some(symbols) = &symbols else { return };
            for root in symbols.resident_roots() {
                let changed: Vec<String> = batch
                    .changes
                    .iter()
                    .filter(|c| is_under(Path::new(&root), Path::new(&c.path)))
                    .map(|c| c.path.clone())
                    .collect();
                if changed.is_empty() {
                    continue;
                }
                // The handler runs on the ordered lane and must not wait.
                let symbols = symbols.clone();
                tokio::spawn(async move {
                    if let Err(error) = symbols.invalidate(Path::new(&root), &changed).await {
                        tracing::warn!(root, %error, "symbol invalidate failed");
                    }
                });
            }
        }
    }

    /// A working tree's git state changed (edits the shallow folder watches
    /// never see included): the projects it overlaps are listed and indexed anew.
    fn on_git_change(&self) -> impl Fn(&eos_runtime::bus::Event) + Send + Sync + 'static {
        let (candidates, symbols) = (self.deps.candidates.clone(), self.symbols.clone());
        move |event| {
            let Ok(change) = event.payload_as::<GitChangeEvent>() else { return };
            let dir = Path::new(&change.dir);
            for root in candidates.roots() {
                if overlaps(&root, dir) {
                    candidates.invalidate(&root);
                }
            }
            let Some(symbols) = &symbols else { return };
            for root in symbols.resident_roots() {
                if overlaps(Path::new(&root), dir) {
                    symbols.mark_dirty(Path::new(&root));
                }
            }
        }
    }
}

impl Module for FsModule {
    fn id(&self) -> &'static str {
        "fs"
    }

    fn routes(&self) -> Vec<RouteDef> {
        let deps = &self.deps;
        let mut routes = read::routes(deps);
        routes.extend(write::routes(deps));
        routes.extend(open::routes(deps));
        routes.extend(watch::routes(deps));
        routes.extend(git::routes(deps));
        if let Some(index) = &self.symbols {
            routes.extend(symbols::routes(index));
        }
        routes
    }

    fn topics(&self) -> Vec<TopicDecl> {
        vec![FS_CHANGE.decl(), GIT_CHANGE.decl()]
    }

    fn start(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        let bus = &self.kernel.bus;
        let subscriptions =
            vec![bus.on(topics::FS_CHANGE, self.on_fs_change()), bus.on(topics::GIT_CHANGE, self.on_git_change())];
        *self.wiring.lock().unwrap_or_else(|p| p.into_inner()) = subscriptions;
        Box::pin(std::future::ready(Ok(())))
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        self.wiring.lock().unwrap_or_else(|p| p.into_inner()).clear();
        // The system watches end with the app, not with the last tab.
        self.deps.file_watcher.close_all();
        self.deps.git_watcher.close_all();
        Box::pin(std::future::ready(()))
    }
}
