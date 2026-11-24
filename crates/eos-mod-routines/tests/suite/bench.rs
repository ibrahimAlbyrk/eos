//! A routines module over a fresh store, a fake clock and sleeper, the
//! session service on a scripted runtime, and the routines a test seeds.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use eos_contracts::{ItemRef, ResultMode, RoutineKind, RoutineState, RunInput, VersionAuthor, VersionStatus};
use eos_core::Ids;
use eos_core::git::ProjectKeys;
use eos_core::routine::RunGate;
use eos_core::routine::{NewRun, RunCreated, RunOrigin, RunStarter, StartError};
use eos_core::store::{StoredRoutine, StoredRun, StoredVersion};
use eos_domain::routine::blueprint::{Readable, canonical_json, hash, read};
use eos_domain::routine::run::RunState;
use eos_domain::run_scope::Trust;
use eos_mod_routines::{RoutinesModule, RoutinesParts};
use eos_prompts::tool_names::tool_name_vars;
use eos_prompts::{PromptRegistry, PromptService};
use eos_runtime::bus::{Bus, BusOptions};
use eos_runtime::idle::IdleHooks;
use eos_runtime::module::Module;
use eos_runtime::ordered::Ordered;
use eos_sessions::{SessionDeps, SessionHooks, Sessions};
use eos_store_files::prompts::LibraryPromptSource;
use eos_store_files::run_folders::FsRunFolders;
use eos_testkit::{
    FakeCapabilityReads, FakeClock, FakeConfig, FakeExperienceFeedback, FakeExperiencePacks, FakeModelCatalog,
    FakePower, FakePrompts, FakeRecents, FakeRunGate, FakeScratch, FakeSettings, FakeSleeper, FakeSurfaceAuthoring,
    FakeTimeZone, FakeTrash, FakeWorktrees, FakeZoneRules, ScriptedOneShot, ScriptedRuntime, SeqIds, TempStore,
};
use serde_json::{Value, json};

pub(crate) const HOUR: i64 = 60 * 60 * 1000;

pub(crate) struct Bench {
    pub(crate) module: Arc<RoutinesModule>,
    pub(crate) runs: Arc<dyn RunStarter>,
    pub(crate) temp: TempStore,
    pub(crate) clock: Arc<FakeClock>,
    pub(crate) sleeper: Arc<FakeSleeper>,
    /// Shared with the module, so the rows a test writes and the module's never share an id.
    pub(crate) ids: Arc<SeqIds>,
    /// The agents the runs start.
    pub(crate) agents: ScriptedRuntime,
    pub(crate) sessions: Sessions,
    pub(crate) hooks: Arc<Hooks>,
    pub(crate) recents: Arc<FakeRecents>,
    pub(crate) reads: Arc<FakeCapabilityReads>,
    /// The gate the module hands results to: `fake` unless a test asks for
    /// the module's own.
    pub(crate) gate: Arc<FakeRunGate>,
    gate_port: Arc<dyn RunGate>,
    autostart: bool,
    /// The user's clones, by project key.
    pub(crate) keys: Arc<FakeKeys>,
    /// The worktrees the sessions made.
    pub(crate) worktrees: Arc<FakeWorktrees>,
    /// Where the module publishes what is not written (activity lines).
    pub(crate) bus: Bus,
    /// `settings.json`.
    pub(crate) settings: Arc<FakeSettings>,
    /// Whether the plan is near its five-hour limit.
    pub(crate) plan: Arc<FakePlan>,
    /// The small model the Home input's model read asks.
    pub(crate) model: Arc<ScriptedOneShot>,
    /// The power source: mains until a test sets it.
    pub(crate) power: Arc<FakePower>,
    /// Where retention moves what it clears.
    pub(crate) trash: Arc<FakeTrash>,
    /// Memory: the packs leads start with, and what it heard.
    pub(crate) packs: Arc<FakeExperiencePacks>,
    pub(crate) feedback: Arc<FakeExperienceFeedback>,
    /// What routines asked of their surfaces.
    pub(crate) surfaces: Arc<FakeSurfaceAuthoring>,
    /// The system steps of built-in routines.
    pub(crate) steps: Arc<FakeSteps>,
}

