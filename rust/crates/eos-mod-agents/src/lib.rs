//! Starting agents and acting on them: the write side of the chat and worker
//! routes (`manager/routes/workers.ts`, `orchestrators.ts`,
//! `manager/commands/handlers/*-worker.ts`).
//!
//! Every route here is a thin wrapper over [`eos_sessions::Sessions`]: it
//! reads the request, calls the use-case and answers in today's shape. The
//! read side of the same routes is `eos-mod-workers`.
//!
//! The routes over a worker's folder (diff, changes, push, pull, Try,
//! conflicts, integrating an orchestrator's workers) are in `git`.
//!
//! The module also runs what happens around agents by itself (`watch`): idle
//! chats are parked, a finished turn fires a banner, the report reminder and
//! the context threshold run at the idle edge, the active workers' folders
//! are watched, archived chats past their retention are purged, and quitting
//! parks every live chat.

mod archive;
mod collab;
mod git;
mod nudge;
mod routes;
mod spawn;
mod tool_control;
mod watch;

pub use git::WorkerGit;
pub use tool_control::ToolControl;

use std::sync::{Arc, Mutex};

use eos_core::BoxFuture;
use eos_core::Ids;
use eos_core::agent::ScratchFolders;
use eos_core::store::{ConfigSource, Store, UserSettingsStore};
use eos_prompts::PromptService;
use eos_runtime::idle::IdleHook;
use eos_runtime::module::{Module, ModuleError};
use eos_runtime::router::RouteDef;
use eos_sessions::Sessions;
use eos_workers::WorkerDefinitions;
use tokio::task::JoinHandle;

pub use spawn::SpawnedWorker;
pub use watch::Watch;

/// What the routes are built from.
#[derive(Clone)]
pub struct AgentsModule {
    sessions: Sessions,
    store: Arc<dyn Store>,
    ids: Arc<dyn Ids>,
    definitions: Arc<WorkerDefinitions>,
    spawning: Spawning,
    git: WorkerGit,
    /// Purge archived chats past their retention without being asked.
    sweeps_archives: bool,
    /// The watchers around agents; none in a module built without them.
    watch: Option<Watch>,
    watching: Arc<watch::Watching>,
    /// What runs beside the routes while the app is up.
    background: Arc<Mutex<Vec<JoinHandle<()>>>>,
}

/// What starting an agent reads besides the request: the user's settings and
/// configuration, the prompt library, where scratch folders are made.
#[derive(Clone)]
pub struct Spawning {
    pub config: Arc<dyn ConfigSource>,
    pub settings: Arc<dyn UserSettingsStore>,
    pub prompts: Arc<PromptService>,
    pub scratch: Arc<dyn ScratchFolders>,
}

impl std::fmt::Debug for Spawning {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Spawning").finish_non_exhaustive()
    }
}

impl std::fmt::Debug for AgentsModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentsModule").finish_non_exhaustive()
    }
}

impl AgentsModule {
    pub fn new(
        sessions: Sessions,
        store: Arc<dyn Store>,
        ids: Arc<dyn Ids>,
        definitions: Arc<WorkerDefinitions>,
        spawning: Spawning,
        git: WorkerGit,
    ) -> Self {
        Self {
            sessions,
            store,
            ids,
            definitions,
            spawning,
            git,
            sweeps_archives: false,
            watch: None,
            watching: Arc::default(),
            background: Arc::default(),
        }
    }

    /// Purges archived chats past their retention, at start and every hour.
    /// A purge deletes a chat's worktree in the user's repository, so only an
    /// app on the user's own data folder does it on its own.
    pub fn sweeping_archives(mut self, on: bool) -> Self {
        self.sweeps_archives = on;
        self
    }

    /// Turns on what happens around agents by itself: idle chats are parked,
    /// finished turns fire a banner, workers are reminded to report, a full
    /// context is reported, the active workers' folders are watched.
    pub fn watching(mut self, watch: Watch) -> Self {
        self.watch = Some(watch);
        self
    }
}

impl Module for AgentsModule {
    fn id(&self) -> &'static str {
        "agents"
    }

    fn routes(&self) -> Vec<RouteDef> {
        let mut all = routes::all(self);
        all.extend(spawn::all(self));
        all.extend(archive::all(self));
        all.extend(collab::all(self));
        all.extend(nudge::all(self));
        all.extend(git::all(self));
        all
    }

    fn idle_hooks(&self) -> Vec<IdleHook> {
        self.watch_hooks()
    }

    fn start(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        Box::pin(async move {
            self.start_watching();
            if self.sweeps_archives {
                let sweep = tokio::spawn(archive::sweep(self.clone()));
                self.background.lock().unwrap_or_else(|p| p.into_inner()).push(sweep);
            }
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            self.stop_watching();
            for task in self.background.lock().unwrap_or_else(|p| p.into_inner()).drain(..) {
                task.abort();
            }
            // Nothing runs on its own after a quit: every live session is closed and its chat
            // parked, to be continued when the user writes to it.
            let parked = self.sessions.suspend_all("daemon_shutdown").await;
            if parked > 0 {
                tracing::info!(parked, "live chats parked at shutdown");
            }
        })
    }
}
