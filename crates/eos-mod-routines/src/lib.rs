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
//! announced on `run:change`, and a change in how many runs work or wait on
//! the user on `runs:active`. The signals' router admits runs through
//! [`RunIntake`]; other areas find a worker's run through [`RunLookup`] and
//! change a routine through [`RoutineControl`].
//!
//! A run that leaves the queue starts its lead at the brief station: a
//! focused session of a reserved definition (`eos-run-solo`) whose first
//! message is the run brief. The lead works with the run tools
//! ([`RoutineTools`]) and hands in its result, which waits at the check. A
//! lead that ends its turn without a result is reminded once
//! (`routine-lead-idle`); a lead whose session dies is resumed once.

mod engine;
mod routes;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use eos_contracts::{RoutineChange, RunChange, RunsActive};
use eos_core::agent::{LaunchSpec, ScratchFolders};
use eos_core::capability::{CapabilityGrants, CapabilityReads};
use eos_core::routine::{
    RoutineControl, RoutineDirectory, RoutineTools, RunFolders, RunGate, RunIntake, RunLookup, RunOutcomes, RunStarter,
};
use eos_core::store::Store;
use eos_core::{BoxFuture, Clock, Ids, Sleeper};
use eos_prompts::PromptService;
use eos_runtime::bus::{Topic, TopicDecl};
use eos_runtime::idle::IdleHook;
use eos_runtime::module::{Module, ModuleError};
use eos_runtime::router::RouteDef;
use eos_sessions::Sessions;
use tokio::sync::Notify;

use crate::engine::Engine;
pub use crate::engine::ShowOnlyGate;

pub const ROUTINE_CHANGE: Topic<RoutineChange> = Topic::new("routine:change");
pub const RUN_CHANGE: Topic<RunChange> = Topic::new("run:change");
pub const RUNS_ACTIVE: Topic<RunsActive> = Topic::new("runs:active");

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
    /// Where run sessions start and are messaged.
    pub sessions: Sessions,
    pub prompts: Arc<PromptService>,
    pub scratch: Arc<dyn ScratchFolders>,
    /// The runs' folders under the data folder's `routines`.
    pub folders: Arc<dyn RunFolders>,
    /// The capabilities there are: what a run session may call of them.
    pub reads: Arc<dyn CapabilityReads>,
    /// Where a checked result goes ([`ShowOnlyGate`] until Needs you's).
    pub gate: Arc<dyn RunGate>,
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
    /// One for the module's life: the capability service holds it weakly.
    grants: Arc<dyn CapabilityGrants>,
}

impl std::fmt::Debug for RoutinesModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RoutinesModule").finish_non_exhaustive()
    }
}

impl RoutinesModule {
    pub fn new(parts: RoutinesParts) -> Self {
        let RoutinesParts {
            store,
            clock,
            sleeper,
            ids,
            device,
            autostart,
            sessions,
            prompts,
            scratch,
            folders,
            reads,
            gate,
        } = parts;
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
            sessions,
            prompts,
            scratch,
            folders,
            progress: Mutex::new(HashMap::new()),
            launches: Mutex::new(HashMap::new()),
            held: Mutex::new(std::collections::HashSet::new()),
            gate,
            tasks: tokio::runtime::Handle::try_current().ok(),
            reads,
        });
        let grants = Arc::new(engine::Grants(engine.clone()));
        Self { store, clock, engine, grants }
    }

    /// Starts and stops runs.
    pub fn runs(&self) -> Arc<dyn RunStarter> {
        Arc::new(engine::Runs(self.engine.clone()))
    }

    /// Admits and counts triggered runs, inside the signals' own writes.
    pub fn intake(&self) -> Arc<dyn RunIntake> {
        Arc::new(engine::Intake(self.engine.clone()))
    }

    /// What starts each routine's runs.
    pub fn directory(&self) -> Arc<dyn RoutineDirectory> {
        Arc::new(engine::Directory(self.engine.clone()))
    }

    /// Which run a worker works for.
    pub fn lookup(&self) -> Arc<dyn RunLookup> {
        Arc::new(engine::Lookup(self.engine.clone()))
    }

    /// What other areas change of a routine: its Freedom and its state.
    pub fn control(&self) -> Arc<dyn RoutineControl> {
        Arc::new(engine::Control(self.engine.clone()))
    }

    /// What capability actions a run session may call; none of its own
    /// outside runs.
    pub fn grants(&self) -> Arc<dyn CapabilityGrants> {
        self.grants.clone()
    }

    /// What Needs you reports of a result after the gate.
    pub fn outcomes(&self) -> Arc<dyn RunOutcomes> {
        Arc::new(engine::Outcomes(self.engine.clone()))
    }

    /// What the tools of a run's sessions do.
    pub fn tools(&self) -> Arc<dyn RoutineTools> {
        Arc::new(engine::Tools(self.engine.clone()))
    }
}

impl Module for RoutinesModule {
    fn id(&self) -> &'static str {
        "routines"
    }

    fn topics(&self) -> Vec<TopicDecl> {
        vec![ROUTINE_CHANGE.decl(), RUN_CHANGE.decl(), RUNS_ACTIVE.decl()]
    }

    fn routes(&self) -> Vec<RouteDef> {
        routes::all(&self.store, &self.clock)
    }

    fn idle_hooks(&self) -> Vec<IdleHook> {
        vec![engine::lead_idle_hook(&self.engine)]
    }

    fn on_session_exit(&self, worker_id: &str) {
        engine::session_exited(&self.engine, worker_id);
    }

    fn holds_worker(&self, worker_id: &str) -> bool {
        engine::holds(&self.engine, worker_id)
    }

    fn shape_launch(&self, spec: &mut LaunchSpec) {
        engine::shape_launch(&self.engine, spec);
    }

    fn after_ready(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        Box::pin(async move {
            // Before any session of a run is resumed.
            engine::rebuild_launches(&self.engine).await?;
            engine::start_supervisor(&self.engine);
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        Box::pin(engine::stop_supervisor(&self.engine))
    }
}
