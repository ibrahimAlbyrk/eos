//! Worker definitions over the wire (`manager/routes/worker-definitions.ts`).
//!
//! | Route | |
//! |---|---|
//! | `GET /worker-definitions?owner=` | what that orchestrator may spawn from: built-in, the user's, its project's, and its own (`list_available_workers`) |
//! | `POST /worker-definitions?owner=` | stores a definition the orchestrator created (`create_worker`) |
//!
//! An orchestrator's own definitions go when its worker row is removed.

use std::sync::{Arc, Mutex};

use eos_contracts::stream::topics;
use eos_contracts::{CreateWorkerResponse, WorkerDefinition};
use eos_runtime::access::{Access, Tier};
use eos_runtime::bus::{Bus, Subscription};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::module::{Module, ModuleError};
use eos_runtime::router::{BoxFuture, RouteDef};
use eos_workers::WorkerDefinitions;
use eos_workers::catalog::entries;
use serde::Deserialize;

pub struct WorkerDefinitionsModule {
    definitions: Arc<WorkerDefinitions>,
    bus: Bus,
    listening: Mutex<Option<Subscription>>,
}

impl std::fmt::Debug for WorkerDefinitionsModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkerDefinitionsModule").finish_non_exhaustive()
    }
}

impl WorkerDefinitionsModule {
    pub fn new(definitions: Arc<WorkerDefinitions>, bus: Bus) -> Self {
        Self { definitions, bus, listening: Mutex::new(None) }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerRemoved {
    worker_id: String,
}

fn owner_of(req: &Request) -> Option<String> {
    req.query().get("owner").filter(|owner| !owner.is_empty()).map(|owner| owner.into_owned())
}

impl Module for WorkerDefinitionsModule {
    fn id(&self) -> &'static str {
        "worker-definitions"
    }

    fn routes(&self) -> Vec<RouteDef> {
        let definitions = self.definitions.clone();
        let list = RouteDef::get("/worker-definitions", move |req: Request| {
            let definitions = definitions.clone();
            async move {
                let available = definitions.available(owner_of(&req).as_deref()).await?;
                Ok(Response::json(200, &entries(&available)))
            }
        })
        .access(Access::open().phone(Tier::Read));

        let definitions = self.definitions.clone();
        let create = RouteDef::post("/worker-definitions", move |req: Request| {
            let definitions = definitions.clone();
            async move {
                let Some(owner) = owner_of(&req) else {
                    return Err(ApiError::status_with(400, "owner query param required"));
                };
                let definition: WorkerDefinition = req.parse()?;
                definitions.create(&owner, &definition).await?;
                Ok(Response::json(201, &CreateWorkerResponse { name: definition.name }))
            }
        })
        .access(Access::open());

        vec![list, create]
    }

    fn start(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        Box::pin(async move {
            let (definitions, runtime) = (self.definitions.clone(), tokio::runtime::Handle::current());
            let subscription = self.bus.on(topics::WORKER_REMOVED, move |event| {
                let Ok(removed) = event.payload_as::<WorkerRemoved>() else { return };
                let definitions = definitions.clone();
                runtime.spawn(async move {
                    if let Err(e) = definitions.forget_owner(&removed.worker_id).await {
                        tracing::warn!(worker = %removed.worker_id, error = %e, "dropping a removed worker's definitions failed");
                    }
                });
            });
            *self.listening.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(subscription);
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            self.listening.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
        })
    }
}
