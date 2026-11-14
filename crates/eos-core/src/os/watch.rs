use std::path::Path;
use std::sync::Arc;

use eos_contracts::FsChangeEvent;

/// Receives the changes of one quiet window; never an empty batch.
pub type FsChangeSink = Arc<dyn Fn(FsChangeEvent) + Send + Sync>;

/// Holds a watch open. Dropping it gives the watch back; the system watch
/// behind it ends when the last holder is gone.
pub struct WatchLease(Option<Box<dyn FnOnce() + Send + Sync>>);

impl WatchLease {
    pub fn new(release: impl FnOnce() + Send + Sync + 'static) -> Self {
        Self(Some(Box::new(release)))
    }
}

impl Drop for WatchLease {
    fn drop(&mut self) {
        if let Some(release) = self.0.take() {
            release();
        }
    }
}

impl std::fmt::Debug for WatchLease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WatchLease")
    }
}

/// Watches folders for the Files panel: the direct entries of each watched
/// folder, nothing below them.
pub trait FileWatcher: Send + Sync {
    /// Starts watching `dir` until the lease is dropped. Callers watching the
    /// same folder share one system watch.
    fn watch(&self, dir: &Path) -> WatchLease;
    /// Ends every watch.
    fn close_all(&self);
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    #[test]
    fn a_lease_releases_once_when_dropped() {
        let released = Arc::new(AtomicUsize::new(0));
        let counter = released.clone();
        let lease = WatchLease::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(released.load(Ordering::SeqCst), 0);
        drop(lease);
        assert_eq!(released.load(Ordering::SeqCst), 1);
    }
}
