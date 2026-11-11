//! The `queued_messages` table: messages for a busy worker, and the record
//! that makes a repeated send harmless (`core/src/ports/MessageQueueRepo.ts`).

use eos_domain::message_queue::{MessagePlane, QueueMeta, QueuedMessage};

use crate::Error;

#[derive(Debug, Clone, PartialEq)]
pub struct NewQueuedMessage {
    pub worker_id: String,
    pub client_msg_id: Option<String>,
    pub text: String,
    pub created_at: i64,
    /// Set when the message was delivered at once and is only recorded.
    pub dispatched_at: Option<i64>,
    pub meta: QueueMeta,
    pub plane: MessagePlane,
}

pub trait MessageQueueRepo {
    /// Queues a message and returns its id; `None` when this worker already
    /// has one with the same client id (the send is a repeat).
    fn insert(&self, new: &NewQueuedMessage) -> Result<Option<i64>, Error>;
    /// Waiting messages of both planes, oldest first.
    fn list_pending(&self, worker_id: &str) -> Result<Vec<QueuedMessage>, Error>;
    /// Waiting messages the user sent, oldest first.
    fn list_pending_user_plane(&self, worker_id: &str) -> Result<Vec<QueuedMessage>, Error>;
    fn mark_dispatched(&self, ids: &[i64], ts: i64) -> Result<(), Error>;
    fn remove_by_id(&self, id: i64) -> Result<(), Error>;
    fn remove_dispatched_by_client_msg_id(&self, worker_id: &str, client_msg_id: &str) -> Result<(), Error>;
    /// Removes one waiting message; `false` when it is gone or already delivered.
    fn remove_pending(&self, worker_id: &str, id: i64) -> Result<bool, Error>;
    /// Removes every waiting message; returns how many.
    fn clear_pending(&self, worker_id: &str) -> Result<usize, Error>;
    fn clear_pending_user_plane(&self, worker_id: &str) -> Result<usize, Error>;
    /// Whether the same text was delivered to the worker after `since`.
    fn has_recent_dispatch(&self, worker_id: &str, text: &str, since: i64) -> Result<bool, Error>;
    fn delete_by_worker(&self, worker_id: &str) -> Result<(), Error>;
    /// Forgets delivered messages older than `before`. Waiting ones are never pruned.
    fn prune(&self, before: i64) -> Result<(), Error>;
}
