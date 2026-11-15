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

/// Paths a watcher has no use for whatever happens there: dropped in the
/// system's callback, before they take a place in the queue.
pub(crate) type Skip = Arc<dyn Fn(&Path) -> bool + Send + Sync>;

/// One system watcher with its queue and thread. Dropping it ends the system
/// watch, which closes the queue, which ends the thread; the drop waits for it.
pub(crate) struct Source {
    watcher: Option<RecommendedWatcher>,
    /// For [`poke`](Self::poke); dropped with the watcher, so the queue closes.
    queue: Option<SyncSender<PathBuf>>,
    overflow: Arc<AtomicBool>,
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
    /// changes are gathered before `reactor.flush()`; `skip` names the paths
    /// that never reach it (a rescan of such paths only is no loss either).
    pub(crate) fn start(
        name: &str,
        reactor: Arc<dyn Reactor>,
        window: Duration,
        skip: Option<Skip>,
    ) -> Result<Self, notify::Error> {
        let (tx, rx) = mpsc::sync_channel::<PathBuf>(QUEUE);
        let queue = tx.clone();
        let overflow = Arc::new(AtomicBool::new(false));
        let (lost, poked) = (overflow.clone(), overflow.clone());
        let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| match event {
            Ok(event) => {
                let skipped = |path: &PathBuf| skip.as_ref().is_some_and(|skip| skip(path));
                if event.need_rescan() && (event.paths.is_empty() || !event.paths.iter().all(skipped)) {
                    mark_overflow(&tx, &lost);
                }
                for path in event.paths {
                    if !skipped(&path) {
                        push(&tx, &lost, path);
                    }
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
        Ok(Self { watcher: Some(watcher), queue: Some(queue), overflow: poked, thread: Some(thread) })
    }

    /// Hands `path` to the reactor as if the system had reported it.
    pub(crate) fn poke(&self, path: PathBuf) {
        if let Some(queue) = &self.queue {
            push(queue, &self.overflow, path);
        }
    }

    pub(crate) fn watch(&mut self, path: &Path, recursive: bool) -> Result<(), notify::Error> {
        self.change(&[(path.to_owned(), recursive)], &[]).pop().unwrap_or(Ok(()))
    }

    pub(crate) fn unwatch(&mut self, path: &Path) {
        self.change(&[], &[path.to_owned()]);
    }

    /// Gives back `removes`, then watches `adds` (path, recursive), restarting
    /// the system's stream once for all of them (each `watch`/`unwatch` of the
    /// system watcher restarts it). Returns the outcome of each add; when the
    /// stream cannot restart with them, every add failed and none is kept.
    pub(crate) fn change(&mut self, adds: &[(PathBuf, bool)], removes: &[PathBuf]) -> Vec<Result<(), notify::Error>> {
        let Some(watcher) = self.watcher.as_mut() else { return adds.iter().map(|_| Ok(())).collect() };
        if adds.is_empty() && removes.is_empty() {
            return Vec::new();
        }
        let mut paths = watcher.paths_mut();
        for path in removes {
            let _ = paths.remove(path);
        }
        let mut added: Vec<Result<(), notify::Error>> = adds
            .iter()
            .map(|(path, recursive)| {
                let mode = if *recursive { RecursiveMode::Recursive } else { RecursiveMode::NonRecursive };
                paths.add(path, mode)
            })
            .collect();
        if let Err(error) = paths.commit() {
            tracing::warn!(%error, "the file-system watch could not restart with its new paths");
            let mut undo = watcher.paths_mut();
            for ((path, _), outcome) in adds.iter().zip(&added) {
                if outcome.is_ok() {
                    let _ = undo.remove(path);
                }
            }
            let _ = undo.commit();
            let message = error.to_string();
            added = adds.iter().map(|_| Err(notify::Error::generic(&message))).collect();
        }
        added
    }
}

impl Drop for Source {
    fn drop(&mut self) {
        // The watcher and `queue` hold the queue's only senders.
        drop(self.watcher.take());
        drop(self.queue.take());
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

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[derive(Default)]
    struct Seen(Mutex<Vec<PathBuf>>);

    impl Reactor for Seen {
        fn on_path(&self, path: &Path) -> bool {
            self.0.lock().expect("seen").push(path.to_owned());
            false
        }
        fn on_overflow(&self) -> bool {
            false
        }
        fn flush(&self) {}
    }

    fn wait_for(seen: &Seen, path: &Path) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if seen.0.lock().expect("seen").iter().any(|p| p == path) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        false
    }

    #[test]
    fn one_change_watches_and_gives_back_several_folders() {
        let root = tempfile::tempdir().expect("a folder");
        let root = std::fs::canonicalize(root.path()).expect("its real path");
        let (a, b, gone) = (root.join("a"), root.join("b"), root.join("never-made"));
        std::fs::create_dir_all(&a).expect("a");
        std::fs::create_dir_all(&b).expect("b");
        let seen = Arc::new(Seen::default());
        let mut source = Source::start("test-watch", seen.clone(), Duration::from_millis(10), None).expect("starts");

        let added = source.change(&[(a.clone(), false), (gone, false), (b.clone(), true)], &[]);
        assert!(added[0].is_ok() && added[1].is_err() && added[2].is_ok(), "{added:?}");
        std::fs::write(a.join("1"), "x").expect("write");
        std::fs::create_dir_all(b.join("deep")).expect("deep");
        std::fs::write(b.join("deep/2"), "x").expect("write");
        assert!(wait_for(&seen, &a.join("1")) && wait_for(&seen, &b.join("deep/2")));

        source.change(&[], std::slice::from_ref(&a));
        std::fs::write(a.join("3"), "x").expect("write");
        std::fs::write(b.join("4"), "x").expect("write");
        assert!(wait_for(&seen, &b.join("4")));
        assert!(!seen.0.lock().expect("seen").contains(&a.join("3")), "a folder given back reports nothing");
    }
}
