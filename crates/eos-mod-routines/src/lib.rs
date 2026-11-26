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
//! resume). It may call every action of what its version needs, its
//! checker only the `read` ones; each that reaches past this computer
//! passes the gate under the routine's Freedom first
//! ([`RoutinesModule::grants`]).
//!
//! The lead starts with the notes memory recalls for its item
//! ([`ExperiencePacks`]); memory hears how each run ended and each routine
//! that left for good ([`ExperienceFeedback`]). A
//! routine that makes a view, a page or an app takes its surface through its
//! life ([`SurfaceAuthoring`]). Its surface's buttons run it again, run it
//! on an item and open a run, and its live parts read how it stands and its
//! last runs, through the direct-action registry.
//!
//! A handed-in result that fits what the routine makes goes straight to the
//! gate ([`RunGate`], Needs you's) in the run's own write; one that does not
//! is refused to the lead with what to fix. Needs you reports
//! what became of it through [`RunOutcomes`].
//!
//! A run from a trigger of a routine whose confirmed rung is Ask waits in
//! the queue on a `run_start` item until the user says run or skip. The
//! user's answers to the routines' items (`run_start`, `confirm_change`,
//! `suggestion`, and a `question` whose asker is gone) are acted on at start
//! and on `inbox:change`, each in a write job that marks it consumed.
//!
//! What each of a run's agents is doing goes out on `run:activity`, one
//! line a second per run at most, to the tabs that show the run.
//!
//! Once a night (`suggest`) the user's first requests of recent chats may
//! bring one suggestion of a routine for work they repeat by hand.
//!
//! Once a day (`retention`) old runs, their agents' transcripts and the
//! routines that leave for good are cleared; what they leave on disk goes to
//! the trash.
//!
//! Routines with their kept versions, and a summary of each finished run
//! for 30 days, follow the user to their other computers (`sync`).
//!
//! A sentence the user wants done once becomes a one-off routine and its
//! run (`POST /api/runs/once`, `once`).
//!
//! Memory checks a rewritten playbook by replaying past runs' items with it
//! ([`RunReplays`], `replay`): trials that show their results only.
//!
//! The run routes start runs by hand (`POST /api/runs`), estimate them
//! (`POST /api/runs/estimate`), list and show them (`GET /api/runs`,
//! `…/:id`, `…/:id/result`, `…/:id/events`), steer them (`…/:id/message`,
//! `stop`, `pause`, `resume`), offer what a routine may run on
//! (`GET /api/routines/:id/candidates`) and name the run a worker works for
//! (`GET /api/run-agents/:workerId`).

mod actions;
mod architect;
mod chat;
mod design_first;
mod engine;
mod intent;
mod once;
mod patterns;
mod replay;
mod retention;
mod routes;
mod suggest;
mod sync;
mod trial;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use eos_contracts::{RoutineChange, RunActivity, RunChange, RunsActive};
use eos_core::accounts::SessionCredentials;
use eos_core::agent::{LaunchSpec, OneShot, ScratchFolders};
use eos_core::capability::{CapabilityGrants, CapabilityReads};
use eos_core::experience::{ExperienceFeedback, ExperiencePacks};
use eos_core::git::{ProjectKeys, RemoteSync};
use eos_core::net::sync::RecordSync;
use eos_core::os::{FileSystem, Power, TimeZone, ZoneRules};
use eos_core::policy::KeptScripts;
use eos_core::routine::{
    ArchitectTools, BuiltinRoutines, ChatRoutines, RoutineControl, RoutineDirectory, RoutineTools, RunFolders, RunGate,
    RunIntake, RunLookup, RunOutcomes, RunReplays, RunStarter, SystemSteps,
};
use eos_core::store::{ConfigSource, Store, UserSettingsStore};
use eos_core::surface::SurfaceAuthoring;
use eos_core::{BoxFuture, Clock, Ids, Sleeper};
use eos_prompts::PromptService;
use eos_runtime::actions::{ActionDecl, QueryDecl};
use eos_runtime::bus::{Bus, ScopeKind, Topic, TopicDecl};
use eos_runtime::idle::IdleHook;
use eos_runtime::module::{Module, ModuleError, Opaque, ProtectedSettings, SlashCommandDecl, SyncContribution};
use eos_runtime::router::RouteDef;
use eos_sessions::{Sessions, SlashCommand};
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
    /// Whether Eos may call the model when nobody asked (the night's
    /// suggestion read): true only in the installed app, as it spends the
    /// user's plan.
    pub background_model_calls: bool,
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
    /// `settings.json`, which holds the settings for all routines.
    pub settings: Arc<dyn UserSettingsStore>,
    /// The small model that reads what a sentence typed at Home asks for.
    pub one_shot: Arc<dyn OneShot>,
    /// The credential a new session would start on: a run without one fails
    /// at once (01 G27).
    pub credentials: Arc<dyn SessionCredentials>,
    /// The power source: runs from triggers wait on a low battery.
    pub power: Arc<dyn Power>,
    /// Where the history retention clears goes (run folders, a deleted
    /// routine's export): the trash; also the listing of a folder trigger's
    /// folder when its version is saved. Nothing else of the files port.
    pub trash: Arc<dyn FileSystem>,
    /// The notes a run's lead starts with.
    pub packs: Arc<dyn ExperiencePacks>,
    /// What memory hears of runs and routines.
    pub feedback: Arc<dyn ExperienceFeedback>,
    /// The surfaces of routines that make a view, a page or an app.
    pub surfaces: Arc<dyn SurfaceAuthoring>,
    /// The steps the features that own built-in routines run.
    pub system_steps: Arc<dyn SystemSteps>,
}

