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
//! focused session of a reserved definition (`eos-run-solo`, or
//! `eos-run-lead` for a team) whose first message is the run brief. A
//! team's lead starts its specialists, its own workers, with the team tools;
//! each agent works where its blueprint says (a scratch folder, the
//! repository, its own worktree or the lead's). The lead works with the run tools
//! ([`RoutineTools`]) and hands in its result. A lead that ends its turn
//! without a result is reminded once (`routine-lead-idle`); a lead whose
//! session dies is resumed once. Every run session starts in `AcceptEdits`
//! under 03's run scope, without the folder's MCP servers; one of a run that
//! reads outside text works in an empty folder of the run's own with its
//! workspace as a further root (`Module::shape_launch`, at every start and
//! resume). It may call the `read` and `write_local` actions of what its
//! version needs ([`RoutinesModule::grants`]).
//!
//! A handed-in result waits at the check while its lead is held: the rules,
//! then a checker session (`eos-run-checker`) when the routine asks for one.
//! A passed result goes to the gate ([`RunGate`], Needs you's) in the run's
//! own write; Needs you reports
//! what became of it through [`RunOutcomes`].
//!
//! What each of a run's agents is doing goes out on `run:activity`, one
//! line a second per run at most, to the tabs that show the run.
//!
//! The run routes start runs by hand (`POST /api/runs`), estimate them
//! (`POST /api/runs/estimate`), list and show them (`GET /api/runs`,
//! `…/:id`, `…/:id/result`, `…/:id/events`), steer them (`…/:id/message`,
//! `stop`, `pause`, `resume`), offer what a routine may run on
//! (`GET /api/routines/:id/candidates`) and name the run a worker works for
//! (`GET /api/run-agents/:workerId`).

mod architect;
mod engine;
mod intent;
mod patterns;
mod routes;
mod trial;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use eos_contracts::{RoutineChange, RunActivity, RunChange, RunsActive};
use eos_core::agent::{LaunchSpec, OneShot, ScratchFolders};
use eos_core::capability::{CapabilityGrants, CapabilityReads};
use eos_core::git::{ProjectKeys, RemoteSync};
use eos_core::os::{Power, TimeZone, ZoneRules};
use eos_core::routine::{
    ArchitectTools, PlanHeadroom, RoutineControl, RoutineDirectory, RoutineTools, RunFolders, RunGate, RunIntake,
    RunLookup, RunOutcomes, RunStarter,
};
use eos_core::store::{ConfigSource, Store, UserSettingsStore};
use eos_core::{BoxFuture, Clock, Ids, Sleeper};
use eos_prompts::PromptService;
use eos_runtime::bus::{Bus, ScopeKind, Topic, TopicDecl};
use eos_runtime::idle::IdleHook;
use eos_runtime::module::{Module, ModuleError, ProtectedSettings};
use eos_runtime::router::RouteDef;
use eos_sessions::Sessions;
use tokio::sync::Notify;

use crate::engine::Engine;

pub const ROUTINE_CHANGE: Topic<RoutineChange> = Topic::new("routine:change");
pub const RUN_CHANGE: Topic<RunChange> = Topic::new("run:change");
pub const RUNS_ACTIVE: Topic<RunsActive> = Topic::new("runs:active");
pub const RUN_ACTIVITY: Topic<RunActivity> =
    Topic::scoped("run:activity", ScopeKind::Run, |activity| Some(activity.run_id.as_str()));

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
    /// Eos's data folder, which no folder trigger may watch.
    pub data_dir: PathBuf,
    /// The capabilities there are: what a run session may call of them.
    pub reads: Arc<dyn CapabilityReads>,
    /// Where a checked result goes: Needs you's gate.
    pub gate: Arc<dyn RunGate>,
    /// Model prices, for what a run will likely cost.
    pub config: Arc<dyn ConfigSource>,
    /// Where the user's clone of an item's repository is.
    pub keys: Arc<dyn ProjectKeys>,
    /// Fetches a pull request's head into that clone, with the user's git.
    pub remotes: Arc<dyn RemoteSync>,
    /// Where what a run's agents do goes out (`run:activity`).
    pub bus: Bus,
    /// The time zones the system knows, for a blueprint's schedules.
    pub zones: Arc<dyn ZoneRules>,
    /// The user's clock, for the local day spend is booked on.
    pub zone: Arc<dyn TimeZone>,
    /// `settings.json`, which holds the budgets for all routines.
    pub settings: Arc<dyn UserSettingsStore>,
    /// Whether the user's plan has room for runs from triggers.
    pub headroom: Arc<dyn PlanHeadroom>,
    /// The small model that reads what a sentence typed at Home asks for.
    pub one_shot: Arc<dyn OneShot>,
    /// The power source: runs from triggers wait on a low battery.
    pub power: Arc<dyn Power>,
}

