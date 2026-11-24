//! Events outside services send this computer while it is closed or asleep
//! (07 §4.7): each service posts to a hook URL on the relay, the relay seals
//! the event to this computer's key and keeps it, and this computer reads
//! the inbox when it can. Hook URLs, bodies and headers are the services'
//! content and capabilities: never logged.

use crate::{BoxFuture, Error};

/// A hook an outside service posts to.
#[derive(Clone, PartialEq, Eq)]
pub struct HookUrl {
    /// 32 hex characters, unique on the relay.
    pub id: String,
    /// Where the service posts (`https://relay/hooks/v1/<inbox>/<hook>`).
    /// Whoever holds it can post: it is the capability.
    pub url: String,
}

impl std::fmt::Debug for HookUrl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("HookUrl")
    }
}

/// One event as the service sent it, opened. Not trusted: the source checks
/// its signature before anything acts on it.
#[derive(Clone, PartialEq, Eq)]
pub struct HookEvent {
    pub seq: u64,
    /// The hook it was posted to.
    pub hook: String,
    /// When the relay took it, in milliseconds since the epoch.
    pub received_at: i64,
    /// Lower-case names, in the order the service sent them.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl std::fmt::Debug for HookEvent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HookEvent").field("seq", &self.seq).field("bytes", &self.body.len()).finish_non_exhaustive()
    }
}

/// What the inbox held after a cursor.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HookBatch {
    /// The inbox's latest sequence number: ack through it once the batch is handled.
    pub head: u64,
    pub events: Vec<HookEvent>,
    /// Entries in this batch that did not open with this computer's key or
    /// were not an event: dropped, never guessed at.
    pub unreadable: u32,
    /// Events the relay dropped unread over its lifetime (kept 7 days); a
    /// rise means some were missed.
    pub dropped: u64,
}

pub trait HookInbox: Send + Sync + 'static {
    /// Makes sure the relay holds this computer's inbox, with its current key.
    fn ensure(&self) -> BoxFuture<'_, Result<(), Error>>;
    /// A new hook in the inbox.
    fn create_hook(&self) -> BoxFuture<'_, Result<HookUrl, Error>>;
    /// The hook's URL stops taking events.
    fn revoke_hook<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), Error>>;
    /// Events after `since`. With `wait_ms > 0` and nothing new, the relay
    /// holds the request until an event lands or the wait runs out (at most
    /// 25 s). Dropping the future gives the wait up.
    fn next(&self, since: u64, wait_ms: u64) -> BoxFuture<'_, Result<HookBatch, Error>>;
    /// The relay deletes the events through `through`.
    fn ack(&self, through: u64) -> BoxFuture<'_, Result<(), Error>>;
}