impl std::fmt::Debug for RoutinesParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RoutinesParts")
            .field("autostart", &self.autostart)
            .field("background_model_calls", &self.background_model_calls)
            .finish_non_exhaustive()
    }
}

pub struct RoutinesModule {
    engine: Arc<Engine>,
    /// One for the module's life: the permission gateway holds it weakly.
    scripts: Arc<dyn KeptScripts>,
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
            background_model_calls,
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
            one_shot,
            credentials,
            power,
            trash,
            packs,
            feedback,
            surfaces,
            system_steps,
        } = parts;
        let engine = Arc::new(Engine {
            store,
            clock,
            sleeper,
            ids,
            device,
            autostart,
            background_model_calls,
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
            starting: Mutex::new(std::collections::HashSet::new()),
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
            handoffs: Mutex::new(None),
            handing: tokio::sync::Mutex::new(()),
            power,
            zones,
            data_dir,
            zone,
            settings,
            meters: Mutex::new(HashMap::new()),
            usage: Mutex::new(None),
            architects: Mutex::new(HashMap::new()),
            one_shot,
            credentials,
            intent_reads: Mutex::new(None),
            trash,
            retention: Mutex::default(),
            suggest: Mutex::default(),
            packs,
            feedback,
            surfaces,
            system_steps,
        });
        let grants = Arc::new(engine::Grants(engine.clone()));
        let control = Arc::new(engine::Control(engine.clone()));
        let scripts = Arc::new(engine::Scripts(engine.clone()));
        Self { engine, scripts, grants, control }
    }

    /// What a script routine's lead may run through `Workflow` (01 G9, D52).
    pub fn scripts(&self) -> Arc<dyn KeptScripts> {
        self.scripts.clone()
    }

    /// Where a feature keeps its built-in routines (01 G49).
    pub fn builtins(&self) -> Arc<dyn BuiltinRoutines> {
        Arc::new(engine::Builtins(self.engine.clone()))
    }

    /// Starts and stops runs.
    pub fn runs(&self) -> Arc<dyn RunStarter> {
        Arc::new(engine::Runs(self.engine.clone()))
    }

    /// A build run's App reviewer, and its notes to the builder.
    pub fn app_reviews(&self) -> Arc<dyn eos_core::routine::AppReviews> {
        Arc::new(engine::AppReviews(self.engine.clone()))
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

    /// What capability actions a run session may call, and the gate its
    /// sends pass; none of its own outside runs.
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

    /// What a chat's agent does with routines.
    pub fn chat(&self) -> Arc<dyn ChatRoutines> {
        Arc::new(chat::Chat(self.engine.clone()))
    }

    /// What the tools of a run's sessions do.
    pub fn tools(&self) -> Arc<dyn RoutineTools> {
        Arc::new(engine::Tools(self.engine.clone()))
    }

    /// Replays past runs with a playbook candidate, for memory.
    pub fn replays(&self) -> Arc<dyn RunReplays> {
        Arc::new(replay::Replays(self.engine.clone()))
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

    fn direct_actions(&self) -> Vec<ActionDecl> {
        actions::declared(&self.engine)
    }

    fn surface_queries(&self) -> Vec<QueryDecl> {
        actions::queries(&self.engine)
    }

    fn protected_settings(&self) -> Option<ProtectedSettings> {
        Some(routes::protected_settings())
    }

    fn slash_commands(&self) -> Vec<SlashCommandDecl> {
        let command: Arc<dyn SlashCommand> = Arc::new(chat::RunCommand(self.engine.clone()));
        vec![SlashCommandDecl { name: "run", command: Arc::new(command) }]
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
            architect::rejoin(&self.engine).await?;
            engine::hear_answers(&self.engine).await;
            engine::start_supervisor(&self.engine);
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        Box::pin(engine::stop_supervisor(&self.engine))
    }

    /// Routines with their kept versions, and the summaries of finished
    /// runs; each handle is an `Arc<dyn RecordSync>`.
    fn sync(&self) -> Vec<SyncContribution> {
        let routines: Arc<dyn RecordSync> = Arc::new(sync::RoutineRecords(self.engine.clone()));
        let runs: Arc<dyn RecordSync> = Arc::new(sync::RunRecords(self.engine.clone()));
        let routines: Opaque = Arc::new(routines);
        let runs: Opaque = Arc::new(runs);
        vec![
            SyncContribution {
                domain: "routine",
                handle: routines,
                change_topic: Some(ROUTINE_CHANGE.name()),
                is_local: None,
            },
            SyncContribution { domain: "run", handle: runs, change_topic: Some(RUN_CHANGE.name()), is_local: None },
        ]
    }
}
