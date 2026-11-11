//! Fakes of the two watcher ports: they record what is watched and let a
//! test say that something changed.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use eos_core::git::GitWatcher;
use eos_core::os::{FileWatcher, WatchLease};

/// Counts the leases held per folder. Implements both `FileWatcher` and
/// `GitWatcher`: one fake per port in a test.
#[derive(Debug, Default, Clone)]
pub struct FakeWatcher {
    held: Arc<Mutex<Vec<PathBuf>>>,
    closed: Arc<Mutex<bool>>,
}

impl FakeWatcher {
    pub fn new() -> Self {
        Self::default()
    }

    /// The folders watched now, one entry per lease held, in the order taken.
    pub fn watched(&self) -> Vec<PathBuf> {
        self.held.lock().expect("lock").clone()
    }

    /// How many leases are held on `dir`.
    pub fn leases(&self, dir: &Path) -> usize {
        self.held.lock().expect("lock").iter().filter(|held| *held == dir).count()
    }

    pub fn is_closed(&self) -> bool {
        *self.closed.lock().expect("lock")
    }

    fn lease(&self, dir: &Path) -> WatchLease {
        self.held.lock().expect("lock").push(dir.to_owned());
        let (held, dir) = (self.held.clone(), dir.to_owned());
        WatchLease::new(move || {
            let mut held = held.lock().expect("lock");
            if let Some(at) = held.iter().position(|d| *d == dir) {
                held.remove(at);
            }
        })
    }

    fn close(&self) {
        *self.closed.lock().expect("lock") = true;
        self.held.lock().expect("lock").clear();
    }
}

impl FileWatcher for FakeWatcher {
    fn watch(&self, dir: &Path) -> WatchLease {
        self.lease(dir)
    }

    fn close_all(&self) {
        self.close();
    }
}

impl GitWatcher for FakeWatcher {
    fn watch(&self, dir: &Path) -> WatchLease {
        self.lease(dir)
    }

    fn close_all(&self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leases_are_counted_until_dropped() {
        let watcher = FakeWatcher::new();
        let (a, b) = (Path::new("/a"), Path::new("/b"));
        let first = FileWatcher::watch(&watcher, a);
        let second = GitWatcher::watch(&watcher, a);
        let other = FileWatcher::watch(&watcher, b);
        assert_eq!((watcher.leases(a), watcher.leases(b)), (2, 1));
        drop(first);
        assert_eq!(watcher.watched(), [a.to_owned(), b.to_owned()]);
        FileWatcher::close_all(&watcher);
        assert!(watcher.is_closed() && watcher.watched().is_empty());
        drop((second, other));
    }
}
