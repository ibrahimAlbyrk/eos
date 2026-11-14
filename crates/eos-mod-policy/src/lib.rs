//! The permission routes and the wiring of the gateway into the running app.
//!
//! | Route | |
//! |---|---|
//! | `POST /policy/decide` | decides a tool call; an ask keeps the request open until the user answers |
//! | `GET /pending` | the asks waiting for the user; `?parentId=` narrows to one session's direct children |
//! | `POST /pending/{id}/decision` | the user's answer |
//! | `POST /api/policy/rule` | adds an "always" rule for a tool to `policy.yaml` |

mod routes;

use std::sync::{Arc, Mutex};

use eos_contracts::stream::topics;
use eos_core::store::Store;
use eos_policy::PolicyGateway;
use eos_runtime::bus::{Bus, Subscription, Topic, TopicDecl};
use eos_runtime::module::{Module, ModuleError};
use eos_runtime::router::{BoxFuture, RouteDef};
use serde::Deserialize;
use serde_json::Value;

/// `{ workerId, tool, behavior }` for every decision.
pub const POLICY_DECISION: Topic<Value> = Topic::new(topics::POLICY_DECISION);
/// `{ id, workerId }` when an ask starts waiting.
pub const PENDING_CREATED: Topic<Value> = Topic::new(topics::PENDING_CREATED);
/// `{ id, behavior }` when the user answered.
pub const PENDING_RESOLVED: Topic<Value> = Topic::new(topics::PENDING_RESOLVED);

pub struct PolicyModule {
    gateway: Arc<PolicyGateway>,
    store: Arc<dyn Store>,
    bus: Bus,
    listening: Mutex<Vec<Subscription>>,
}

impl std::fmt::Debug for PolicyModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PolicyModule").field("gateway", &self.gateway).finish_non_exhaustive()
    }
}

impl PolicyModule {
    pub fn new(gateway: Arc<PolicyGateway>, store: Arc<dyn Store>, bus: Bus) -> Self {
        Self { gateway, store, bus, listening: Mutex::new(Vec::new()) }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerGone {
    worker_id: String,
}

impl Module for PolicyModule {
    fn id(&self) -> &'static str {
        "policy"
    }

    fn routes(&self) -> Vec<RouteDef> {
        routes::all(self.gateway.clone(), self.store.clone())
    }

    fn topics(&self) -> Vec<TopicDecl> {
        vec![POLICY_DECISION.decl(), PENDING_CREATED.decl(), PENDING_RESOLVED.decl()]
    }

    fn start(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        Box::pin(async move {
            // A worker that ended or was removed strands its waiting calls.
            let runtime = tokio::runtime::Handle::current();
            let mut listening = self.listening.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            for topic in [topics::WORKER_REMOVED, topics::WORKER_EXIT] {
                let (gateway, runtime) = (self.gateway.clone(), runtime.clone());
                listening.push(self.bus.on(topic, move |event| {
                    let Ok(gone) = event.payload_as::<WorkerGone>() else { return };
                    let gateway = gateway.clone();
                    runtime.spawn(async move {
                        if let Err(e) = gateway.worker_gone(&gone.worker_id).await {
                            tracing::warn!(worker = %gone.worker_id, error = %e, "releasing a gone worker's asks failed");
                        }
                    });
                }));
            }
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            self.listening.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clear();
        })
    }
}
