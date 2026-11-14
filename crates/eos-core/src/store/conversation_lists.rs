//! The facts a chat's conversation-wide lists (its subagents, its artifacts)
//! are derived from, kept beside the log (`conversation_list_facts`).
//!
//! The log's own writes keep it current for every worker read into it once.
//! A build that does not know it writes, prunes and removes rows without it,
//! so a reader first asks whether it is [current](ConversationListRepo::is_current)
//! and, when not, lets [`catch_up`](ConversationListRepo::catch_up) read the
//! rest of the log in.

use eos_domain::transcript::IndexedRow;

use crate::Error;

pub trait ConversationListRepo {
    /// Counts every change of the worker's facts: what was derived from them
    /// holds while it stays the same. `None` before the worker is read in.
    fn version(&self, worker_id: &str) -> Result<Option<i64>, Error>;
    /// Whether the worker's facts reflect every row of its log, and no row
    /// that is gone.
    fn is_current(&self, worker_id: &str) -> Result<bool, Error>;
    /// Reads up to `limit` more of the worker's log in and drops the facts of
    /// rows that are gone; `true` once it is current.
    fn catch_up(&self, worker_id: &str, limit: i64) -> Result<bool, Error>;
    /// Every row of the worker that has facts, in insertion order.
    fn facts(&self, worker_id: &str) -> Result<Vec<IndexedRow>, Error>;
}
