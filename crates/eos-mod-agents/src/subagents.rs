//! Stopping one subagent of a chat from the dashboard.
//!
//! The dashboard knows a subagent by the call that started one of its runs;
//! the session stops it by its agent id, through the same `stop_task` a
//! background job or a workflow run is stopped by. The subagent then ends as
//! stopped (`subagent_completed` with `killed`), its parent is told the user
//! stopped it, and a later message to it is refused.

use eos_core::agent::SessionError;
use eos_core::store::Tx;
use eos_runtime::access::Access;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use serde_json::{Value, json};

use crate::AgentsModule;
use crate::routes::id_of;

/// The `agent_event` rows read per slice while looking for a start.
const SCAN_SLICE: i64 = 500;
/// The code of a 409 for a subagent that has already ended.
const ENDED: &str = "subagent_ended";

pub(crate) fn all(m: &AgentsModule) -> Vec<RouteDef> {
    vec![stop(m.clone())]
}

/// The agent id the run started by `call_id` belongs to, from its
/// `subagent_started` row.
fn agent_of_call(tx: &dyn Tx, worker_id: &str, call_id: &str) -> Result<Option<String>, eos_core::Error> {
    let mut after = 0;
    loop {
        let rows = tx.events().scan(worker_id, &["agent_event"], after, SCAN_SLICE)?;
        let Some(last) = rows.last() else { return Ok(None) };
        after = last.id;
        for row in &rows {
            let Some(payload) = row.payload.as_deref().filter(|p| p.contains("subagent_started")) else { continue };
            let Ok(event) = serde_json::from_str::<Value>(payload) else { continue };
            if event["type"] == "subagent_started"
                && event["callId"] == call_id
                && let Some(agent) = event["agentId"].as_str().filter(|a| !a.is_empty())
            {
                return Ok(Some(agent.to_owned()));
            }
        }
        if (rows.len() as i64) < SCAN_SLICE {
            return Ok(None);
        }
    }
}

fn stop(m: AgentsModule) -> RouteDef {
    RouteDef::post("/workers/{id}/subagents/{callId}/stop", move |req: Request| {
        let m = m.clone();
        async move {
            let id = id_of(&req);
            let call = req.param("callId").unwrap_or_default().to_owned();
            let (worker, call_id) = (id.clone(), call.clone());
            let agent = m.store.read(move |tx| agent_of_call(tx, &worker, &call_id)).await?;
            let Some(agent) = agent else {
                return Err(ApiError::NotFound("no subagent with that call id".into()));
            };
            // A chat at rest has no subagent left running.
            let Some(session) = m.sessions.session(&id) else {
                return Err(ApiError::coded(409, "the subagent has already ended", ENDED));
            };
            match session.stop_task(&agent).await {
                Ok(()) => Ok(Response::json(200, &json!({"ok": true, "agentId": agent}))),
                Err(SessionError::TaskEnded(message)) => Err(ApiError::coded(409, message, ENDED)),
                Err(SessionError::Gone) => Err(ApiError::coded(409, "the subagent has already ended", ENDED)),
                Err(e) => Err(ApiError::Conflict(e.to_string())),
            }
        }
    })
    // As stopping a background job.
    .access(Access::ui_token())
}
