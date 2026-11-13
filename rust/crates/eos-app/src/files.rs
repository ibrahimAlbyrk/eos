//! The Files and git panels: their adapters and their module.

use std::sync::{Arc, Mutex};

use eos_core::git::GitWatcher;
use eos_git::{Git, Snapshots};
use eos_kit_proc::{ProcessTrees, Runner};
use eos_mod_agents::WorkerGit;
use eos_mod_fs::{CandidateCache, FsModule, Ports, fs_change_sink, git_change_sink};
use eos_runtime::module::Module;
use eos_runtime::router::RouteDef;
use eos_watch::{DirWatcher, RepoWatcher, ResolveGitDirs};

use crate::modules::Context;

/// Routes for the raw-content origin's router, gathered from the modules that have some.
#[derive(Default)]
pub(crate) struct RawRoutes(Mutex<Vec<RouteDef>>);

impl RawRoutes {
    pub(crate) fn add(&self, routes: Vec<RouteDef>) {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).extend(routes);
    }

    pub(crate) fn take(&self) -> Vec<RouteDef> {
        std::mem::take(&mut *self.0.lock().unwrap_or_else(|p| p.into_inner()))
    }
}

/// The git adapter over this platform's process handling.
pub(crate) fn git(clock: &Arc<dyn eos_core::Clock>) -> Git {
    let trees = ProcessTrees::new(eos_platform::isolate_command, |pid| eos_platform::kill_process_tree(pid).is_ok());
    Git::new(Runner::new(trees), clock.clone())
}

/// git for the whole app: one set of working-tree snapshots that the git
/// panels, the routes over a worker's folder and the repo watcher share, and
/// the adapter for everything else, which tells those snapshots of each
/// command that may change a tree.
#[derive(Clone)]
pub(crate) struct Repos {
    /// The hot reads (`GitInfo`, `GitDiffs`) and the `RepoState`.
    pub(crate) snapshots: Arc<Snapshots>,
    /// Writes, and the reads that are not kept.
    pub(crate) git: Arc<Git>,
}

pub(crate) fn repos(clock: &Arc<dyn eos_core::Clock>) -> Repos {
    let base = git(clock);
    let snapshots = Arc::new(Snapshots::new(base.clone()));
    Repos { git: Arc::new(base.telling(snapshots.clone())), snapshots }
}

/// What watches repositories for git changes: one for the app, shared by the
/// git panels and by the watch on the active workers' folders. It tells the
/// snapshots of every change before its event goes out.
pub(crate) fn git_watcher(
    clock: &Arc<dyn eos_core::Clock>,
    bus: &eos_runtime::bus::Bus,
    repos: &Repos,
) -> Arc<dyn GitWatcher> {
    let snapshots = repos.snapshots.clone();
    let resolve: ResolveGitDirs = Arc::new(move |dir| {
        let snapshots = snapshots.clone();
        Box::pin(async move { eos_core::git::GitInfo::git_dirs(snapshots.as_ref(), &dir).await })
    });
    let recursive = eos_platform::host().native_recursive_watch();
    let sink = git_change_sink(bus.clone());
    Arc::new(RepoWatcher::telling(resolve, clock.clone(), sink, recursive, repos.snapshots.clone()))
}

/// What the routes over a worker's folder reach: git, Try and the desktop.
pub(crate) fn worker_git(cx: &Context) -> WorkerGit {
    let (snapshots, git) = (cx.repos.snapshots.clone(), cx.repos.git.clone());
    WorkerGit {
        info: snapshots.clone(),
        diffs: snapshots.clone(),
        push: git.clone(),
        remotes: git.clone(),
        conflicts: git.clone(),
        restore: git.clone(),
        tries: cx.tries.clone(),
        merge: git,
        desktop: Arc::new(eos_fs::DesktopApps::new(
            eos_platform::host(),
            cx.clock.clone(),
            cx.paths.join("icon-cache"),
        )),
        state: snapshots,
    }
}

/// The goal loop: its checks run the worker's verify commands and read its diff.
pub(crate) fn loops(cx: &Context) -> eos_mod_loops::LoopsModule {
    let trees = ProcessTrees::new(eos_platform::isolate_command, |pid| eos_platform::kill_process_tree(pid).is_ok());
    let commands = eos_mod_loops::ShellCommands::new(Runner::new(trees), eos_platform::host().script_shell());
    eos_mod_loops::LoopsModule::new(eos_mod_loops::Parts {
        store: cx.store.clone(),
        sessions: cx.sessions.clone(),
        config: cx.config.clone(),
        prompts: cx.prompts.clone(),
        judge: cx.one_shot.clone(),
        diffs: cx.repos.snapshots.clone(),
        commands: Arc::new(commands),
        ids: cx.ids.clone(),
        bus: cx.bus.clone(),
    })
    .rearming(cx.sweep_leftovers)
}

pub(crate) fn module(cx: &Context) -> Arc<dyn Module> {
    let host = eos_platform::host();
    let (snapshots, git) = (cx.repos.snapshots.clone(), cx.repos.git.clone());
    let candidates = Arc::new(CandidateCache::new(git.clone(), cx.clock.clone()));
    let bus = &cx.kernel.bus;
    let module = FsModule::new(
        cx.kernel.clone(),
        Ports {
            files: Arc::new(eos_fs::DiskFileSystem::new(host, cx.paths.trash_dir())),
            desktop: Arc::new(eos_fs::DesktopApps::new(host, cx.clock.clone(), cx.paths.join("icon-cache"))),
            picker: cx.picker.clone(),
            file_watcher: Arc::new(DirWatcher::new(cx.clock.clone(), fs_change_sink(bus.clone()))),
            git: snapshots.clone(),
            git_diffs: snapshots.clone(),
            tree: git.clone(),
            branches: git.clone(),
            remotes: git,
            git_watcher: cx.git_watcher.clone(),
            repo_state: snapshots,
            candidates: candidates.clone(),
            symbols: Some(Arc::new(eos_symbols::TagIndex::new(candidates.clone()))),
            pdfjs_root: cx.pdfjs_root.clone(),
        },
    );
    cx.raw_routes.add(module.raw_routes());
    Arc::new(module)
}
