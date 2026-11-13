//! Fakes of the two watcher ports and of what the git watcher feeds
//! (`RepoState`): they record what is watched and what they were told.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use eos_core::git::{GitDirs, GitWatcher, RepoChange, RepoState};
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

/// One call a [`FakeRepoState`] received.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RepoStateCall {
    Watching {
        toplevel: PathBuf,
        whole: bool,
    },
    Unwatching {
        toplevel: PathBuf,
        whole: bool,
    },
    Changed {
        toplevel: PathBuf,
        change: RepoChange,
    },
    Settled {
        toplevel: PathBuf,
    },
    Lost,
    Touched {
        path: PathBuf,
    },
    /// Something the test noted in between (an event that went out, say).
    Mark(String),
}

/// `RepoState` that records every call in order; `then` runs after each
/// one (a test can note what else happened by then).
#[derive(Default, Clone)]
pub struct FakeRepoState {
    calls: Arc<Mutex<Vec<RepoStateCall>>>,
}

impl std::fmt::Debug for FakeRepoState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FakeRepoState").field("calls", &self.calls()).finish()
    }
}

impl FakeRepoState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn calls(&self) -> Vec<RepoStateCall> {
        self.calls.lock().expect("lock").clone()
    }

    /// Records a call made by something else, in the same order (a sink of the watcher, say).
    pub fn note(&self, call: RepoStateCall) {
        self.calls.lock().expect("lock").push(call);
    }
}

impl RepoState for FakeRepoState {
    fn watching(&self, dirs: &GitDirs, whole: bool) {
        self.note(RepoStateCall::Watching { toplevel: dirs.toplevel.clone(), whole });
    }

    fn unwatching(&self, dirs: &GitDirs, whole: bool) {
        self.note(RepoStateCall::Unwatching { toplevel: dirs.toplevel.clone(), whole });
    }

    fn changed(&self, toplevel: &Path, change: RepoChange) {
        self.note(RepoStateCall::Changed { toplevel: toplevel.to_owned(), change });
    }

    fn settled(&self, toplevel: &Path) {
        self.note(RepoStateCall::Settled { toplevel: toplevel.to_owned() });
    }

    fn lost(&self) {
        self.note(RepoStateCall::Lost);
    }

    fn touched(&self, path: &Path) {
        self.note(RepoStateCall::Touched { path: path.to_owned() });
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
