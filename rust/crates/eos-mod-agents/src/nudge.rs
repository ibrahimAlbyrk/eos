//! Waking a chat, running one of its buttons, moving it to another backend
//! (`manager/routes/workers.ts`: warm, action, keystroke, backend).

use eos_contracts::{SetBackendRequest, WorkerAction, WorkerActionRequest};
use eos_core::Error;
use eos_domain::config::current_backend_kind;
use eos_prompts::VariableScope;
use eos_prompts::service::no_values;
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use eos_sessions::MessageInput;
use serde_json::json;

use crate::AgentsModule;
use crate::routes::{delivered, id_of};

pub(crate) fn all(m: &AgentsModule) -> Vec<RouteDef> {
    vec![warm(m.clone()), action(m.clone()), keystroke(), backend(m.clone())]
}

/// The library prompt behind a chat's button, the values it is rendered
/// with, and what the chat shows for it (`manager/services/worker-actions.ts`).
fn action_spec(action: WorkerAction) -> (&'static str, &'static str, Option<(&'static str, &'static str)>) {
    match action {
        WorkerAction::Commit => ("commit", "/commit", Some(("PUSH", "false"))),
        WorkerAction::CommitPush => ("commit", "/commit and push", Some(("PUSH", "true"))),
        WorkerAction::Pr => ("create-pr", "/create-pr", Some(("DRAFT", "false"))),
        WorkerAction::DraftPr => ("create-pr", "/create-pr draft", Some(("DRAFT", "true"))),
        WorkerAction::Verify => ("verify", "/verify", None),
        WorkerAction::Review => ("review", "/review", None),
    }
}

/// Opening a chat starts its session ahead of the first message. Answers at
/// once; the session comes up in the background.
fn warm(m: AgentsModule) -> RouteDef {
    RouteDef::post("/workers/{id}/warm", move |req: Request| {
        let m = m.clone();
        async move {
            let Some(row) = m.worker(&id_of(&req)).await? else {
                return Err(ApiError::NotFound("worker not found".into()));
            };
            if row.is_archived() {
                return Err(ApiError::Conflict("worker is archived — restore first".into()));
            }
            tokio::spawn(async move {
                if let Err(e) = m.revive(&row).await {
                    tracing::warn!(worker_id = %row.id, error = %e, "warming a chat up failed");
                }
            });
            Ok(Response::json(202, &json!({"ok": true})))
        }
    })
    .access(Access::ui_token())
}

fn action(m: AgentsModule) -> RouteDef {
    RouteDef::post("/workers/{id}/action", move |req: Request| {
        let m = m.clone();
        async move {
            let body: WorkerActionRequest = req.parse()?;
            let (prompt, display, value) = action_spec(body.action);
            let values: VariableScope = value.into_iter().map(|(name, v)| (name.to_owned(), v.into())).collect();
            let text = m.spawning.prompts.render(prompt, &values, &no_values())?.trim().to_owned();
            let id = id_of(&req);
            let Some(target) = m.worker(&id).await? else { return Err(ApiError::NotFound("worker not found".into())) };
            m.revive(&target).await?;
            let message = MessageInput {
                worker_id: id,
                text,
                display_text: Some(display.to_owned()),
                origin: Some("action".into()),
                ..MessageInput::default()
            };
            Ok(delivered(&m.sessions.dispatch(message).await?))
        }
    })
    .access(Access::open().phone(Tier::High))
}

/// Raw keys went to a terminal-driven agent. There is none any more: every
/// agent runs in the engine, which today's route answered the same way.
fn keystroke() -> RouteDef {
    RouteDef::post("/workers/{id}/keystroke", |_req: Request| async {
        Err::<Response, _>(ApiError::NotFound("worker not found".into()))
    })
    .access(Access::open().local_only())
}

/// Moving a chat to another backend. One engine runs every chat, so there is
/// nowhere to move it: the route only says why.
fn backend(m: AgentsModule) -> RouteDef {
    RouteDef::put("/workers/{id}/backend", move |req: Request| {
        let m = m.clone();
        async move {
            let body: SetBackendRequest = req.parse()?;
            let id = id_of(&req);
            let Some(row) = m.worker(&id).await? else { return Err(Error::not_found("worker", id).into()) };
            let engine = &m.sessions.descriptor().kind;
            if current_backend_kind(&body.kind) != engine {
                return Err(ApiError::Conflict(format!("unknown backend \"{}\"", body.kind)));
            }
            let source = row.backend_kind.as_deref().map(current_backend_kind).unwrap_or(engine);
            // A row left by a backend that no longer exists keeps its conversation where that backend
            // stored it: the engine cannot continue it.
            let reason = match source == engine {
                true => "worker is already on this backend",
                false => "the backends use incompatible conversation stores",
            };
            Err(ApiError::Conflict(format!("cannot switch backend: {reason}")))
        }
    })
    .access(Access::open().phone(Tier::High))
}