/// System steps a test scripts: each call answers the next result, or
/// fails its run when none is left.
#[derive(Default)]
pub(crate) struct FakeSteps {
    results: std::sync::Mutex<std::collections::VecDeque<eos_core::routine::StepResult>>,
    calls: std::sync::Mutex<Vec<eos_core::routine::SystemStepCall>>,
}

impl FakeSteps {
    pub(crate) fn answer(&self, result: eos_core::routine::StepResult) {
        self.results.lock().expect("results").push_back(result);
    }

    pub(crate) fn calls(&self) -> Vec<eos_core::routine::SystemStepCall> {
        self.calls.lock().expect("calls").clone()
    }
}

impl eos_core::routine::SystemSteps for FakeSteps {
    fn run(
        &self,
        call: eos_core::routine::SystemStepCall,
    ) -> eos_core::BoxFuture<'_, Result<eos_core::routine::StepResult, eos_core::Error>> {
        self.calls.lock().expect("calls").push(call);
        let next = self.results.lock().expect("results").pop_front();
        let result = next.unwrap_or(eos_core::routine::StepResult::Failed { reason: "no step scripted".into() });
        Box::pin(std::future::ready(Ok(result)))
    }
}

/// A plan whose five-hour window a test fills.
#[derive(Default)]
pub(crate) struct FakePlan(AtomicBool);

impl FakePlan {
    pub(crate) fn set_busy(&self, busy: bool) {
        self.0.store(busy, Ordering::SeqCst);
    }
}

impl eos_core::routine::PlanHeadroom for FakePlan {
    fn busy(&self, _percent: i64) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// The user's clones, by the key of their remote.
#[derive(Default)]
pub(crate) struct FakeKeys(std::sync::Mutex<std::collections::HashMap<String, String>>);

impl FakeKeys {
    pub(crate) fn clone_at(&self, key: &str, path: &str) {
        self.0.lock().expect("keys").insert(key.into(), path.into());
    }

    /// The clone is no project any more.
    pub(crate) fn forget(&self, key: &str) {
        self.0.lock().expect("keys").remove(key);
    }
}

impl ProjectKeys for FakeKeys {
    fn to_key<'a>(&'a self, path: &'a str) -> eos_core::BoxFuture<'a, String> {
        Box::pin(std::future::ready(format!("path:{path}")))
    }

    fn to_path<'a>(&'a self, _key: &'a str, hint: &'a str) -> eos_core::BoxFuture<'a, String> {
        Box::pin(std::future::ready(hint.to_owned()))
    }

    fn find_path<'a>(&'a self, key: &'a str) -> eos_core::BoxFuture<'a, Option<String>> {
        Box::pin(std::future::ready(self.0.lock().expect("keys").get(key).cloned()))
    }
}

/// The app's hooks around sessions, as far as routines hear them: a
/// session's exit, and its idle edge once a test turns that on.
#[derive(Default)]
pub(crate) struct Hooks {
    module: OnceLock<Weak<RoutinesModule>>,
    pub(crate) idle: AtomicBool,
}

impl Hooks {
    fn module(&self) -> Option<Arc<RoutinesModule>> {
        self.module.get().and_then(Weak::upgrade)
    }
}

impl SessionHooks for Hooks {
    fn exited(&self, worker_id: &str) {
        if let Some(module) = self.module() {
            module.on_session_exit(worker_id);
        }
    }

    fn holds_worker(&self, worker_id: &str) -> bool {
        self.module().is_some_and(|module| module.holds_worker(worker_id))
    }

    fn shape_launch(&self, spec: &mut eos_core::agent::LaunchSpec) {
        if let Some(module) = self.module() {
            module.shape_launch(spec);
        }
    }

    fn agent_event(&self, worker_id: &str, event: &eos_contracts::AgentEvent) {
        if let Some(module) = self.module() {
            module.on_agent_event(worker_id, event);
        }
    }

    fn shape_report(&self, worker_id: &str, text: &mut String) {
        if let Some(module) = self.module() {
            module.shape_report(worker_id, text);
        }
    }

    fn idle(&self, worker_id: &str) {
        if let Some(module) = self.module().filter(|_| self.idle.load(Ordering::SeqCst)) {
            let id = worker_id.to_owned();
            tokio::spawn(async move { IdleHooks::new(module.idle_hooks()).run(&id).await });
        }
    }
}

impl Bench {
    pub(crate) fn new(autostart: bool) -> Self {
        Self::with_reads(autostart, FakeCapabilityReads::new())
    }

