//! A Forge over a temp database, a fake run starter, fake built-in routines,
//! capabilities a test lists, a capability service over fake files and a
//! fake runner, the sandbox as the test scripts it, and its routes.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use eos_capabilities::{CapabilityPorts, CapabilityService};
use eos_capability_host::Trial;
use eos_contracts::{RunInput, WorkerDefinitionRecord};
use eos_core::capability::{
    ActionCall, ActionError, ActionResult, AllInstalled, CapabilityCalls, CapabilityDescription,
};
use eos_core::forge::Forge;
use eos_core::routine::{BuiltinRoutines, StepResult, SystemStepCall, SystemSteps};
use eos_core::{BoxFuture, Error};
use eos_mod_forge::{ForgeModule, ForgeParts, ForgeSteps, ForgeStepsParts};
use eos_runtime::access::Caller;
use eos_runtime::http::{Method, Request};
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_testkit::{
    FakeActionRunner, FakeCapabilityFiles, FakeCapabilitySecrets, FakeClock, FakeConfinement, FakeRoutineControl,
    FakeRunStarter, FakeSecretPrompt, FakeTimeZone, FakeTrash, SeqIds, TempStore,
};
use serde_json::Value;

/// The Forge's definitions as the app ships them.
pub(crate) fn definitions() -> Vec<WorkerDefinitionRecord> {
    eos_workers::definition::records_from(&eos_store_files::worker_definitions::forge_definitions())
}

/// Keeps every built-in routine as `rt-forge`, remembering its blueprint.
#[derive(Default)]
pub(crate) struct Builtins(pub(crate) Mutex<Vec<(String, Value)>>);

impl BuiltinRoutines for Builtins {
    fn ensure<'a>(&'a self, slug: &'a str, blueprint: Value) -> BoxFuture<'a, Result<String, Error>> {
        self.0.lock().expect("kept").push((slug.to_owned(), blueprint));
        Box::pin(std::future::ready(Ok("rt-forge".to_owned())))
    }
}

/// Describes the capabilities a test lists to every caller.
#[derive(Default)]
pub(crate) struct Known(pub(crate) Mutex<Vec<CapabilityDescription>>);

impl CapabilityCalls for Known {
    fn call(&self, _call: ActionCall) -> BoxFuture<'_, Result<ActionResult, ActionError>> {
        Box::pin(std::future::ready(Err(ActionError::NotFound)))
    }

    fn describe<'a>(
        &'a self,
        _worker_id: &'a str,
        _id: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Vec<CapabilityDescription>, Error>> {
        Box::pin(std::future::ready(Ok(self.0.lock().expect("known").clone())))
    }
}

pub(crate) struct Rig {
    pub(crate) temp: TempStore,
    pub(crate) runs: Arc<FakeRunStarter>,
    pub(crate) builtins: Arc<Builtins>,
    pub(crate) known: Arc<Known>,
    pub(crate) forge: Arc<dyn Forge>,
    pub(crate) steps: Arc<ForgeSteps>,
    pub(crate) service: Arc<CapabilityService>,
    pub(crate) secrets: Arc<FakeCapabilitySecrets>,
    pub(crate) prompt: Arc<FakeSecretPrompt>,
    pub(crate) confinement: Arc<FakeConfinement>,
    runtime: Runtime,
}

/// The steps alone, over the build folders under `home`.
pub(crate) fn steps_in(home: &Path, temp: &TempStore, confinement: Arc<FakeConfinement>) -> ForgeSteps {
    let files = eos_fs::DiskFileSystem::new(eos_platform::generic_host(), &eos_platform::DataPaths::new(home));
    let trees = eos_kit_proc::ProcessTrees::new(eos_platform::isolate_command, |pid| {
        eos_platform::kill_process_tree(pid).is_ok()
    });
    let ids = Arc::new(SeqIds::new());
    ForgeSteps::new(ForgeStepsParts {
        store: temp.port(),
        clock: Arc::new(FakeClock::at(1_000)),
        ids: ids.clone(),
        zone: Arc::new(FakeTimeZone::new("UTC", 0)),
        files: Arc::new(files),
        scratch: home.join("scratch"),
        trial: Arc::new(Trial::new(confinement, eos_kit_proc::Runner::new(trees), ids)),
    })
}

impl Rig {
    /// The module, ready: its routine kept.
    pub(crate) async fn ready() -> Self {
        Self::with_runner(FakeActionRunner::new()).await
    }

