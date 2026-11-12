//! Acting on a chat or worker that exists.

use eos_contracts::stream::topics::WORKER_CHANGE;
use eos_contracts::{
    MessageRequest, NameSource, RewindRequest, RewindTargetsResponse, SetModelRequest, SetModelResponse,
    SetNameRequest, SetPermissionRequest, SetPermissionResponse, WorkerEventType, WorkerState,
};
use eos_core::Error;
use eos_core::agent::SessionError;
use eos_domain::Worker;
use eos_domain::envelope::Envelope;
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use eos_sessions::{Dispatched, MessageInput};
use serde_json::json;

use crate::AgentsModule;

pub(crate) fn all(m: &AgentsModule) -> Vec<RouteDef> {
    vec![
        rename(m.clone()),
        permission(m.clone()),
        model(m.clone()),
        message(m.clone()),
        orchestrator_message(m.clone()),
        interrupt(m.clone()),
        resume(m.clone()),
        rewind_targets(m.clone()),
        rewind(m.clone()),
        remove(m.clone()),
        unqueue(m.clone()),
    ]
}

fn id_of(req: &Request) -> String {
    req.param("id").unwrap_or_default().to_owned()
}

impl AgentsModule {
    pub(crate) async fn worker(&self, id: &str) -> Result<Option<Worker>, Error> {
        let id = id.to_owned();
        self.store.read(move |tx| tx.workers().find(&id)).await
    }

    /// A chat whose session is over is continued by the first message to it.
    async fn revive(&self, worker: &Worker) -> Result<(), Error> {
        let at_rest = matches!(worker.state, WorkerState::Suspended | WorkerState::Done);
        let resumable = worker.session_id.as_deref().is_some_and(|s| !s.is_empty());
        if at_rest && resumable && !self.sessions.is_live(&worker.id) {
            self.sessions.resume(&worker.id).await?;
        }
        Ok(())
    }
}

/// What a message's delivery answers, as today's dispatch does.
fn delivered(outcome: &Dispatched) -> Response {
    match outcome {
        Dispatched::Sent => Response::json(200, &json!({"ok": true})),
        Dispatched::Queued { queue_id } => {
            Response::json(202, &json!({"ok": true, "queued": true, "queueId": queue_id}))
        }
        Dispatched::Deduped => Response::json(200, &json!({"ok": true, "deduped": true})),
        // A command Eos ran itself answers for itself.
        Dispatched::Command(answer) => Response::json(200, answer),
    }
}

/// What the operator's message carries besides its text.
fn from_dashboard(id: String, body: MessageRequest) -> MessageInput {
    let origin = if body.action.is_some() { "view-action" } else { "dashboard" };
    MessageInput {
        worker_id: id,
        text: body.text,
        client_msg_id: body.client_msg_id,
        queue_when_busy: body.queue_when_busy.unwrap_or(false),
        reply_to: body.reply_to.map(|reply| reply.row_id),
        view_action: body.action,
        origin: Some(origin.into()),
        ..MessageInput::default()
    }
}

fn rename(m: AgentsModule) -> RouteDef {
    RouteDef::put("/workers/{id}/name", move |req: Request| {
        let m = m.clone();
        async move {
            let body: SetNameRequest = req.parse()?;
            let id = id_of(&req);
            let renamed = m
                .store
                .write(move |tx, out| {
                    if tx.workers().find(&id)?.is_none() {
                        return Ok(false);
                    }
                    tx.workers().update_name(&id, body.name.as_deref(), NameSource::User)?;
                    out.push(WORKER_CHANGE, &json!({"workerId": id, "renamedBy": "user"}));
                    Ok(true)
                })
                .await?;
            if !renamed {
                return Err(ApiError::NotFound("not found".into()));
            }
            Ok(Response::json(200, &json!({"ok": true})))
        }
    })
    .access(Access::open().phone(Tier::Low))
}

fn permission(m: AgentsModule) -> RouteDef {
    RouteDef::put("/workers/{id}/permission", move |req: Request| {
        let m = m.clone();
        async move {
            let body: SetPermissionRequest = req.parse()?;
            let set = m.sessions.set_permission_mode(&id_of(&req), body.mode, body.cascade != Some(false)).await?;
            let answer =
                SetPermissionResponse { ok: true, mode: set.mode, runtime_applied: false, affected: set.affected };
            Ok(Response::json(200, &answer))
        }
    })
    .access(Access::open().phone(Tier::High))
}

