//! The agents feature as an agent's tools reach it
//! ([`eos_core::agent::WorkerControl`]: `spawn_worker`, `message_worker`,
//! `kill_worker`, `send_message_to_parent`, `integrate_workers`).
//!
//! Each operation is the route the tool used to call, asked from inside the
//! app: the same handler, so a tool and the dashboard can never answer
//! differently. An operation whose route this crate does not serve yet is
//! refused as not available.

use std::path::Path;
use std::sync::Arc;

use eos_contracts::{IntegrateWorkersResponse, SpawnWorkerRequest};
use eos_core::agent::{DirectiveSent, KilledWorker, Refused, SessionFolder, SpawnedWorker, WorkerControl};
use eos_core::git::GitInfo;
use eos_core::{BoxFuture, Error};
use eos_domain::worker::{Ownership, ownership};
use eos_runtime::access::Caller;
use eos_runtime::http::{Method, Request};
use eos_runtime::module::Module;
use eos_runtime::router::Router;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::AgentsModule;

/// What an operation without a route here answers.
const NOT_AVAILABLE: u16 = 501;

pub struct ToolControl {
    agents: AgentsModule,
    /// The feature's own routes, for calls from inside the app.
    routes: Router,
    git: Arc<dyn GitInfo>,
}

impl std::fmt::Debug for ToolControl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToolControl").finish_non_exhaustive()
    }
}

fn refused(e: &Error) -> Refused {
    // A failed read of our own database, the only failure outside a route.
    Refused::new(500, e.to_string())
}

fn field<T: DeserializeOwned>(answer: &Value, key: &str) -> Result<T, Refused> {
    serde_json::from_value(answer[key].clone())
        .map_err(|e| Refused::new(500, format!("the answer's `{key}` was not understood: {e}")))
}

impl ToolControl {
    pub fn new(agents: &AgentsModule, git: Arc<dyn GitInfo>) -> Result<Self, eos_runtime::Error> {
        let routes = Router::builder().routes(agents.routes()).build()?;
        Ok(Self { agents: agents.clone(), routes, git })
    }

    /// Asks one of the feature's routes; a refusal is its status and `error` text.
    async fn ask(&self, method: Method, target: &str, body: Option<Value>) -> Result<Value, Refused> {
        let mut request = Request::new(method, target, Caller::Internal);
        if let Some(body) = body {
            request = request.header("content-type", "application/json").body(body.to_string());
        }
        let res = self.routes.handle(request).await;
        let status = res.status;
        let bytes = res.body.collect().await.map_err(|e| Refused::new(500, e.to_string()))?;
        let answer: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        if (200..300).contains(&status) {
            return Ok(answer);
        }
        let message = match answer.get("error").and_then(Value::as_str) {
            Some(error) => error.to_owned(),
            None => String::from_utf8_lossy(&bytes).into_owned(),
        };
        Err(Refused::new(status, message))
    }
}

impl WorkerControl for ToolControl {
    fn folder<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, SessionFolder> {
        Box::pin(async move {
            let row = self.agents.worker(worker_id).await.ok().flatten();
            let cwd = row.and_then(|w| w.worktree_dir.or(w.cwd)).unwrap_or_default();
            let git_repo = !cwd.is_empty() && self.git.is_repo(Path::new(&cwd)).await;
            SessionFolder { cwd, git_repo }
        })
    }

    fn spawn(&self, request: SpawnWorkerRequest) -> BoxFuture<'_, Result<SpawnedWorker, Refused>> {
        Box::pin(async move {
            let started = self.ask(Method::Post, "/workers", Some(json!(request))).await?;
            Ok(SpawnedWorker { id: field(&started, "id")?, isolation: field(&started, "isolation")? })
        })
    }

    fn message<'a>(
        &'a self,
        parent_id: &'a str,
        worker_id: &'a str,
        text: String,
    ) -> BoxFuture<'a, Result<DirectiveSent, Refused>> {
        Box::pin(async move {
            let body = json!({"text": text, "fromParent": parent_id});
            let sent = self.ask(Method::Post, &format!("/workers/{worker_id}/message"), Some(body)).await?;
            Ok(DirectiveSent { id: field(&sent, "id")?, name: field(&sent, "name")? })
        })
    }

    fn kill<'a>(&'a self, actor_id: &'a str, worker_id: &'a str) -> BoxFuture<'a, Result<KilledWorker, Refused>> {
        Box::pin(async move {
            // Checked before anything is touched: an agent removes only workers it started.
            let target = self.agents.worker(worker_id).await.map_err(|e| refused(&e))?;
            match ownership(target.as_ref(), worker_id, actor_id, false) {
                Ownership::Owned => {}
                Ownership::Missing => return Err(Refused::new(404, format!("worker not found: {worker_id}"))),
                Ownership::NotManaged => {
                    return Err(Refused::new(403, format!("worker {worker_id} is not managed by {actor_id}")));
                }
            }
            let gone = self.ask(Method::Delete, &format!("/workers/{worker_id}"), None).await?;
            Ok(KilledWorker {
                id: field(&gone, "id")?,
                name: field(&gone, "name")?,
                removed: field(&gone, "removed")?,
                was_state: field(&gone, "was_state")?,
            })
        })
    }

    fn report<'a>(&'a self, _worker_id: &'a str, _text: String) -> BoxFuture<'a, Result<(), Refused>> {
        Box::pin(async { Err(Refused::new(NOT_AVAILABLE, "reporting to the parent is not available yet")) })
    }

    fn integrate<'a>(
        &'a self,
        _orchestrator_id: &'a str,
        _ids: Option<Vec<String>>,
    ) -> BoxFuture<'a, Result<IntegrateWorkersResponse, Refused>> {
        Box::pin(async { Err(Refused::new(NOT_AVAILABLE, "integrating workers' branches is not available yet")) })
    }
}
