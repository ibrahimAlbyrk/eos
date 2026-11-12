//! `GET  /workers/:id/workflow-runs`                          the worker's running runs
//! `GET  /workers/:id/workflow-runs/:callId`                  one run, live or finished
//! `GET  /workers/:id/workflow-runs/:callId/agents/:agentId`  one agent's conversation rows
//! `POST /workers/:id/workflow-runs/:callId/stop`             the user's dashboard
//!
//! The phone may follow a chat's runs, and stop one as the user.

use eos_contracts::{WorkflowAgentRows, WorkflowRunList};
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use serde_json::json;

use crate::service::WorkflowRuns;

/// `(worker, call)` of a request. A call id is letters, digits, `_` and `-`:
/// anything else names no route today.
fn target(req: &Request) -> Result<(String, String), ApiError> {
    let call = req.param("callId").unwrap_or_default();
    let valid = !call.is_empty() && call.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if !valid {
        return Err(ApiError::NotFound("not found".into()));
    }
    Ok((req.param("id").unwrap_or_default().to_owned(), call.to_owned()))
}

pub(crate) fn all(runs: &WorkflowRuns) -> Vec<RouteDef> {
    let read = Access::open().phone(Tier::Read);
    let list = {
        let runs = runs.clone();
        RouteDef::get("/workers/{id}/workflow-runs", move |req: Request| {
            let runs = runs.clone();
            async move {
                let runs = runs.list(req.param("id").unwrap_or_default()).await;
                Ok(Response::json(200, &WorkflowRunList { runs }))
            }
        })
    };
    let one = {
        let runs = runs.clone();
        RouteDef::get("/workers/{id}/workflow-runs/{callId}", move |req: Request| {
            let runs = runs.clone();
            async move {
                let (worker, call) = target(&req)?;
                match runs.get(&worker, &call).await? {
                    Some(run) => Ok(Response::json(200, &run)),
                    None => Err(ApiError::NotFound("no workflow run with that call id".into())),
                }
            }
        })
    };
    let agent = {
        let runs = runs.clone();
        RouteDef::get("/workers/{id}/workflow-runs/{callId}/agents/{agentId}", move |req: Request| {
            let runs = runs.clone();
            async move {
                let (worker, call) = target(&req)?;
                match runs.agent_rows(&worker, &call, req.param("agentId").unwrap_or_default()).await? {
                    Some(rows) => Ok(Response::json(200, &WorkflowAgentRows { rows })),
                    None => Err(ApiError::NotFound("no transcript for that agent".into())),
                }
            }
        })
    };
    let stop = {
        let runs = runs.clone();
        RouteDef::post("/workers/{id}/workflow-runs/{callId}/stop", move |req: Request| {
            let runs = runs.clone();
            async move {
                let (worker, call) = target(&req)?;
                match runs.stop(&worker, &call).await {
                    Ok(()) => Ok(Response::json(200, &json!({"ok": true}))),
                    Err(refused) => Ok(Response::error(refused.status, &refused.error)),
                }
            }
        })
    };
    vec![list.access(read), one.access(read), agent.access(read), stop.access(Access::ui_token().phone_user(Tier::Low))]
}
