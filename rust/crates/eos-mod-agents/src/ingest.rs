//! A worker's events posted from outside (`POST /workers/:id/events`,
//! `core/src/use-cases/ProcessWorkerEvent.ts`).
//!
//! The terminal-driven lane posted its rows here. Every agent runs in the
//! engine now and reports through its session, so nothing posts any more;
//! the route still records a row and applies the two kinds that change a
//! worker (`state`, `lifecycle`), as it did.

use eos_contracts::WorkerEventType;
use eos_contracts::stream::topics::WORKER_CHANGE;
use eos_domain::worker::parse_state;
use eos_runtime::access::Access;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use eos_sessions::transition_state;
use serde_json::{Value, json};

use crate::AgentsModule;
use crate::routes::id_of;

/// The kinds the terminal lane's translator turned into agent events; with
/// no such lane they carry nothing.
const TRANSLATED: [WorkerEventType; 6] = [
    WorkerEventType::Jsonl,
    WorkerEventType::ToolRunning,
    WorkerEventType::ToolDone,
    WorkerEventType::Hook,
    WorkerEventType::Heartbeat,
    WorkerEventType::Usage,
];

pub(crate) fn route(m: AgentsModule) -> RouteDef {
    RouteDef::post("/workers/{id}/events", move |req: Request| {
        let m = m.clone();
        async move {
            let body: Value = req.json().unwrap_or_default();
            let Some(kind) = body["type"].as_str().filter(|kind| !kind.is_empty()) else {
                return Err(ApiError::Validation("type required".into()));
            };
            let Ok(kind) = serde_json::from_value::<WorkerEventType>(Value::String(kind.to_owned())) else {
                return Err(ApiError::Validation(format!("unknown event type: {kind}")));
            };
            if TRANSLATED.contains(&kind) {
                return Ok(Response::json(200, &json!({"ok": true})));
            }
            let (id, now, payload) = (id_of(&req), m.sessions.clock().now_ms(), body["payload"].clone());
            m.store
                .write(move |tx, out| {
                    let text = (!payload.is_null()).then(|| payload.to_string());
                    let row_id = tx.events().append(&id, now, kind, text.as_deref())?;
                    out.push(WORKER_CHANGE, &json!({"workerId": id, "rowId": row_id, "type": kind}));
                    let text_of = |key: &str| payload[key].as_str().filter(|v| !v.is_empty());
                    match (kind, text_of("phase")) {
                        (WorkerEventType::State, _) => {
                            if let Some(next) = text_of("state").and_then(|s| parse_state(&s.to_uppercase())) {
                                transition_state(tx, out, now, &id, next, "worker_pushed")?;
                            }
                        }
                        (WorkerEventType::Lifecycle, Some("claude_spawning")) => {
                            if let Some(dir) = text_of("worktreeDir") {
                                tx.workers().set_worktree_dir(&id, dir)?;
                            }
                            if let Some(sha) = text_of("forkBaseSha") {
                                tx.workers().set_fork_base_sha(&id, sha)?;
                            }
                            tx.workers().set_workspace_ready(&id)?;
                        }
                        (WorkerEventType::Lifecycle, Some("session_captured")) => {
                            if let Some(session) = text_of("sessionId") {
                                tx.workers().set_session_id(&id, session)?;
                            }
                        }
                        (WorkerEventType::Lifecycle, Some("delivery_failed")) => {
                            transition_state(tx, out, now, &id, eos_contracts::WorkerState::Idle, "delivery_failed")?;
                        }
                        _ => {}
                    }
                    Ok(())
                })
                .await?;
            Ok(Response::json(200, &json!({"ok": true})))
        }
    })
    .access(Access::open().local_only())
}
