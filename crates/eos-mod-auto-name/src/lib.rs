//! Auto-name: a fresh orchestrator or focused chat is named from its first request
//! by one small model request, and stays out of the way of a human rename — paused
//! while the rename editor is open, cancelled by a rename.
//!
//! [`MicroTasks`] is the runner of such small requests; [`AutoName`] is the
//! one task there is today.

pub mod name;
mod runner;
mod task;

use std::sync::{Arc, Mutex, PoisonError};

use eos_contracts::RenameIntentRequest;
use eos_contracts::builtin_plugins::ids::AUTO_NAME;
use eos_contracts::stream::topics::WORKER_CHANGE;
use eos_core::store::Store;
use eos_runtime::access::{Access, Tier};
use eos_runtime::bus::Subscription;
use eos_runtime::http::{Request, Response};
use eos_runtime::module::{Module, ModuleError};
use eos_runtime::router::{BoxFuture, RouteDef};
use serde_json::{Value, json};

pub use runner::{MicroTask, MicroTasks, PromptValues, RunnerParts};
pub use task::{AUTO_NAME_TASK, AutoName};

pub struct AutoNameModule {
    runner: MicroTasks,
    bus: eos_runtime::bus::Bus,
    renames: Mutex<Option<Subscription>>,
}

impl std::fmt::Debug for AutoNameModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AutoNameModule").field("runner", &self.runner).finish_non_exhaustive()
    }
}

impl AutoNameModule {
    pub fn new(parts: RunnerParts, store: Arc<dyn Store>) -> Self {
        let bus = parts.bus.clone();
        let task = Arc::new(AutoName { store, config: parts.config.clone() });
        Self { runner: MicroTasks::new(parts, vec![task]), bus, renames: Mutex::default() }
    }

    pub fn runner(&self) -> &MicroTasks {
        &self.runner
    }
}

impl Module for AutoNameModule {
    fn id(&self) -> &'static str {
        "auto-name"
    }

    fn plugin(&self) -> Option<&'static str> {
        Some(AUTO_NAME)
    }

    /// The rename editor's signal: hold the naming while it is open, let it
    /// go on when it closes without a rename. A rename itself goes through
    /// `PUT /workers/:id/name`, which cancels the run. For a chat with no
    /// pending run this does nothing.
    fn routes(&self) -> Vec<RouteDef> {
        let runner = self.runner.clone();
        let intent = RouteDef::put("/workers/{id}/rename-intent", move |req: Request| {
            let runner = runner.clone();
            async move {
                let body: RenameIntentRequest = req.parse()?;
                let id = req.param("id").unwrap_or_default();
                if body.active {
                    runner.pause(AUTO_NAME_TASK, id);
                } else {
                    runner.resume(AUTO_NAME_TASK, id);
                }
                Ok(Response::json(200, &json!({"ok": true})))
            }
        });
        vec![intent.access(Access::open().phone(Tier::Low))]
    }

    fn start(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        Box::pin(async move {
            self.runner.start();
            // A rename by the user ends a pending run: waiting on would only
            // spend a model request whose answer is thrown away.
            let runner = self.runner.clone();
            let renames = self.bus.on(WORKER_CHANGE, move |event| {
                let Ok(payload) = event.payload_as::<Value>() else { return };
                if let (Some("user"), Some(worker)) = (payload["renamedBy"].as_str(), payload["workerId"].as_str()) {
                    runner.cancel(AUTO_NAME_TASK, worker, "user-renamed");
                }
            });
            *self.renames.lock().unwrap_or_else(PoisonError::into_inner) = Some(renames);
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            self.renames.lock().unwrap_or_else(PoisonError::into_inner).take();
            self.runner.stop();
        })
    }
}