    /// With the capabilities `reads` lists.
    pub(crate) fn with_reads(autostart: bool, reads: FakeCapabilityReads) -> Self {
        let gate = Arc::new(FakeRunGate::new());
        Self::with(autostart, reads, gate.clone(), gate)
    }

    fn with(autostart: bool, reads: FakeCapabilityReads, gate: Arc<FakeRunGate>, gate_port: Arc<dyn RunGate>) -> Self {
        let bus = Bus::new(Ordered::new(), Arc::new(FakeClock::new()), BusOptions { delta_window: None });
        let temp = TempStore::on_bus(&bus);
        let worktrees = Arc::new(FakeWorktrees::default());
        let (clock, sleeper) = (Arc::new(FakeClock::new()), Arc::new(FakeSleeper::default()));
        let (agents, hooks, recents) =
            (ScriptedRuntime::new(), Arc::new(Hooks::default()), Arc::new(FakeRecents::default()));
        let sessions = Sessions::new(SessionDeps {
            store: temp.port(),
            runtime: agents.port(),
            clock: clock.clone(),
            ids: Arc::new(SeqIds::new()),
            config: Arc::new(FakeConfig::default()),
            models: Arc::new(FakeModelCatalog::default()),
            prompts: Arc::new(FakePrompts::default()),
            worktrees: worktrees.clone(),
            recents: recents.clone(),
            hooks: hooks.clone(),
            sleeper: Arc::new(FakeSleeper::default()),
        });
        let reads = Arc::new(reads);
        let keys = Arc::new(FakeKeys::default());
        let (settings, ids, plan) =
            (Arc::new(FakeSettings::default()), Arc::new(SeqIds::new()), Arc::new(FakePlan::default()));
        let (model, power) = (Arc::new(ScriptedOneShot::default()), Arc::new(FakePower::default()));
        let trash = Arc::new(FakeTrash::new(temp.home.path().join("trash")));
        let steps = Arc::new(FakeSteps::default());
        let (packs, feedback, surfaces) = (
            Arc::new(FakeExperiencePacks::new()),
            Arc::new(FakeExperienceFeedback::new()),
            Arc::new(FakeSurfaceAuthoring::new()),
        );
        let parts = Shared {
            gate: &gate_port,
            keys: &keys,
            bus: &bus,
            settings: &settings,
            ids: &ids,
            plan: &plan,
            model: &model,
            power: &power,
            trash: &trash,
            packs: &packs,
            feedback: &feedback,
            surfaces: &surfaces,
            steps: &steps,
        };
        let module = module(&temp, &clock, &sleeper, &sessions, &reads, parts, autostart);
        let _ = hooks.module.set(Arc::downgrade(&module));
        let runs = module.runs();
        Self {
            module,
            runs,
            temp,
            clock,
            sleeper,
            ids,
            agents,
            sessions,
            hooks,
            recents,
            reads,
            gate,
            gate_port,
            autostart,
            keys,
            worktrees,
            bus,
            settings,
            plan,
            model,
            power,
            trash,
            packs,
            feedback,
            surfaces,
            steps,
        }
    }

    /// A second module over the same store, sessions and folders: the app
    /// as it comes back after a restart.
    pub(crate) fn another_module(&self) -> Arc<RoutinesModule> {
        let (temp, clock, sleeper, sessions, reads) =
            (&self.temp, &self.clock, &self.sleeper, &self.sessions, &self.reads);
        let parts = Shared {
            gate: &self.gate_port,
            keys: &self.keys,
            bus: &self.bus,
            settings: &self.settings,
            ids: &self.ids,
            plan: &self.plan,
            model: &self.model,
            power: &self.power,
            trash: &self.trash,
            packs: &self.packs,
            feedback: &self.feedback,
            surfaces: &self.surfaces,
            steps: &self.steps,
        };
        module(temp, clock, sleeper, sessions, reads, parts, self.autostart)
    }

    /// Starts the supervisor.
    pub(crate) async fn supervise(&self) {
        self.module.after_ready().await.expect("starts");
    }

    /// A routine in `state` whose head is one kept version of `blueprint`.
    pub(crate) fn routine(&self, state: RoutineState, blueprint: Value) -> String {
        self.routine_with(state, blueprint, false)
    }