fn model(m: AgentsModule) -> RouteDef {
    RouteDef::put("/workers/{id}/model", move |req: Request| {
        let m = m.clone();
        async move {
            let body: SetModelRequest = req.parse()?;
            let set = match m.sessions.set_model(&id_of(&req), &body.model, body.effort.as_deref()).await {
                Ok(set) => set,
                // A model the provider does not have is the request's fault, with today's status.
                Err(Error::Validation(why)) => return Err(ApiError::status_with(422, why)),
                Err(e) => return Err(e.into()),
            };
            let answer = SetModelResponse {
                ok: true,
                model: set.model,
                effort: set.effort,
                runtime_applied: set.runtime_applied,
            };
            Ok(Response::json(200, &answer))
        }
    })
    .access(Access::open().phone(Tier::Low))
}

fn message(m: AgentsModule) -> RouteDef {
    RouteDef::post("/workers/{id}/message", move |req: Request| {
        let m = m.clone();
        async move {
            let body: MessageRequest = req.parse()?;
            // A parent's directive names the parent; the contract's body does not list it.
            let from_parent =
                req.json::<serde_json::Value>().ok().and_then(|raw| raw["fromParent"].as_str().map(str::to_owned));
            let id = id_of(&req);
            let Some(target) = m.worker(&id).await? else { return Err(ApiError::NotFound("worker not found".into())) };
            if target.is_archived() {
                return Err(ApiError::Conflict("worker is archived — restore first".into()));
            }
            if let Some(parent_id) = &from_parent
                && target.parent_id.as_deref() != Some(parent_id)
            {
                return Err(ApiError::PermissionDenied(format!("worker {id} is not managed by {parent_id}")));
            }
            m.revive(&target).await?;

            let Some(parent_id) = from_parent else {
                let outcome = m.sessions.dispatch(from_dashboard(id, body)).await?;
                return Ok(delivered(&outcome));
            };
            let parent_name = m.worker(&parent_id).await?.and_then(|p| p.name).unwrap_or_else(|| parent_id.clone());
            let directive = MessageInput {
                worker_id: id.clone(),
                display_text: Some(body.text.clone()),
                text: body.text,
                envelope: Some(Envelope::OrchestratorMessage {
                    from_parent: parent_id,
                    parent_name: Some(parent_name),
                }),
                queue_when_busy: true,
                origin: Some("orchestrator-directive".into()),
                ..MessageInput::default()
            };
            if m.sessions.dispatch(directive).await.is_err() {
                return Err(ApiError::Unreachable("worker unreachable".into()));
            }
            let name = m.worker(&id).await?.and_then(|w| w.name);
            Ok(Response::json(200, &json!({"ok": true, "id": id, "name": name})))
        }
    })
    .access(Access::open().phone(Tier::Low))
}

fn orchestrator_message(m: AgentsModule) -> RouteDef {
    RouteDef::post("/orchestrators/{id}/message", move |req: Request| {
        let m = m.clone();
        async move {
            let body: MessageRequest = req.parse()?;
            let id = id_of(&req);
            if let Some(target) = m.worker(&id).await? {
                m.revive(&target).await?;
            }
            let input = MessageInput { require_orchestrator: true, ..from_dashboard(id, body) };
            Ok(delivered(&m.sessions.dispatch(input).await?))
        }
    })
    .access(Access::open().phone(Tier::Low))
}

fn interrupt(m: AgentsModule) -> RouteDef {
    RouteDef::post("/workers/{id}/interrupt", move |req: Request| {
        let m = m.clone();
        async move {
            match m.sessions.interrupt(&id_of(&req)).await {
                Ok(_) => Ok(Response::json(200, &json!({"ok": true}))),
                Err(Error::NotFound { .. }) => Err(ApiError::NotFound("worker not found".into())),
                Err(e) => Err(e.into()),
            }
        }
    })
    .access(Access::open().phone(Tier::Low))
}

