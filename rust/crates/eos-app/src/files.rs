//! The Files and git panels: their adapters and their module.

use std::sync::{Arc, Mutex};

use eos_git::Git;
use eos_kit_proc::{ProcessTrees, Runner};
use eos_mod_fs::{CandidateCache, FsModule, Ports, fs_change_sink, git_change_sink};
use eos_runtime::module::Module;
use eos_runtime::router::RouteDef;
use eos_watch::{DirWatcher, RepoWatcher, ResolveGitDirs};

use crate::modules::Context;

/// Routes for the raw-content origin's router, gathered from the modules that have some.
#[derive(Default)]
pub(crate) struct RawRoutes(Mutex<Vec<RouteDef>>);

impl RawRoutes {
    fn add(&self, routes: Vec<RouteDef>) {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).extend(routes);
    }

    pub(crate) fn take(&self) -> Vec<RouteDef> {
        std::mem::take(&mut *self.0.lock().unwrap_or_else(|p| p.into_inner()))
    }
}

pub(crate) fn module(cx: &Context) -> Arc<dyn Module> {
    let host = eos_platform::host();
    let trees = ProcessTrees::new(eos_platform::isolate_command, |pid| eos_platform::kill_process_tree(pid).is_ok());
    let git = Arc::new(Git::new(Runner::new(trees), cx.clock.clone()));
    let resolve: ResolveGitDirs = {
        let git = git.clone();
        Arc::new(move |dir| {
            let git = git.clone();
            Box::pin(async move { eos_core::git::GitInfo::git_dirs(git.as_ref(), &dir).await })
        })
    };
    let candidates = Arc::new(CandidateCache::new(git.clone(), cx.clock.clone()));
    let bus = &cx.kernel.bus;
    let module = FsModule::new(
        cx.kernel.clone(),
        Ports {
            files: Arc::new(eos_fs::DiskFileSystem::new(host, cx.paths.trash_dir())),
            desktop: Arc::new(eos_fs::DesktopApps::new(host, cx.clock.clone(), cx.paths.join("icon-cache"))),
            // The shell hands its open panel over when it composes the app.
            picker: None,
            file_watcher: Arc::new(DirWatcher::new(cx.clock.clone(), fs_change_sink(bus.clone()))),
            git: git.clone(),
            git_diffs: git.clone(),
            tree: git.clone(),
            branches: git.clone(),
            remotes: git.clone(),
            git_watcher: Arc::new(RepoWatcher::new(
                resolve,
                cx.clock.clone(),
                git_change_sink(bus.clone()),
                host.native_recursive_watch(),
            )),
            candidates: candidates.clone(),
            symbols: Some(Arc::new(eos_symbols::TagIndex::new(candidates.clone()))),
            pdfjs_root: cx.pdfjs_root.clone(),
        },
    );
    cx.raw_routes.add(module.raw_routes());
    Arc::new(module)
}
