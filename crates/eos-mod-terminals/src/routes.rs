//! The terminal routes, and the `!` command routes of a worker.
//!
//! Every one of them is the user's alone: a shell is arbitrary execution, so
//! nothing that merely runs on this computer may reach it. The phone gets
//! them through its gateway, which vouches for the user — except resizing:
//! a phone mirrors a terminal at the size the desktop gave it.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use eos_contracts::{
    PtyAnswerRequest, PtyBufferResponse, PtyConversationResponse, PtyCreateRequest, PtyInputRequest, PtyListResponse,
    PtyMessageRequest, PtyPendingName, PtyResizeRequest, TerminalRunRequest, TerminalRunResponse,
    WorkspaceTerminalRunRequest,
};
use eos_core::store::Store;
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::{Value, json};

use crate::conversation::{Conversation, Conversations};
use crate::deliver::deliver_prompt;
use crate::keys::{QuestionShape, answer_steps, approve_plan_steps, is_shell_process};
use crate::runs::Runs;
use crate::sessions::Sessions;

#[derive(Serialize)]
struct Done {
    ok: bool,
}

fn done() -> Result<Response, ApiError> {
    Ok(Response::json(200, &Done { ok: true }))
}

fn no_session() -> ApiError {
    ApiError::NotFound("session not found".into())
}

fn id_of(req: &Request) -> String {
    req.param("id").unwrap_or_default().to_owned()
}

/// Dialog calls already answered from here: a second device (or a double
/// tap) answering the same dialog would type its keys into the composer
/// instead. The newest are remembered; a dialog is long closed by the time
/// its id falls out.
#[derive(Default)]
struct Answered(Mutex<VecDeque<String>>);

impl Answered {
    const KEPT: usize = 256;

    fn has(&self, id: &str) -> bool {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).iter().any(|seen| seen == id)
    }

    fn add(&self, id: &str) {
        let mut seen = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if seen.len() >= Self::KEPT {
            seen.pop_front();
        }
        seen.push_back(id.to_owned());
    }
}

/// The pane's conversation, when Claude (not the shell it drops back to) is
/// in the foreground to receive keys.
async fn claude_ready(sessions: &Sessions, conversations: &Conversations, id: &str) -> Result<Conversation, ApiError> {
    let conversation = conversations.get(id).await.ok_or_else(|| ApiError::NotFound("no claude session".into()))?;
    match sessions.foreground(id).await {
        Some(program) if !is_shell_process(&program) => Ok(conversation),
        _ => Err(ApiError::Conflict("Claude is not running in this terminal".into())),
    }
}

/// What the keys address in each question of an AskUserQuestion call.
fn ask_shapes(input: &IndexMap<String, Value>) -> Vec<QuestionShape> {
    let questions = input.get("questions").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    questions
        .iter()
        .map(|q| QuestionShape {
            multi_select: q.get("multiSelect") == Some(&Value::Bool(true)),
            option_count: q.get("options").and_then(Value::as_array).map_or(0, Vec::len),
        })
        .collect()
}

/// `Number(text) || 0` for a row id.
fn after_id(req: &Request) -> f64 {
    let raw = req.query().get("afterId").unwrap_or_default();
    Some(raw.trim().parse::<f64>().unwrap_or(0.0)).filter(|n| n.is_finite()).unwrap_or(0.0)
}

