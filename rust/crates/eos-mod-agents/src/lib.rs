//! Starting agents and acting on them: the write side of the chat and worker
//! routes (`manager/routes/workers.ts`, `orchestrators.ts`,
//! `manager/commands/handlers/*-worker.ts`).
//!
//! Every route here is a thin wrapper over [`eos_sessions::Sessions`]: it
//! reads the request, calls the use-case and answers in today's shape. The
//! read side of the same routes is `eos-mod-workers`.

mod routes;
mod spawn;

use std::sync::Arc;

use eos_core::Ids;
use eos_core::store::Store;
use eos_runtime::module::Module;
use eos_runtime::router::RouteDef;
use eos_sessions::Sessions;
use eos_workers::WorkerDefinitions;

/// What the routes are built from.
#[derive(Clone)]
pub struct AgentsModule {
    sessions: Sessions,
    store: Arc<dyn Store>,
    ids: Arc<dyn Ids>,
    definitions: Arc<WorkerDefinitions>,
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
    ) -> Self {
        Self { sessions, store, ids, definitions }
    }
}

impl Module for AgentsModule {
    fn id(&self) -> &'static str {
        "agents"
    }

    fn routes(&self) -> Vec<RouteDef> {
        let mut all = routes::all(self);
        all.extend(spawn::all(self));
        all
    }
}
