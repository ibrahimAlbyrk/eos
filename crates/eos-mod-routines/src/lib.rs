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
//!
//! The run engine (`engine`) starts runs ([`RunStarter`]), keeps them in a
//! queue and takes them out of it as slots free up. Each move of a run is
//! announced on `run:change`.

mod engine;
mod routes;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use eos_contracts::{RoutineChange, RunChange};
use eos_core::routine::RunStarter;
use eos_core::store::Store;
use eos_core::{BoxFuture, Clock, Ids, Sleeper};
use eos_runtime::bus::{Topic, TopicDecl};
use eos_runtime::module::{Module, ModuleError};
use eos_runtime::router::RouteDef;
use tokio::sync::Notify;

use crate::engine::Engine;

pub const ROUTINE_CHANGE: Topic<RoutineChange> = Topic::new("routine:change");
pub const RUN_CHANGE: Topic<RunChange> = Topic::new("run:change");

/// What the module is built from.
pub struct RoutinesParts {
    pub store: Arc<dyn Store>,
    pub clock: Arc<dyn Clock>,
    pub sleeper: Arc<dyn Sleeper>,
    pub ids: Arc<dyn Ids>,
    /// This computer's id.
    pub device: String,
    /// Whether runs nobody started by hand may leave the queue by
    /// themselves: true only in the installed app.
    pub autostart: bool,
}

impl std::fmt::Debug for RoutinesParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RoutinesParts").field("autostart", &self.autostart).finish_non_exhaustive()
    }
}

pub struct RoutinesModule {
    store: Arc<dyn Store>,
    clock: Arc<dyn Clock>,
    engine: Arc<Engine>,
}

impl std::fmt::Debug for RoutinesModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RoutinesModule").finish_non_exhaustive()
    }
}

impl RoutinesModule {
    pub fn new(parts: RoutinesParts) -> Self {
        let RoutinesParts { store, clock, sleeper, ids, device, autostart } = parts;
        let engine = Arc::new(Engine {
            store: store.clone(),
            clock: clock.clone(),
            sleeper,
            ids,
            device,
            autostart,
            wake: Notify::new(),
            requests: Mutex::new(HashMap::new()),
            supervisor: Mutex::new(None),
        });
        Self { store, clock, engine }
    }

    /// Starts and stops runs.
    pub fn runs(&self) -> Arc<dyn RunStarter> {
        Arc::new(engine::Runs(self.engine.clone()))
    }
}

impl Module for RoutinesModule {
    fn id(&self) -> &'static str {
        "routines"
    }

    fn topics(&self) -> Vec<TopicDecl> {
        vec![ROUTINE_CHANGE.decl(), RUN_CHANGE.decl()]
    }

    fn routes(&self) -> Vec<RouteDef> {
        routes::all(&self.store, &self.clock)
    }

    fn after_ready(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        engine::start_supervisor(&self.engine);
        Box::pin(std::future::ready(Ok(())))
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        engine::stop_supervisor(&self.engine);
        Box::pin(std::future::ready(()))
    }
}
