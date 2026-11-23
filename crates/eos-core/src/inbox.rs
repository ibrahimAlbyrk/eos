//! What Needs you offers the other areas: where a run worker's permission
//! ask shows, the gate a surface's direct action passes, and the user's
//! edits of results for memory to learn from.

use eos_contracts::{ActionClass, PartEdit, ResultDoc};

use crate::store::Tx;
use crate::{BoxFuture, Error};

/// Where a permission ask shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AskRoute {
    /// The "Approval needed" banner, as for a chat.
    Banner,
    /// Needs you only: the ask of a routine run's worker.
    Inbox,
}

/// Where the permission gateway shows an ask.
pub trait AskRouting: Send + Sync {
    /// Called inside the ask's write job.
    fn route(&self, tx: &dyn Tx, worker_id: &str) -> AskRoute;
}

/// An action a surface wants to take for a routine.
#[derive(Debug, Clone, PartialEq)]
pub struct ActionRequest {
    /// Empty for an action pressed outside any routine's surface.
    pub routine_id: String,
    pub class: ActionClass,
    /// The action, as its capability names it.
    pub action_id: String,
    /// What the user sees it called.
    pub title: String,
    /// Its arguments as the core typed them, kept with a held draft.
    pub args: serde_json::Value,
    /// Where it was asked from.
    pub origin: String,
}

/// What the gate lets an action do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionDecision {
    Run,
    /// The user confirms first, by typing what `prompt` asks.
    Confirm {
        prompt: String,
    },
    /// Held as a draft in Needs you.
    Hold {
        item_id: String,
    },
    Refuse {
        reason: String,
    },
}

/// The gate a direct action passes before its capability is called.
pub trait ActionGate: Send + Sync {
    fn decide<'a>(&'a self, request: &'a ActionRequest) -> BoxFuture<'a, Result<ActionDecision, Error>>;
}

/// The user's edit of a result before it went out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResultEdit {
    /// Edits are numbered in the order they were made.
    pub id: i64,
    pub item_id: String,
    pub delivery_id: Option<String>,
    pub routine_id: String,
    pub run_id: String,
    pub before: ResultDoc,
    pub after: ResultDoc,
    pub ops: Vec<PartEdit>,
    /// The draft was made from text from outside.
    pub derived_from_untrusted: bool,
    pub at: i64,
}

/// The edits of results, read in order from a cursor kept by the reader, so
/// none is missed across a crash.
pub trait ResultEdits: Send + Sync {
    /// Up to `limit` edits after the one numbered `cursor` (0: from the
    /// first), oldest first.
    fn list_since(&self, cursor: i64, limit: usize) -> BoxFuture<'_, Result<Vec<ResultEdit>, Error>>;
    fn get(&self, edit_id: i64) -> BoxFuture<'_, Result<Option<ResultEdit>, Error>>;
}
