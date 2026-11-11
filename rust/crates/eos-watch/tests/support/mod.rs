//! What the watcher tests share: a sink that can be waited on, and a way to
//! count what the process holds open.

#![allow(dead_code, clippy::missing_panics_doc)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// How long a test waits for the system to report a change.
pub(crate) const PATIENCE: Duration = Duration::from_secs(10);

/// Collects what a watcher sends; a test waits on it instead of sleeping.
pub(crate) struct Collected<T> {
    items: Mutex<Vec<T>>,
    arrived: Condvar,
}

impl<T: Clone + Send + 'static> Collected<T> {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self { items: Mutex::new(Vec::new()), arrived: Condvar::new() })
    }

    pub(crate) fn push(&self, item: T) {
        self.items.lock().expect("lock").push(item);
        self.arrived.notify_all();
    }

    pub(crate) fn all(&self) -> Vec<T> {
        self.items.lock().expect("lock").clone()
    }

    pub(crate) fn len(&self) -> usize {
        self.items.lock().expect("lock").len()
    }

    /// Waits until `found` holds for what was collected; false after [`PATIENCE`].
    pub(crate) fn wait_for(&self, found: impl Fn(&[T]) -> bool) -> bool {
        let deadline = Instant::now() + PATIENCE;
        let mut items = self.items.lock().expect("lock");
        loop {
            if found(&items) {
                return true;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            items = self.arrived.wait_timeout(items, left).expect("lock").0;
        }
    }
}

/// A temporary folder by its real path (the system reports real paths).
pub(crate) struct Dir {
    _keep: tempfile::TempDir,
    pub(crate) path: PathBuf,
}

impl Dir {
    pub(crate) fn new() -> Self {
        let keep = tempfile::tempdir().expect("a temporary folder");
        let path = std::fs::canonicalize(keep.path()).expect("its real path");
        Self { _keep: keep, path }
    }

    pub(crate) fn join(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }

    pub(crate) fn write(&self, name: &str, content: &str) {
        let file = self.join(name);
        std::fs::create_dir_all(file.parent().expect("a parent")).expect("the folders");
        std::fs::write(file, content).expect("the file");
    }
}

pub(crate) fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// File descriptors this process holds open.
pub(crate) fn open_fds() -> usize {
    std::fs::read_dir("/dev/fd").map(|entries| entries.count()).unwrap_or(0)
}

/// Threads of this process, as the system counts them; `None` where `ps` cannot say.
pub(crate) fn thread_count() -> Option<usize> {
    let out = std::process::Command::new("ps").args(["-M", "-p", &std::process::id().to_string()]).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).lines().count().saturating_sub(1))
}
