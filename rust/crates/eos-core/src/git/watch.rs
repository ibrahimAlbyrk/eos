use std::path::Path;
use std::sync::Arc;

use eos_contracts::GitChangeEvent;

use crate::os::WatchLease;

/// Receives one event per working tree whose git state changed, after the
/// changes of one operation were gathered. `kinds` is never empty.
pub type GitChangeSink = Arc<dyn Fn(GitChangeEvent) + Send + Sync>;

/// Watches the git state of working trees: HEAD, the index, refs, stashes,
/// merge state and the files themselves.
pub trait GitWatcher: Send + Sync {
    /// Starts watching `dir` (any number of callers share one set of system
    /// watches) until the lease is dropped. Events carry this same `dir`.
    fn watch(&self, dir: &Path) -> WatchLease;
    /// Ends every watch.
    fn close_all(&self);
}
