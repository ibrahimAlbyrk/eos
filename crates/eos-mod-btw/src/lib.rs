//! The `/btw` side question: the chat's agent answers a read-only question from
//! its live conversation, without adding to it or interrupting a running turn.
//!
//! `POST /workers/:id/btw` (the user's dashboard) answers `{ answer }`. The
//! answer exists only in that response: nothing is logged, stored or
//! published, and a caller that goes away cancels the question.

use std::sync::Arc;

use eos_contracts::builtin_plugins::ids::BTW;
use eos_contracts::{SideQuestionAnswer, SideQuestionRequest};
use eos_core::Error;
use eos_core::agent::WorkerSessions;
use eos_core::store::Store;
use eos_runtime::access::Access;
use eos_runtime::http::{Request, Response};
use eos_runtime::module::Module;
use eos_runtime::router::RouteDef;

/// Asks the worker's agent `question` on the side.
///
/// Gated on what a session can do, never on which backend it is. A chat at
/// rest is revived first, as a message to it would revive it: after a
/// restart every idle chat is at rest, so most questions find no live
/// session yet.
pub async fn ask_side_question(
    store: &dyn Store,
    sessions: &dyn WorkerSessions,
    worker_id: &str,
    question: &str,
) -> Result<SideQuestionAnswer, Error> {
    let id = worker_id.to_owned();
    let worker = store.read(move |tx| tx.workers().find(&id)).await?;
    let worker = worker.ok_or_else(|| Error::not_found("worker", worker_id))?;
    if worker.is_archived() {
        return Err(Error::Conflict("worker is archived — restore first".into()));
    }
    let question = question.trim();
    if question.is_empty() {
        return Err(Error::Validation("question is empty".into()));
    }
    if sessions.capabilities().side_question != Some(true) {
        return Err(Error::Conflict("this agent can't answer side questions".into()));
    }
    sessions.revive(worker_id).await?;
    let Some(session) = sessions.session(worker_id) else {
        return Err(Error::Conflict("the agent isn't running".into()));
    };
    let answer = session.ask_side(question.to_owned()).await.map_err(|e| Error::Conflict(e.to_string()))?;
    Ok(SideQuestionAnswer { answer })
}

pub struct BtwModule {
    store: Arc<dyn Store>,
    sessions: Arc<dyn WorkerSessions>,
}

impl std::fmt::Debug for BtwModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BtwModule").finish_non_exhaustive()
    }
}

impl BtwModule {
    pub fn new(store: Arc<dyn Store>, sessions: Arc<dyn WorkerSessions>) -> Self {
        Self { store, sessions }
    }
}

impl Module for BtwModule {
    fn id(&self) -> &'static str {
        "btw"
    }

    fn plugin(&self) -> Option<&'static str> {
        Some(BTW)
    }

    fn routes(&self) -> Vec<RouteDef> {
        let (store, sessions) = (self.store.clone(), self.sessions.clone());
        // The handler is dropped when its caller leaves, and the question with it.
        let ask = RouteDef::post("/workers/{id}/btw", move |req: Request| {
            let (store, sessions) = (store.clone(), sessions.clone());
            async move {
                let body: SideQuestionRequest = req.parse()?;
                let id = req.param("id").unwrap_or_default();
                let answer = ask_side_question(store.as_ref(), sessions.as_ref(), id, &body.question).await?;
                Ok(Response::json(200, &answer))
            }
        });
        vec![ask.access(Access::ui_token())]
    }
}
