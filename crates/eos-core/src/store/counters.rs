//! Small per-worker tables: message numbering, context marks, and the queue of
//! worktrees to remove.

use crate::Error;

/// Numbers a worker's messages: `seq` for each inbound one, `seq.sub` for
/// each assistant message after it.
pub trait MessageIdRepo {
    /// The number of the next inbound message; assistant numbering restarts.
    fn next_inbound(&self, worker_id: &str) -> Result<i64, Error>;
    /// `<seq>.<sub>` of the next assistant message.
    fn next_assistant(&self, worker_id: &str) -> Result<String, Error>;
    fn delete_by_worker(&self, worker_id: &str) -> Result<(), Error>;
}

/// Remembers that a worker was told its context is filling up, once per stage.
pub trait ContextMarkRepo {
    /// Sets the mark; `false` when it was already set.
    fn mark(&self, worker_id: &str, stage: &str, now: i64) -> Result<bool, Error>;
    fn clear(&self, worker_id: &str) -> Result<(), Error>;
    fn has(&self, worker_id: &str, stage: &str) -> Result<bool, Error>;
}

/// A worktree whose removal survives a restart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeRemoval {
    pub id: String,
    pub worker_id: String,
    pub repo_root: String,
    pub worktree_dir: Option<String>,
    pub branch: String,
    pub scheduled_at: i64,
}

pub trait WorktreeRemovalQueue {
    /// Adds an entry, or replaces the one with the same id.
    fn enqueue(&self, entry: &WorktreeRemoval) -> Result<(), Error>;
    /// Oldest first.
    fn list(&self) -> Result<Vec<WorktreeRemoval>, Error>;
    fn delete(&self, id: &str) -> Result<(), Error>;
}
