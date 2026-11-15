//! Emoji reactions on a chat's messages.
//!
//! The user puts an emoji on any message of a chat they talk to (a focused
//! chat, an orchestrator); the agent puts one on the user's messages with its
//! `react` tool. One per actor per message. The session service owns the
//! rules and tells the agent (`eos_sessions`, `reactions.rs`); these are the
//! dashboard's routes over it:
//!
//! - `GET /workers/:id/reactions?fromId=&toId=`: the reactions on the
//!   messages of a row range, for the part of the transcript a client holds;
//! - `PUT /workers/:id/reactions/:rowId` `{emoji}`: the user's reaction on
//!   that message. One on the agent's latest message, while the agent waits,
//!   starts a turn of the agent at once; any other goes with the user's next
//!   message;
//! - `DELETE /workers/:id/reactions/:rowId`: takes it back.
//!
//! Every change is announced on `reactions:change`, as is the moment the
//! agent was told (`seen`).

use eos_contracts::stream::topics;
use eos_contracts::{ReactionChange, ReactionRemoved, ReactionsResponse, SetReactionRequest};
use eos_runtime::access::{Access, Tier};
use eos_runtime::bus::{Topic, TopicDecl};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::module::Module;
use eos_runtime::router::RouteDef;
use eos_sessions::Sessions;

pub const REACTIONS_CHANGE: Topic<ReactionChange> = Topic::new(topics::REACTIONS_CHANGE);

/// The most reactions one answer lists.
const LIST_MAX: i64 = 5000;

pub struct ReactionsModule {
    sessions: Sessions,
}

impl std::fmt::Debug for ReactionsModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReactionsModule").finish_non_exhaustive()
    }
}

impl ReactionsModule {
    pub fn new(sessions: Sessions) -> Self {
        Self { sessions }
    }
}

fn worker_of(req: &Request) -> String {
    req.param("id").unwrap_or_default().to_owned()
}

fn row_of(req: &Request) -> Result<i64, ApiError> {
    let row = req.param("rowId").and_then(|row| row.parse::<i64>().ok()).filter(|row| *row > 0);
    row.ok_or_else(|| ApiError::NotFound("message not found".into()))
}

/// A row id of the query; `None` when the key is absent.
fn bound(req: &Request, key: &str) -> Result<Option<i64>, ApiError> {
    match req.query().get(key) {
        None => Ok(None),
        Some(value) => match value.parse::<i64>() {
            Ok(row) if row >= 0 => Ok(Some(row)),
            _ => Err(ApiError::invalid([(key, "Expected a row id")])),
        },
    }
}

impl Module for ReactionsModule {
    fn id(&self) -> &'static str {
        "reactions"
    }

    fn topics(&self) -> Vec<TopicDecl> {
        vec![REACTIONS_CHANGE.decl()]
    }

    fn routes(&self) -> Vec<RouteDef> {
        let sessions = self.sessions.clone();
        let list = RouteDef::get("/workers/{id}/reactions", move |req: Request| {
            let sessions = sessions.clone();
            async move {
                let (from, to) = (bound(&req, "fromId")?.unwrap_or(0), bound(&req, "toId")?.unwrap_or(i64::MAX));
                let reactions = sessions.reactions(&worker_of(&req), from, to, LIST_MAX).await?;
                Ok(Response::json(200, &ReactionsResponse { reactions }))
            }
        });
        let sessions = self.sessions.clone();
        let set = RouteDef::put("/workers/{id}/reactions/{rowId}", move |req: Request| {
            let sessions = sessions.clone();
            async move {
                let body: SetReactionRequest = req.parse()?;
                let set = sessions.react_as_user(&worker_of(&req), row_of(&req)?, &body.emoji).await?;
                Ok(Response::json(200, &set))
            }
        });
        let sessions = self.sessions.clone();
        let clear = RouteDef::delete("/workers/{id}/reactions/{rowId}", move |req: Request| {
            let sessions = sessions.clone();
            async move {
                let removed = sessions.unreact_as_user(&worker_of(&req), row_of(&req)?).await?;
                Ok(Response::json(200, &ReactionRemoved { removed }))
            }
        });
        // A reaction can stand in for the user's answer: only their own dashboard, or their phone, leaves one.
        let as_the_user = Access::ui_token().phone_user(Tier::Low);
        vec![list.access(Access::open().phone(Tier::Read)), set.access(as_the_user), clear.access(as_the_user)]
    }
}
