//! The system watcher, the bounded queue behind it and the thread that
//! drains it — what both watchers are built on.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};

/// Paths waiting for the watcher's thread. A burst larger than this (a
/// checkout of a huge tree) sets the overflow mark instead of growing.
const QUEUE: usize = 8192;

/// What a watcher does with what the system reports. Called on the watcher's
/// own thread, one call at a time.
pub(crate) trait Reactor: Send + Sync + 'static {
    /// A path changed. Returns whether something is now waiting to be sent.
    fn on_path(&self, path: &Path) -> bool;
    /// Events were lost (the queue was full, or the system said so): bring
    /// the state up to date another way. Returns as [`on_path`](Self::on_path).
    fn on_overflow(&self) -> bool;
    /// The quiet window ended: send what was gathered.
    fn flush(&self);
}

/// One system watcher with its queue and thread. Dropping it ends the system
/// watch, which closes the queue, which ends the thread; the drop waits for it.
pub(crate) struct Source {
    watcher: Option<RecommendedWatcher>,
    thread: Option<JoinHandle<()>>,
}

fn push(queue: &SyncSender<PathBuf>, overflow: &AtomicBool, path: PathBuf) {
    if let Err(TrySendError::Full(_)) = queue.try_send(path) {
        overflow.store(true, Ordering::SeqCst);
    }
}

/// Wakes the thread so it sees the overflow mark even when no path follows.
fn mark_overflow(queue: &SyncSender<PathBuf>, overflow: &AtomicBool) {
    overflow.store(true, Ordering::SeqCst);
    let _ = queue.try_send(PathBuf::new());
}

fn drain(queue: Receiver<PathBuf>, overflow: Arc<AtomicBool>, reactor: Arc<dyn Reactor>, window: Duration) {
    let mut deadline: Option<Instant> = None;
    loop {
        let next = match deadline {
            None => queue.recv().map_err(|_| RecvTimeoutError::Disconnected),
            Some(at) => queue.recv_timeout(at.saturating_duration_since(Instant::now())),
        };
        let waiting = match next {
            Ok(path) => {
                let resynced = overflow.swap(false, Ordering::SeqCst) && reactor.on_overflow();
                let fired = !path.as_os_str().is_empty() && reactor.on_path(&path);
                resynced || fired
            }
            Err(RecvTimeoutError::Timeout) => {
                deadline = None;
                reactor.flush();
                false
            }
            Err(RecvTimeoutError::Disconnected) => return,
        };
        // The window opens at the first change and is not pushed back by later ones.
        if waiting && deadline.is_none() {
            deadline = Some(Instant::now() + window);
        }
    }
}

impl Source {
    /// Starts the thread; no path is watched yet. `window` is how long
    /// changes are gathered before `reactor.flush()`.
    pub(crate) fn start(name: &str, reactor: Arc<dyn Reactor>, window: Duration) -> Result<Self, notify::Error> {
        let (tx, rx) = mpsc::sync_channel::<PathBuf>(QUEUE);
        let overflow = Arc::new(AtomicBool::new(false));
        let lost = overflow.clone();
        let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| match event {
            Ok(event) => {
                if event.need_rescan() {
                    mark_overflow(&tx, &lost);
                }
                for path in event.paths {
                    push(&tx, &lost, path);
                }
            }
            Err(error) => {
                tracing::warn!(%error, "a file-system watch reported an error");
                mark_overflow(&tx, &lost);
            }
        })?;
        let thread = std::thread::Builder::new()
            .name(name.to_owned())
            .spawn(move || drain(rx, overflow, reactor, window))
            .map_err(notify::Error::io)?;
        Ok(Self { watcher: Some(watcher), thread: Some(thread) })
    }

    pub(crate) fn watch(&mut self, path: &Path, recursive: bool) -> Result<(), notify::Error> {
        let mode = if recursive { RecursiveMode::Recursive } else { RecursiveMode::NonRecursive };
        match self.watcher.as_mut() {
            Some(watcher) => watcher.watch(path, mode),
            None => Ok(()),
        }
    }

    pub(crate) fn unwatch(&mut self, path: &Path) {
        if let Some(watcher) = self.watcher.as_mut() {
            let _ = watcher.unwatch(path);
        }
    }
}

impl Drop for Source {
    fn drop(&mut self) {
        // The watcher holds the queue's only sender.
        drop(self.watcher.take());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl std::fmt::Debug for Source {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Source").field("running", &self.thread.is_some()).finish()
    }
}
