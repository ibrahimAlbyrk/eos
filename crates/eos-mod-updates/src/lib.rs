//! In-app updates: only a release build updates itself, from the signed feed, through
//! `~/.eos/updates` (regenerable).
//!
//! [`UpdateService`] is the feature; this module gives it its routes, its
//! topic, its line in the Jobs list and the two events it reacts to. What it
//! needs from outside arrives as ports (`eos_core::net::updates`): the feed,
//! the keys, the bundle indexer, the workspace, the system's bundle check, who
//! is still working, and the shell's hand-over to the applier. The shell in
//! turn holds the service as [`UpdateSignals`](eos_core::net::updates::UpdateSignals)
//! and says when its window shows or the computer wakes.

mod download;
mod jobs;
mod routes;
mod service;

use std::sync::{Arc, Mutex};

use eos_contracts::stream::topics;
use eos_contracts::update::UpdateState;
use eos_core::store::ConfigSource;
use eos_runtime::bus::{Bus, Subscription, TopicDecl};
use eos_runtime::jobs::JobRegistry;
use eos_runtime::module::{Module, ModuleError};
use eos_runtime::router::{BoxFuture, RouteDef};

pub use download::{Cancel, DownloadDeps, DownloadProgress, check_for_update, download_update};
pub use service::{CheckTrigger, UPDATE_CHANGE, UpdateDeps, UpdateService};

pub struct UpdatesModule {
    updates: Arc<UpdateService>,
    config: Arc<dyn ConfigSource>,
    bus: Bus,
    jobs: JobRegistry,
    listening: Mutex<Vec<Subscription>>,
}

impl std::fmt::Debug for UpdatesModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UpdatesModule").field("updates", &self.updates).finish_non_exhaustive()
    }
}

impl UpdatesModule {
    pub fn new(updates: Arc<UpdateService>, config: Arc<dyn ConfigSource>, bus: Bus, jobs: JobRegistry) -> Self {
        Self { updates, config, bus, jobs, listening: Mutex::new(Vec::new()) }
    }
}

impl Module for UpdatesModule {
    fn id(&self) -> &'static str {
        "updates"
    }

    fn routes(&self) -> Vec<RouteDef> {
        routes::all(&self.updates, &self.config)
    }

    fn topics(&self) -> Vec<TopicDecl> {
        vec![UPDATE_CHANGE.decl()]
    }

    fn job_kinds(&self) -> Vec<&'static str> {
        vec![jobs::JOB_KIND]
    }

    fn start(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        Box::pin(async move {
            let runtime = tokio::runtime::Handle::current();
            // A top-level agent starting or ending a turn may be what a
            // "restart when they finish" waits for.
            let updates = self.updates.clone();
            let agents = self.bus.on(topics::WORKER_CHANGE, move |_| {
                let updates = updates.clone();
                runtime.spawn(async move { updates.agents_changed().await });
            });
            // A download in progress shows in the Jobs list.
            let jobs = self.jobs.clone();
            let progress = self.bus.on(&UPDATE_CHANGE, move |event| {
                if let Ok(state) = event.payload_as::<UpdateState>() {
                    jobs::on_update(&jobs, &state);
                }
            });
            self.listening.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).extend([agents, progress]);
            // As today: a service that cannot start is reported, and the app goes on without it.
            if let Err(e) = self.updates.start().await {
                tracing::warn!(error = %e, "the update service failed to start");
            }
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            self.listening.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clear();
            self.updates.stop();
        })
    }
}
