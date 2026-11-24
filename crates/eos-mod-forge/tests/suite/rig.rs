//! A Forge over a temp database, a fake run starter, fake built-in routines
//! and capabilities a test lists.

use std::sync::{Arc, Mutex};

use eos_contracts::WorkerDefinitionRecord;
use eos_core::capability::{ActionCall, ActionError, ActionResult, CapabilityCalls, CapabilityDescription};
use eos_core::forge::Forge;
use eos_core::routine::BuiltinRoutines;
use eos_core::{BoxFuture, Error};
use eos_mod_forge::{ForgeModule, ForgeParts};
use eos_runtime::module::Module;
use eos_testkit::{FakeClock, FakeRunStarter, TempStore};
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
}

impl Rig {
    /// The module, ready: its routine kept.
    pub(crate) async fn ready() -> Self {
        let temp = TempStore::new();
        let (runs, builtins, known) =
            (Arc::new(FakeRunStarter::new()), Arc::new(Builtins::default()), Arc::new(Known::default()));
        let module = ForgeModule::new(ForgeParts {
            store: temp.port(),
            clock: Arc::new(FakeClock::at(1_000)),
            runs: runs.clone(),
            builtins: builtins.clone(),
            capabilities: known.clone(),
            definitions: definitions(),
        });
        module.after_ready().await.expect("ready");
        let forge = module.forge();
        Self { temp, runs, builtins, known, forge }
    }

    /// A Forge run with a session of `definition` as worker `worker`.
    pub(crate) fn session(&self, worker: &str, definition: &str) {
        self.temp.exec(&format!(
            "INSERT OR IGNORE INTO runs (id, routine_id, version_id, kind, origin, input, state, priority, device, \
             created_at, updated_at) VALUES ('rn-1', 'rt-forge', 'rv-1', 'project', 'hand', '{{}}', 'running', 0, 'd', \
             1, 1); \
             INSERT INTO workers (id, state, cwd, prompt, name, started_at, tool_calls, scratch, agent_role, \
             backend_kind, session_id, worker_definition) VALUES ('{worker}', 'IDLE', '/tmp', 'go', 'n', 1, 0, 0, \
             'worker', 'claude', '{worker}', '{definition}'); \
             INSERT INTO routine_sessions (worker_id, routine_id, run_id, role, created_at) \
             VALUES ('{worker}', 'rt-forge', 'rn-1', 'specialist', 1);"
        ));
    }
}