    pub(crate) fn routine_with(&self, state: RoutineState, blueprint: Value, agents_may_start: bool) -> String {
        let id = self.ids.routine_id();
        let Ok(Readable::Current(typed)) = read(&blueprint) else { panic!("a blueprint of this app") };
        let text = canonical_json(&typed);
        let version = StoredVersion {
            id: self.ids.routine_version_id(),
            routine_id: id.clone(),
            parent_id: None,
            status: if state == RoutineState::Draft { VersionStatus::Draft } else { VersionStatus::Kept },
            author: VersionAuthor::User,
            note: None,
            format: 1,
            hash: hash(&text),
            blueprint: text,
            no_trial: false,
            trust: Trust::Trusted,
            device: None,
            created_at: 1,
        };
        let routine = StoredRoutine {
            id: id.clone(),
            slug: id.clone(),
            name: "PR Review".into(),
            kind: RoutineKind::Standing,
            state,
            paused_reason: None,
            head_version_id: (state != RoutineState::Draft).then(|| version.id.clone()),
            origin: "hand".into(),
            task_key: None,
            agents_may_start,
            failure_streak: 0,
            created_at: 1,
            updated_at: 1,
            changed_at: 1,
            started_at: None,
            deleted_at: None,
        };
        self.temp
            .store
            .write_blocking(move |tx, _| {
                tx.routines().insert(&routine)?;
                tx.routine_versions().insert(&version)
            })
            .expect("writes");
        id
    }

    pub(crate) async fn start(&self, new: NewRun) -> Result<Vec<RunCreated>, StartError> {
        self.runs.start(new).await
    }

    /// Starts one run by hand and answers its id.
    pub(crate) async fn hand(&self, routine: &str, item: Option<ItemRef>) -> String {
        self.start(new_run(routine, RunOrigin::Hand, item)).await.expect("starts").remove(0).id
    }

    /// The routine's page, as surfaces would have made it, with no design yet.
    pub(crate) fn page_surface(&self, routine: &str) -> String {
        let id = format!("sf-{routine}");
        self.temp.exec(&format!(
            "INSERT INTO surface_defs (id, routine_id, level, place, role, title, created_at, updated_at) \
             VALUES ('{id}', '{routine}', 'page', 'routine_page', 'page', 'Paper', 1, 1)"
        ));
        id
    }

    pub(crate) fn run(&self, id: &str) -> StoredRun {
        let id = id.to_owned();
        self.temp.store.read_blocking(move |tx| tx.runs().find(&id)).expect("reads").expect("the run")
    }

    pub(crate) fn state(&self, id: &str) -> RunState {
        self.run(id).state
    }

    /// The `run:change` payloads announced so far, in order.
    pub(crate) fn changes(&self) -> Vec<Value> {
        self.temp
            .announced
            .list()
            .into_iter()
            .filter(|(topic, _)| *topic == "run:change")
            .map(|(_, payload)| serde_json::from_str(&payload).expect("json"))
            .collect()
    }

    /// Waits, a bounded while, until `done` holds.
    pub(crate) async fn eventually(&self, done: impl Fn() -> bool) {
        for _ in 0..400 {
            if done() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(done(), "never happened");
    }
}

/// More of the bench's parts the module is built from.
struct Shared<'a> {
    gate: &'a Arc<dyn RunGate>,
    keys: &'a Arc<FakeKeys>,
    bus: &'a Bus,
    settings: &'a Arc<FakeSettings>,
    ids: &'a Arc<SeqIds>,
    plan: &'a Arc<FakePlan>,
    model: &'a Arc<ScriptedOneShot>,
    power: &'a Arc<FakePower>,
    trash: &'a Arc<FakeTrash>,
    packs: &'a Arc<FakeExperiencePacks>,
    feedback: &'a Arc<FakeExperienceFeedback>,
    surfaces: &'a Arc<FakeSurfaceAuthoring>,
    steps: &'a Arc<FakeSteps>,
}