impl std::fmt::Debug for RoutinesParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RoutinesParts").field("autostart", &self.autostart).finish_non_exhaustive()
    }
}

pub struct RoutinesModule {
    engine: Arc<Engine>,
    /// One for the module's life: the capability service holds it weakly.
    grants: Arc<dyn CapabilityGrants>,
    /// One for the module's life: the gate holds it weakly.
    control: Arc<dyn RoutineControl>,
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
            data_dir,
            reads,
            gate,
            config,
            keys,
            remotes,
            bus,
            zones,
            zone,
            settings,
            headroom,
            one_shot,
            power,
        } = parts;
        let engine = Arc::new(Engine {
            store,
            clock,
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
            config,
            tasks: tokio::runtime::Handle::try_current().ok(),
            patterns: Arc::new(patterns::ItemPatterns::new(reads.clone())),
            reads,
            keys,
            remotes,
            reports: Mutex::new(HashMap::new()),
            bus,
            activity: Mutex::new(HashMap::new()),
            ended: Mutex::new(None),
            halt: Mutex::new(None),
            power,
            zones,
            data_dir,
            zone,
            settings,
            headroom,
            meters: Mutex::new(HashMap::new()),
            usage: Mutex::new(None),
            architects: Mutex::new(HashMap::new()),
            one_shot,
            intent_reads: Mutex::new(None),
        });
        let grants = Arc::new(engine::Grants(engine.clone()));
        let control = Arc::new(engine::Control(engine.clone()));
        Self { engine, grants, control }
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
        self.control.clone()
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

    /// What the tools of a routine's architect do.
    pub fn architect(&self) -> Arc<dyn ArchitectTools> {
        Arc::new(architect::Architect(self.engine.clone()))
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
        vec![ROUTINE_CHANGE.decl(), RUN_CHANGE.decl(), RUNS_ACTIVE.decl(), RUN_ACTIVITY.decl()]
    }

    fn routes(&self) -> Vec<RouteDef> {
        routes::all(&self.engine)
    }

    fn protected_settings(&self) -> Option<ProtectedSettings> {
        Some(routes::protected_settings())
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

    fn on_agent_event(&self, worker_id: &str, event: &eos_contracts::AgentEvent) {
        engine::agent_event(&self.engine, worker_id, event);
        architect::touch(&self.engine, worker_id);
    }

    fn shape_report(&self, worker_id: &str, text: &mut String) {
        engine::shape_report(&self.engine, worker_id, text);
    }

    fn after_ready(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        Box::pin(async move {
            // Before any session of a run is resumed.
            engine::rebuild_launches(&self.engine).await?;
            self.engine.patterns.refresh().await;
            engine::end_sessions_of_ended_runs(&self.engine);
            engine::watch_usage(&self.engine);
            // A halt switched on before Eos quit ends the runs it would pick up.
            engine::hear_halt(&self.engine).await?;
            engine::recover(&self.engine).await?;
            engine::start_supervisor(&self.engine);
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        Box::pin(engine::stop_supervisor(&self.engine))
    }
}
