//! What this crate needs from crates that are still being written.
//!
//! Each item names the type that replaces it. Nothing else in the crate
//! invents a contract shape: swap the definition here and the rest follows.

use std::any::Any;
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Wall-clock milliseconds. Replaced by `eos_core::Clock`.
pub trait Clock: Send + Sync + 'static {
    fn now_ms(&self) -> u64;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
    }
}

/// The ids this crate mints. Replaced by the id port of `eos-core`.
pub trait Ids: Send + Sync + 'static {
    /// `r-` + 8 base36 characters, as today.
    fn request_id(&self) -> String;
    /// 12 hex characters naming one run of the stream, as today.
    fn stream_epoch(&self) -> String;
}

/// Ids from the process's randomly keyed hasher: unpredictable enough to tell
/// requests and stream runs apart, with no extra dependency.
#[derive(Debug, Default)]
pub struct RandomIds {
    counter: AtomicU64,
}

impl RandomIds {
    fn next(&self) -> u64 {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(self.counter.fetch_add(1, Ordering::Relaxed));
        h.finish()
    }
}

impl Ids for RandomIds {
    fn request_id(&self) -> String {
        const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
        let mut n = self.next();
        let mut out = String::with_capacity(10);
        out.push_str("r-");
        for _ in 0..8 {
            out.push(DIGITS[(n % 36) as usize] as char);
            n /= 36;
        }
        out
    }

    fn stream_epoch(&self) -> String {
        format!("{:012x}", self.next() & 0xffff_ffff_ffff)
    }
}

/// One event of an agent's session. Replaced by the canonical `AgentEvent` of
/// `eos-contracts`.
pub type AgentEvent = serde_json::Value;

/// One piece of a tool's input while the model writes it. Replaced by the
/// `ToolInputDelta` of `eos-core`.
pub type ToolInputDelta = serde_json::Value;

/// A value the runtime carries for another crate without knowing its type
/// (a slash command, a sync domain). The owner downcasts it.
pub type Opaque = Arc<dyn Any + Send + Sync>;

/// Topic names the runtime itself reads. Replaced by the topic constants of
/// `eos-contracts`.
pub mod topics {
    pub const AGENT_DELTA: &str = "agent:delta";
    pub const WORKER_EXIT: &str = "worker:exit";
    pub const WORKER_REMOVED: &str = "worker:removed";
    pub const JOBS_CHANGE: &str = "jobs:change";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_have_todays_shape() {
        let ids = RandomIds::default();
        let r = ids.request_id();
        assert!(r.starts_with("r-") && r.len() == 10, "{r}");
        assert_ne!(r, ids.request_id());
        let e = ids.stream_epoch();
        assert_eq!(e.len(), 12);
        assert!(e.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()), "{e}");
    }
}
