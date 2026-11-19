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
use eos_mod_routines::{RoutinesModule, RoutinesParts, ShowOnlyGate};
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
    FakeCapabilityReads, FakeClock, FakeConfig, FakeModelCatalog, FakePrompts, FakeRecents, FakeRunGate, FakeScratch,
    FakeSleeper, FakeWorktrees, ScriptedRuntime, SeqIds, TempStore,
};
use serde_json::{Value, json};

pub(crate) const HOUR: i64 = 60 * 60 * 1000;

pub(crate) struct Bench {
    pub(crate) module: Arc<RoutinesModule>,
    pub(crate) runs: Arc<dyn RunStarter>,
    pub(crate) temp: TempStore,
    pub(crate) clock: Arc<FakeClock>,
    pub(crate) sleeper: Arc<FakeSleeper>,
    pub(crate) ids: SeqIds,
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
}

/// The user's clones, by the key of their remote.
#[derive(Default)]
pub(crate) struct FakeKeys(std::sync::Mutex<std::collections::HashMap<String, String>>);

impl FakeKeys {
    pub(crate) fn clone_at(&self, key: &str, path: &str) {
        self.0.lock().expect("keys").insert(key.into(), path.into());
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

    /// With the gate that only shows results.
    pub(crate) fn showing_only() -> Self {
        Self::with(true, FakeCapabilityReads::new(), Arc::new(FakeRunGate::new()), Arc::new(ShowOnlyGate))
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
        let module = module(&temp, &clock, &sleeper, &sessions, &reads, &gate_port, &keys, &bus, autostart);
        let _ = hooks.module.set(Arc::downgrade(&module));
        let runs = module.runs();
        Self {
            module,
            runs,
            temp,
            clock,
            sleeper,
            ids: SeqIds::new(),
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
        }
    }

    /// A second module over the same store, sessions and folders: the app
    /// as it comes back after a restart.
    pub(crate) fn another_module(&self) -> Arc<RoutinesModule> {
        let (temp, clock, sleeper, sessions, reads) =
            (&self.temp, &self.clock, &self.sleeper, &self.sessions, &self.reads);
        module(temp, clock, sleeper, sessions, reads, &self.gate_port, &self.keys, &self.bus, self.autostart)
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

// The bench's parts, each shared with the module a restart builds again.
#[allow(clippy::too_many_arguments)]
fn module(
    temp: &TempStore,
    clock: &Arc<FakeClock>,
    sleeper: &Arc<FakeSleeper>,
    sessions: &Sessions,
    reads: &Arc<FakeCapabilityReads>,
    gate: &Arc<dyn RunGate>,
    keys: &Arc<FakeKeys>,
    bus: &Bus,
    autostart: bool,
) -> Arc<RoutinesModule> {
    let trees = eos_kit_proc::ProcessTrees::new(eos_platform::isolate_command, |pid| {
        eos_platform::kill_process_tree(pid).is_ok()
    });
    let git = eos_git::Git::new(eos_kit_proc::Runner::new(trees), clock.clone());
    let library = Arc::new(LibraryPromptSource::embedded());
    Arc::new(RoutinesModule::new(RoutinesParts {
        store: temp.port(),
        clock: clock.clone(),
        sleeper: sleeper.clone(),
        ids: Arc::new(SeqIds::new()),
        device: "mac-1".into(),
        autostart,
        sessions: sessions.clone(),
        prompts: Arc::new(PromptService::new(Arc::new(PromptRegistry::new(library)), tool_name_vars())),
        scratch: Arc::new(FakeScratch::default()),
        folders: Arc::new(FsRunFolders::new(temp.home.path().join("routines"))),
        reads: reads.clone(),
        gate: gate.clone(),
        config: Arc::new(FakeConfig::new(json!({"prices": {"sonnet": {"in": 3, "out": 15, "cacheRead": 0.3}}}))),
        keys: keys.clone(),
        remotes: Arc::new(git),
        bus: bus.clone(),
    }))
}

pub(crate) fn new_run(routine: &str, origin: RunOrigin, item: Option<ItemRef>) -> NewRun {
    NewRun {
        routine_id: routine.into(),
        input: RunInput {
            item,
            items: None,
            trigger: None,
            options: Default::default(),
            note: None,
            result: ResultMode::Usual,
            at: None,
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