// The bench's parts, each shared with the module a restart builds again.
fn module(
    temp: &TempStore,
    clock: &Arc<FakeClock>,
    sleeper: &Arc<FakeSleeper>,
    sessions: &Sessions,
    reads: &Arc<FakeCapabilityReads>,
    shared: Shared<'_>,
    autostart: bool,
) -> Arc<RoutinesModule> {
    let Shared { gate, keys, bus, settings, ids, plan, model, power, trash, packs, feedback, surfaces, steps } = shared;
    let trees = eos_kit_proc::ProcessTrees::new(eos_platform::isolate_command, |pid| {
        eos_platform::kill_process_tree(pid).is_ok()
    });
    let git = eos_git::Git::new(eos_kit_proc::Runner::new(trees), clock.clone());
    let library = Arc::new(LibraryPromptSource::embedded());
    Arc::new(RoutinesModule::new(RoutinesParts {
        store: temp.port(),
        clock: clock.clone(),
        sleeper: sleeper.clone(),
        ids: ids.clone(),
        device: "mac-1".into(),
        autostart,
        // The bench's installed app is the one that runs by itself.
        background_model_calls: autostart,
        sessions: sessions.clone(),
        prompts: Arc::new(PromptService::new(Arc::new(PromptRegistry::new(library)), tool_name_vars())),
        scratch: Arc::new(FakeScratch::default()),
        folders: Arc::new(FsRunFolders::new(temp.home.path().join("routines"))),
        data_dir: temp.home.path().to_owned(),
        reads: reads.clone(),
        gate: gate.clone(),
        config: Arc::new(FakeConfig::new(json!({"prices": {"sonnet": {"in": 3, "out": 15, "cacheRead": 0.3}}}))),
        keys: keys.clone(),
        remotes: Arc::new(git),
        bus: bus.clone(),
        zones: Arc::new(FakeZoneRules::new().fixed("Europe/Istanbul", 180)),
        zone: Arc::new(FakeTimeZone::new("Europe/Istanbul", 180)),
        settings: settings.clone(),
        headroom: plan.clone(),
        one_shot: model.clone(),
        power: power.clone(),
        trash: trash.clone(),
        packs: packs.clone(),
        feedback: feedback.clone(),
        surfaces: surfaces.clone(),
        system_steps: steps.clone(),
    }))
}

pub(crate) fn new_run(routine: &str, origin: RunOrigin, item: Option<ItemRef>) -> NewRun {
    NewRun {
        routine_id: routine.into(),
        version: None,
        input: RunInput {
            item,
            items: None,
            trigger: None,
            options: Default::default(),
            note: None,
            result: ResultMode::Usual,
            at: None,
            surface: None,
            chat: None,
        },
        items: vec![],
        origin,
        door: Some("routine_page".into()),
        confirm_repeat: false,
        client_request_id: None,
    }
}

pub(crate) fn pull_request(number: u32) -> ItemRef {
    ItemRef {
        kind: "github.pull_request".into(),
        key: Some(format!("github:pr:acme/game#{number}")),
        title: Some("Fix the login".into()),
        url: None,
        path: None,
        text: None,
        date: None,
        range: None,
        version: Some("abc".into()),
        untrusted: true,
    }
}

/// PR Review, taking several pull requests, `parallel` runs at once.
pub(crate) fn blueprint(parallel: i64) -> Value {
    let agent = json!({"key": "editor", "name": "Editor", "lead": true, "brief": "Review.", "model": "sonnet",
                       "effort": "medium", "tools": {}, "readsOutside": false, "workspace": "none"});
    json!({
        "format": 1,
        "name": "PR Review",
        "summary": "Reviews a pull request.",
        "icon": "eye",
        "kind": "standing",
        "takes": {"kind": "github.pull_request", "label": "pull request", "placeholder": "#470",
                  "empty": "required", "many": true},
        "options": [
            {"key": "depth", "label": "Depth", "type": "choice", "values": ["quick", "deep"], "default": "quick",
             "inline": true},
            {"key": "long", "label": "Long", "type": "bool", "default": false, "inline": true},
        ],
        "when": {"on": [{"source": "github.pulls", "scope": {"repo": "acme/game"}, "events": ["opened"]}]},
        "which": {},
        "who": {"depth": "solo", "agents": [agent], "checker": {"model": "sonnet", "effort": "high"}},
        "how": {"checks": [], "format": "review", "checkAgent": true},
        "makes": {"kind": "github.review", "description": "A pending review."},
        "goesTo": [],
        "freedom": {"rung": "draft"},
        "limits": {"perRunUsd": 2, "perRunMinutes": 30, "perDayUsd": 5, "parallel": parallel},
    })
}
