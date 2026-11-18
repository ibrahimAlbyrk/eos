//! Routines: what Eos does again and again for the user, each from a
//! blueprint kept in versions (`eos_contracts::routine`, its rules in
//! `eos_domain::routine`). These are the dashboard's reads:
//!
//! - `GET /api/routines`: one row per routine, built-in ones left out. A
//!   fresh home answers an empty list, which tells the dashboard the core
//!   serves routines at all;
//! - `GET /api/routines/:id`: the routine, its head version, the draft its
//!   architect works on and its recent runs;
//! - `GET /api/routines/:id/versions` and `…/versions/:versionId`: its
//!   versions, numbered by when they were made, and one with its blueprint.
//!
//! They return the user's routine text, so only the user's dashboard reads
//! them, and the phone the first two. A change to a routine is announced on
//! `routine:change` from the write job that made it.

mod routes;

use std::sync::Arc;

use eos_contracts::RoutineChange;
use eos_core::Clock;
use eos_core::store::Store;
use eos_runtime::bus::{Topic, TopicDecl};
use eos_runtime::module::Module;
use eos_runtime::router::RouteDef;

pub const ROUTINE_CHANGE: Topic<RoutineChange> = Topic::new("routine:change");

pub struct RoutinesModule {
    store: Arc<dyn Store>,
    clock: Arc<dyn Clock>,
}

impl std::fmt::Debug for RoutinesModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RoutinesModule").finish_non_exhaustive()
    }
}

impl RoutinesModule {
    pub fn new(store: Arc<dyn Store>, clock: Arc<dyn Clock>) -> Self {
        Self { store, clock }
    }
}

impl Module for RoutinesModule {
    fn id(&self) -> &'static str {
        "routines"
    }

    fn topics(&self) -> Vec<TopicDecl> {
        vec![ROUTINE_CHANGE.decl()]
    }

    fn routes(&self) -> Vec<RouteDef> {
        routes::all(&self.store, &self.clock)
    }
}
