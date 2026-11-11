//! Chats and workers, read side (`manager/routes/workers.ts`,
//! `orchestrators.ts`, `prompt-events.ts`, `subagent-events.ts`,
//! `attachments.ts`).
//!
//! Lists and single rows, transcript pages, the three lists that cover a
//! whole conversation, and the messages waiting for a busy worker. Every route here only reads; starting, messaging,
//! renaming and removing workers are not registered yet.

mod events;
mod rows;

use std::sync::Arc;

use eos_core::agent::ModelCatalog;
use eos_core::store::Store;
use eos_runtime::module::Module;
use eos_runtime::router::RouteDef;

pub struct WorkersModule {
    store: Arc<dyn Store>,
    models: Arc<dyn ModelCatalog>,
}

impl std::fmt::Debug for WorkersModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkersModule").finish_non_exhaustive()
    }
}

impl WorkersModule {
    pub fn new(store: Arc<dyn Store>, models: Arc<dyn ModelCatalog>) -> Self {
        Self { store, models }
    }
}

impl Module for WorkersModule {
    fn id(&self) -> &'static str {
        "workers"
    }

    fn routes(&self) -> Vec<RouteDef> {
        let mut routes = rows::routes(self.store.clone(), self.models.clone());
        routes.extend(events::routes(self.store.clone()));
        routes
    }
}
