//! `message_reactions`: the emoji on a chat's messages.

use eos_contracts::ReactionActor;

use crate::Error;

/// One actor's reaction on one message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredReaction {
    /// The message's row in the log.
    pub event_id: i64,
    pub worker_id: String,
    pub actor: ReactionActor,
    /// `None`: taken back, and the agent has not heard of that yet.
    pub emoji: Option<String>,
    /// The user's only: the emoji the agent was last told about.
    pub told: Option<String>,
    pub at: i64,
}

pub trait ReactionRepo {
    fn find(&self, event_id: i64, actor: ReactionActor) -> Result<Option<StoredReaction>, Error>;
    /// Puts the actor's emoji on a message, in place of the one before;
    /// `None` takes it back. What the agent was told stays as it is.
    fn set(
        &self,
        worker_id: &str,
        event_id: i64,
        actor: ReactionActor,
        emoji: Option<&str>,
        now: i64,
    ) -> Result<(), Error>;
    /// The reactions on a worker's messages from row `from_id` to `to_id`
    /// (both included), by row then actor, at most `limit`.
    fn list(&self, worker_id: &str, from_id: i64, to_id: i64, limit: i64) -> Result<Vec<StoredReaction>, Error>;
    /// The user's reactions the agent has not heard the latest of: those on
    /// the newest `limit` such messages, oldest message first.
    fn untold(&self, worker_id: &str, limit: i64) -> Result<Vec<StoredReaction>, Error>;
    /// Records the emoji the agent was told is on a message (`None`: none).
    fn set_told(&self, event_id: i64, told: Option<&str>) -> Result<(), Error>;
    fn delete_by_worker(&self, worker_id: &str) -> Result<(), Error>;
    /// Drops the reactions whose message is gone; returns how many went.
    fn sweep_orphans(&self) -> Result<usize, Error>;
}