    /// As [`Rig::ready`], with `runner` answering the installed
    /// capabilities' actions.
    pub(crate) async fn with_runner(runner: FakeActionRunner) -> Self {
        let temp = TempStore::new();
        let clock = Arc::new(FakeClock::at(1_000));
        let (runs, builtins, known) =
            (Arc::new(FakeRunStarter::new()), Arc::new(Builtins::default()), Arc::new(Known::default()));
        let (secrets, prompt) = (Arc::new(FakeCapabilitySecrets::new()), Arc::new(FakeSecretPrompt::new()));
        let trash = Arc::new(FakeTrash::new(temp.home.join("trash")));
        let service = Arc::new(CapabilityService::new(
            CapabilityPorts {
                store: temp.port(),
                files: Arc::new(FakeCapabilityFiles::new(temp.home.join("capabilities"), trash)),
                secrets: secrets.clone(),
                grants: Arc::new(AllInstalled),
                runner: Some(Arc::new(runner)),
                clock: clock.clone(),
                ids: Arc::new(SeqIds::new()),
            },
            Vec::new(),
        ));
        service.start().await.expect("starts");
        let confinement = Arc::new(FakeConfinement::new());
        let steps = Arc::new(steps_in(temp.home.path(), &temp, confinement.clone()));
        steps.attach(Arc::new(FakeRoutineControl::new()));
        let kernel = Kernel::new(KernelOptions::default());
        let module = Arc::new(ForgeModule::new(ForgeParts {
            store: temp.port(),
            clock,
            runs: runs.clone(),
            builtins: builtins.clone(),
            capabilities: known.clone(),
            definitions: definitions(),
            steps: steps.clone(),
            service: service.clone(),
            prompt: Some(prompt.clone()),
            bus: kernel.bus.clone(),
        }));
        let forge = module.forge();
        let runtime = Runtime::build(kernel, vec![module], Arc::new(AllPluginsOn)).expect("composes");
        runtime.lifecycle.start().await.expect("starts");
        runtime.lifecycle.ready().await.expect("ready");
        Self { temp, runs, builtins, known, forge, steps, service, secrets, prompt, confinement, runtime }
    }

    /// A Forge run with a session of `definition` as worker `worker`.
    pub(crate) fn session(&self, worker: &str, definition: &str) {
        self.session_of("rn-1", worker, definition);
    }

    pub(crate) fn session_of(&self, run: &str, worker: &str, definition: &str) {
        self.temp.exec(&format!(
            "INSERT OR IGNORE INTO runs (id, routine_id, version_id, kind, origin, input, state, priority, device, \
             created_at, updated_at) VALUES ('{run}', 'rt-forge', 'rv-1', 'project', 'hand', \
             '{{\"note\":\"Send me a text\",\"result\":\"usual\"}}', 'running', 0, 'd', 1, 1); \
             INSERT INTO workers (id, state, cwd, prompt, name, started_at, tool_calls, scratch, agent_role, \
             backend_kind, session_id, worker_definition) VALUES ('{worker}', 'IDLE', '/tmp', 'go', 'n', 1, 0, 0, \
             'worker', 'claude', '{worker}', '{definition}'); \
             INSERT INTO routine_sessions (worker_id, routine_id, run_id, role, created_at) \
             VALUES ('{worker}', 'rt-forge', '{run}', 'specialist', 1);"
        ));
    }

    /// The build folder of `run`.
    pub(crate) fn folder(&self, run: &str) -> PathBuf {
        eos_mod_forge::build_folder(&self.temp.home.join("scratch"), run)
    }

    /// Runs the system step `step` of `run`, as the routines would.
    pub(crate) async fn step(&self, run: &str, step: &str) -> StepResult {
        let input: RunInput = serde_json::from_str(r#"{"note":"Send me a text","result":"usual"}"#).expect("input");
        let call = SystemStepCall {
            step: step.into(),
            run_id: run.into(),
            routine_id: "rt-forge".into(),
            milestone: step.trim_start_matches("forge.").into(),
            input,
        };
        self.steps.run(call).await.expect("ran")
    }

    pub(crate) async fn ask_as(&self, caller: Caller, method: Method, path: &str, body: Option<&str>) -> (u16, Value) {
        let mut request = Request::new(method, path, caller);
        if let Some(body) = body {
            request = request.body(body.to_owned());
        }
        let response = self.runtime.router.handle(request).await;
        let status = response.status;
        let bytes = response.body.collect().await.expect("a body");
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    pub(crate) async fn ask(&self, method: Method, path: &str, body: Option<&str>) -> (u16, Value) {
        self.ask_as(Caller::DASHBOARD, method, path, body).await
    }
}
