//! Where a routine's results go out: the channels a delivery is sent through
//! (a pull request's review, a mail, a message), each implemented by the
//! capability that reaches the service. A channel sends what the gate
//! approved, to the target the gate checked, and nothing else.

use std::sync::Arc;

use eos_contracts::{ActionClass, ResultDoc};

use crate::BoxFuture;

/// What a channel's action is, and what it can promise.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChannelTraits {
    pub class: ActionClass,
    pub idempotency: Idempotency,
    pub undo: Undo,
    /// How long after a send it can be taken back.
    pub undo_window_ms: i64,
    /// The largest body it takes.
    pub max_bytes: usize,
}

/// How a send whose outcome is unknown is made safe to repeat.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Idempotency {
    /// The service takes the delivery's key and acts on it once.
    Native,
    /// What goes out carries a marker that a lookup finds.
    Marker,
    /// Neither: a send that may have gone out cannot be told apart.
    None,
}

/// How much of a send can be taken back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Undo {
    Full,
    /// Some of it stays (a review's comments go, the review stays).
    Partial,
    None,
}

/// One delivery to send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendRequest {
    /// The delivery's id: the same key on every attempt.
    pub key: String,
    /// The run whose result it sends.
    pub run_id: String,
    pub channel: String,
    pub action: String,
    /// From the delivery row the gate checked, never from a model's text.
    pub target: Target,
    pub body: ResultDoc,
}

/// Where one delivery goes: one recipient of the routine's Goes to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    /// The recipient's id in the Goes to.
    pub recipient_id: String,
    pub place: Place,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Place {
    /// The user, on one of their own channels.
    Me,
    /// An address the user wrote into the Goes to.
    Address(String),
    /// The place the run's item names (its pull request), by the item's key.
    Item(String),
}

/// What a send left at the service.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Receipt {
    /// The service's id of what went out (a review's id).
    pub id: String,
    /// Where the user sees it.
    pub url: Option<String>,
}

/// Whether the result still fits its subject.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fresh {
    Fresh,
    /// The subject moved on since the result was made (new commits).
    Stale {
        reason: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum UndoOutcome {
    Undone,
    /// Some of it stays.
    Partial,
    /// The window to take it back has passed.
    TooLate,
}

/// Why a channel call failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendError {
    pub kind: SendErrorKind,
    /// A short code the log may carry (`rate_limited`, `http_422`): never
    /// what was sent or to whom.
    pub detail_kind: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SendErrorKind {
    /// Try again later.
    Transient,
    /// Trying again cannot help.
    Permanent,
    /// It may have gone out.
    Uncertain,
    /// The capability's sign-in is missing or refused.
    Auth,
    /// The target is gone.
    NotFound,
    /// The user is writing their own draft at the target.
    UserDraftInProgress,
    /// A development run sends nothing.
    DevRun,
}

/// One channel: the actions one capability sends through.
pub trait Channel: Send + Sync {
    /// The traits of one of its actions; `None` for an action it lacks.
    fn traits(&self, action: &str) -> Option<ChannelTraits>;
    /// Whether the result still fits its subject, asked just before a send.
    fn precondition<'a>(&'a self, req: &'a SendRequest) -> BoxFuture<'a, Result<Fresh, SendError>>;
    fn send<'a>(&'a self, req: &'a SendRequest) -> BoxFuture<'a, Result<Receipt, SendError>>;
    /// What a send with this key left at the target, if it went out.
    fn lookup<'a>(&'a self, key: &'a str, target: &'a Target) -> BoxFuture<'a, Result<Option<Receipt>, SendError>>;
    fn undo<'a>(&'a self, receipt: &'a Receipt) -> BoxFuture<'a, Result<UndoOutcome, SendError>>;
}

/// Every channel, by name.
pub trait Channels: Send + Sync {
    fn get(&self, channel: &str) -> Option<Arc<dyn Channel>>;
}