pub(crate) fn pty(sessions: Sessions, conversations: Conversations) -> Vec<RouteDef> {
    let user = |tier: Tier| Access::ui_token().phone_user(tier);
    let answered = Arc::new(Answered::default());

    let create = {
        let sessions = sessions.clone();
        move |req: Request| {
            let sessions = sessions.clone();
            async move {
                let body: PtyCreateRequest = req.parse()?;
                Ok(Response::json(200, &sessions.create(body).await?))
            }
        }
    };
    let list = {
        let sessions = sessions.clone();
        move |_req: Request| {
            let body = PtyListResponse { sessions: sessions.list() };
            async move { Ok(Response::json(200, &body)) }
        }
    };
    let input = {
        let sessions = sessions.clone();
        move |req: Request| {
            let sessions = sessions.clone();
            async move {
                let body: PtyInputRequest = req.parse()?;
                let id = id_of(&req);
                // A numbered piece of a client's input stream goes out in its order.
                let ok = match (body.stream.as_deref().filter(|s| !s.is_empty()), body.seq.filter(|s| *s > 0)) {
                    (Some(stream), Some(seq)) => sessions.input_in_order(&id, stream, seq.unsigned_abs(), &body.data),
                    _ => sessions.input(&id, &body.data),
                };
                if ok { done() } else { Err(no_session()) }
            }
        }
    };
    let resize = {
        let sessions = sessions.clone();
        move |req: Request| {
            let sessions = sessions.clone();
            async move {
                let body: PtyResizeRequest = req.parse()?;
                if sessions.resize(&id_of(&req), body.cols, body.rows) { done() } else { Err(no_session()) }
            }
        }
    };
    let buffer = {
        let sessions = sessions.clone();
        move |req: Request| {
            let sessions = sessions.clone();
            async move {
                let id = id_of(&req);
                // A long history takes a moment to write out.
                let snapshot = tokio::task::spawn_blocking(move || sessions.buffer(&id))
                    .await
                    .map_err(|e| ApiError::Internal(e.to_string()))?;
                let (seq, data) = snapshot.ok_or_else(no_session)?;
                Ok(Response::json(200, &PtyBufferResponse { seq, data }))
            }
        }
    };
    let conversation = {
        let conversations = conversations.clone();
        move |req: Request| {
            let conversations = conversations.clone();
            async move {
                let found = conversations.get(&id_of(&req)).await;
                let Conversation { claude_session_id, view } =
                    found.ok_or_else(|| ApiError::NotFound("no claude session".into()))?;
                let after = after_id(&req);
                let body = PtyConversationResponse {
                    claude_session_id,
                    rows: view.rows.into_iter().filter(|row| row.id as f64 > after).collect(),
                    running: view.running,
                    pending: view.pending,
                };
                Ok(Response::json(200, &body))
            }
        }
    };
    let message = {
        let (sessions, conversations) = (sessions.clone(), conversations.clone());
        move |req: Request| {
            let (sessions, conversations) = (sessions.clone(), conversations.clone());
            async move {
                let body: PtyMessageRequest = req.parse()?;
                let id = id_of(&req);
                let conversation = claude_ready(&sessions, &conversations, &id).await?;
                // Typed into an open dialog, the prompt would answer it with garbage.
                if let Some(pending) = conversation.view.pending {
                    let refusal = json!({ "error": "Claude is waiting for an answer", "pending": pending.name });
                    return Ok(Response::json(409, &refusal));
                }
                if deliver_prompt(&sessions, &conversations, &id, &body.text).await {
                    done()
                } else {
                    Err(no_session())
                }
            }
        }
    };
    let answer = {
        let (sessions, conversations) = (sessions.clone(), conversations.clone());
        move |req: Request| {
            let (sessions, conversations, answered) = (sessions.clone(), conversations.clone(), answered.clone());
            async move {
                let body: PtyAnswerRequest = req.parse()?;
                let id = id_of(&req);
                let conversation = claude_ready(&sessions, &conversations, &id).await?;
                let pending = conversation
                    .view
                    .pending
                    .filter(|p| p.tool_use_id == body.tool_use_id && !answered.has(&body.tool_use_id))
                    .ok_or_else(|| ApiError::Conflict("that question is no longer open".into()))?;
                let steps = match pending.name {
                    PtyPendingName::ExitPlanMode if body.approve.is_none() => {
                        return Err(ApiError::Domain("expected approve: true".into()));
                    }
                    PtyPendingName::ExitPlanMode => approve_plan_steps(),
                    PtyPendingName::AskUserQuestion => {
                        answer_steps(&ask_shapes(&pending.input), body.answers.as_deref().unwrap_or_default())
                            .map_err(|e| ApiError::Domain(e.0))?
                    }
                };
                answered.add(&body.tool_use_id);
                if sessions.send_steps(&id, &steps).await { done() } else { Err(no_session()) }
            }
        }
    };
    let close = move |req: Request| {
        let killed = sessions.kill(&id_of(&req));
        async move { if killed { done() } else { Err(no_session()) } }
    };

    vec![
        RouteDef::post("/pty", create).access(user(Tier::High)),
        RouteDef::get("/pty", list).access(user(Tier::Read)),
        RouteDef::post("/pty/{id}/input", input).access(user(Tier::High)),
        // Not the phone's: it draws at the size the desktop set.
        RouteDef::post("/pty/{id}/resize", resize).access(Access::ui_token()),
        RouteDef::get("/pty/{id}/buffer", buffer).access(user(Tier::Read)),
        RouteDef::get("/pty/{id}/conversation", conversation).access(user(Tier::Read)),
        RouteDef::post("/pty/{id}/message", message).access(user(Tier::High)),
        RouteDef::post("/pty/{id}/answer", answer).access(user(Tier::High)),
        RouteDef::delete("/pty/{id}", close).access(user(Tier::High)),
    ]
}

pub(crate) fn commands(runs: Runs, store: Arc<dyn Store>) -> Vec<RouteDef> {
    let in_chat = {
        let runs = runs.clone();
        move |req: Request| {
            let (runs, store) = (runs.clone(), store.clone());
            async move {
                let body: TerminalRunRequest = req.parse()?;
                let id = id_of(&req);
                let found = id.clone();
                let worker = store.read(move |tx| tx.workers().find(&found)).await?;
                let worker = worker.ok_or_else(|| ApiError::NotFound("worker not found".into()))?;
                let cwd =
                    worker.work_dir().ok_or_else(|| ApiError::Domain("worker has no working directory".into()))?;
                Ok(Response::json(200, &TerminalRunResponse { run_id: runs.run(Some(&id), cwd, &body.command) }))
            }
        }
    };
    // No chat selected: a folder of the user's choosing, and nothing is saved.
    let in_folder = {
        let runs = runs.clone();
        move |req: Request| {
            let runs = runs.clone();
            async move {
                let body: WorkspaceTerminalRunRequest = req.parse()?;
                let cwd = runs.folder(body.cwd).await.ok_or_else(|| ApiError::Domain("cwd does not exist".into()))?;
                Ok(Response::json(200, &TerminalRunResponse { run_id: runs.run(None, &cwd, &body.command) }))
            }
        }
    };
    // By run id: one route for runs in a chat and in a folder alike.
    let kill = move |req: Request| {
        let ok = runs.kill(req.param("runId").unwrap_or_default());
        async move { Ok(Response::json(200, &Done { ok })) }
    };
    vec![
        RouteDef::post("/workers/{id}/terminal", in_chat).access(Access::ui_token().phone_user(Tier::High)),
        RouteDef::post("/terminal", in_folder).access(Access::ui_token().phone_user(Tier::High)),
        RouteDef::post("/terminal/{runId}/kill", kill).access(Access::ui_token().phone(Tier::High)),
    ]
}
