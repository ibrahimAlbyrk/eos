//! What agents ask of other features through their tools: an orchestrator
//! acting on its workers, a worker reporting back, workers consulting each
//! other. Each call answers what the route the tool called answered the same
//! agent — the same checks, the same refusals.

use eos_contracts::{IntegrateWorkersResponse, PeerListItem, PeerRef, SpawnWorkerRequest};

use crate::BoxFuture;

/// A refused or failed operation: the status and `error` text the route
/// behind the tool answered. The agent reads both.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct Refused {
    pub status: u16,
    pub message: String,
}

impl Refused {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self { status, message: message.into() }
    }
}

/// Where a session works.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SessionFolder {
    /// Its folder (its worktree, when it has one); empty when it has none.
    pub cwd: String,
    /// The folder is inside a git repository.
    pub git_repo: bool,
}

/// A started worker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnedWorker {
    pub id: String,
    /// `worktree` or `cwd`: where it works.
    pub isolation: String,
}

/// A removed worker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KilledWorker {
    pub id: String,
    pub name: Option<String>,
    pub removed: bool,
    pub was_state: String,
}

/// A directive that reached its worker (or its queue).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectiveSent {
    pub id: String,
    pub name: Option<String>,
}

/// An orchestrator's hold on its workers and a worker's line to its parent
/// (`spawn_worker`, `message_worker`, `kill_worker`, `integrate_workers`,
/// `send_message_to_parent`).
pub trait WorkerControl: Send + Sync + 'static {
    /// Where `worker_id` works: a worker it starts gets its own worktree of
    /// that repository, or the folder itself when git does not know it.
    fn folder<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, SessionFolder>;

    /// Starts a worker as `POST /workers` does.
    fn spawn(&self, request: SpawnWorkerRequest) -> BoxFuture<'_, Result<SpawnedWorker, Refused>>;

    /// A parent's follow-up for one of its workers: a new turn, queued while
    /// the worker is busy.
    fn message<'a>(
        &'a self,
        parent_id: &'a str,
        worker_id: &'a str,
        text: String,
    ) -> BoxFuture<'a, Result<DirectiveSent, Refused>>;

    /// Stops and removes one of `actor_id`'s workers.
    fn kill<'a>(&'a self, actor_id: &'a str, worker_id: &'a str) -> BoxFuture<'a, Result<KilledWorker, Refused>>;

    /// A worker's report to its parent: delivered as a turn of the parent,
    /// queued while it is busy.
    fn report<'a>(&'a self, worker_id: &'a str, text: String) -> BoxFuture<'a, Result<(), Refused>>;

    /// Merges the branches of an orchestrator's workers (all, or `ids`) into
    /// an integration branch.
    fn integrate<'a>(
        &'a self,
        orchestrator_id: &'a str,
        ids: Option<Vec<String>>,
    ) -> BoxFuture<'a, Result<IntegrateWorkersResponse, Refused>>;
}

/// How a consultation of a peer ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PeerConsult {
    Answered(String),
    /// The request was turned away before it reached anyone.
    NotSent {
        reason: Option<String>,
    },
    /// The peer declined to answer.
    Declined {
        reason: Option<String>,
    },
    /// The peer stopped before answering.
    Gone,
}

/// Where a worker's answer to a peer went; `None` when no request was
/// waiting on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerAnswered {
    pub to_worker: Option<String>,
    pub to_name: Option<String>,
}

/// Workers of one orchestrator consulting each other (`list_peers`,
/// `ask_peer`, `respond_to_peer`).
pub trait Peers: Send + Sync + 'static {
    /// The collaborating siblings `worker_id` may consult.
    fn list<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, Result<Vec<PeerListItem>, Refused>>;

    /// Asks a peer and waits for its answer; a peer named before it exists
    /// is waited for. Dropping the future withdraws the request.
    fn ask<'a>(
        &'a self,
        worker_id: &'a str,
        target: PeerRef,
        question: String,
    ) -> BoxFuture<'a, Result<PeerConsult, Refused>>;

    /// Answers the request delivered to `worker_id` this turn.
    fn respond<'a>(
        &'a self,
        worker_id: &'a str,
        answer: String,
    ) -> BoxFuture<'a, Result<Option<PeerAnswered>, Refused>>;
}

/// Whether a worker waits on the user's answer, for the lists that flag it.
pub trait OpenQuestions: Send + Sync + 'static {
    fn has_open(&self, worker_id: &str) -> bool;
}