fn resume(m: AgentsModule) -> RouteDef {
    RouteDef::post("/workers/{id}/resume", move |req: Request| {
        let m = m.clone();
        async move {
            let id = id_of(&req);
            let Some(row) = m.worker(&id).await? else { return Err(ApiError::NotFound("not found".into())) };
            // An archived worker stays at rest until it is restored.
            if row.is_archived() {
                return Err(ApiError::Conflict("worker is archived — restore first".into()));
            }
            m.sessions.resume(&id).await?;
            Ok(Response::json(200, &json!({"id": id, "port": 0})))
        }
    })
    .access(Access::open().phone(Tier::Low))
}

fn rewind_targets(m: AgentsModule) -> RouteDef {
    RouteDef::get("/workers/{id}/rewind-targets", move |req: Request| {
        let m = m.clone();
        async move {
            let id = id_of(&req);
            if m.worker(&id).await?.is_none() {
                return Err(ApiError::NotFound("worker not found".into()));
            }
            let Some(session) = m.sessions.session(&id) else {
                return Err(ApiError::Conflict("worker not running".into()));
            };
            if !session.capabilities().rewind {
                return Ok(Response::json(200, &RewindTargetsResponse { targets: Vec::new() }));
            }
            let targets = session.rewind_targets().await.map_err(|e| ApiError::Conflict(e.to_string()))?;
            Ok(Response::json(200, &RewindTargetsResponse { targets }))
        }
    })
    .access(Access::open().phone(Tier::Read))
}

fn rewind(m: AgentsModule) -> RouteDef {
    RouteDef::post("/workers/{id}/rewind", move |req: Request| {
        let m = m.clone();
        async move {
            let body: RewindRequest = req.parse()?;
            let id = id_of(&req);
            if m.worker(&id).await?.is_none() {
                return Err(ApiError::NotFound("worker not found".into()));
            }
            let Some(session) = m.sessions.session(&id) else {
                return Err(ApiError::Conflict("worker not running".into()));
            };
            if !session.capabilities().rewind {
                return Ok(Response::json(409, &json!({"ok": false, "error": "rewind not supported on this backend"})));
            }
            let back = match session.rewind(&body.uuid, body.mode).await {
                Ok(back) => back,
                Err(SessionError::Gone) => return Err(ApiError::Conflict("worker not running".into())),
                Err(e) => return Ok(Response::json(200, &json!({"ok": false, "error": e.to_string()}))),
            };
            // The chat hides what came after the prompt it went back to.
            let mode = serde_json::to_value(body.mode).unwrap_or_default();
            let note = json!({"uuid": back.uuid, "text": back.text, "display": back.display, "index": back.index, "mode": mode});
            let (worker, now) = (id.clone(), m.sessions.clock().now_ms());
            m.store
                .write(move |tx, out| {
                    let row = tx.events().append_json(&worker, now, WorkerEventType::ConversationRewound, &note)?;
                    out.push(WORKER_CHANGE, &json!({"workerId": worker, "rowId": row, "type": "conversation_rewound"}));
                    Ok(())
                })
                .await?;
            let answer = json!({"ok": true, "uuid": back.uuid, "text": back.text, "display": back.display, "index": back.index});
            Ok(Response::json(200, &answer))
        }
    })
    .access(Access::open().phone(Tier::High))
}

fn remove(m: AgentsModule) -> RouteDef {
    RouteDef::delete("/workers/{id}", move |req: Request| {
        let m = m.clone();
        async move {
            let gone = m.sessions.kill(&id_of(&req)).await?;
            let answer =
                json!({"killed": [], "removed": true, "was_state": gone.was_state, "id": gone.id, "name": gone.name});
            Ok(Response::json(200, &answer))
        }
    })
    .access(Access::open().phone(Tier::High))
}

fn unqueue(m: AgentsModule) -> RouteDef {
    RouteDef::delete("/workers/{id}/queue/{queueId}", move |req: Request| {
        let m = m.clone();
        async move {
            let id = id_of(&req);
            let Some(queue_id) = req.param("queueId").and_then(|q| q.parse::<i64>().ok()) else {
                return Err(ApiError::NotFound("not found".into()));
            };
            let removed = m
                .store
                .write(move |tx, out| {
                    let removed = tx.message_queue().remove_pending(&id, queue_id)?;
                    if removed {
                        out.push(WORKER_CHANGE, &json!({"workerId": id}));
                    }
                    Ok(removed)
                })
                .await?;
            Ok(Response::json(if removed { 200 } else { 404 }, &json!({"ok": removed})))
        }
    })
    .access(Access::open().phone(Tier::Low))
}
