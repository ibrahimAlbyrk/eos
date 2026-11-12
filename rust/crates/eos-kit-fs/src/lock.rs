//! One writer at a time per file.
//!
//! The TypeScript app had a single thread, so "read the file, change it, write
//! it back" could not interleave with another change of the same file. Here
//! that takes a lock; this one is per path, so unrelated files never wait on
//! each other.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};

use crate::atomic::{WriteOptions, atomic_write};
use crate::error::Error;

#[derive(Default)]
struct Entry {
    locked: Mutex<bool>,
    freed: Condvar,
}

/// A table of per-path locks. It holds an entry only while someone holds or
/// waits for that path, so it never grows past the number of files in use.
/// Paths are compared as given: callers of one file must spell it the same way.
#[derive(Default)]
pub struct PathLocks {
    table: Mutex<HashMap<PathBuf, Arc<Entry>>>,
}

impl std::fmt::Debug for PathLocks {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PathLocks").field("held", &self.held()).finish()
    }
}

/// Holds one path until dropped.
#[must_use = "the path is unlocked as soon as the guard is dropped"]
pub struct PathGuard<'a> {
    locks: &'a PathLocks,
    path: PathBuf,
    /// Given back inside `drop`, while the table is held (see there).
    entry: Option<Arc<Entry>>,
}

impl std::fmt::Debug for PathGuard<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PathGuard").field("path", &self.path).finish()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl PathLocks {
    pub fn new() -> Self {
        Self::default()
    }

    /// Paths currently held or waited for.
    pub fn held(&self) -> usize {
        lock(&self.table).len()
    }

    /// Waits until no one else holds `path`, then holds it.
    pub fn lock(&self, path: &Path) -> PathGuard<'_> {
        let entry = lock(&self.table).entry(path.to_owned()).or_default().clone();
        let mut locked = lock(&entry.locked);
        while *locked {
            locked = entry.freed.wait(locked).unwrap_or_else(PoisonError::into_inner);
        }
        *locked = true;
        drop(locked);
        PathGuard { locks: self, path: path.to_owned(), entry: Some(entry) }
    }

    /// Read-modify-write of one file under its lock. `change` gets the current
    /// bytes (`None`: no such file) and returns the new bytes, or `None` to
    /// leave the file as it is, plus a value for the caller.
    pub fn update<T, E, F>(&self, path: &Path, options: &WriteOptions, change: F) -> Result<T, E>
    where
        E: From<Error>,
        F: FnOnce(Option<Vec<u8>>) -> Result<(Option<Vec<u8>>, T), E>,
    {
        let _guard = self.lock(path);
        let current = match fs::read(path) {
            Ok(bytes) => Some(bytes),
            Err(e) if e.kind() == io::ErrorKind::NotFound => None,
            Err(source) => return Err(Error::Io { path: path.to_owned(), source }.into()),
        };
        let (next, value) = change(current)?;
        if let Some(bytes) = next {
            atomic_write(path, &bytes, options)?;
        }
        Ok(value)
    }
}

impl Drop for PathGuard<'_> {
    fn drop(&mut self) {
        // Table first, so no one can join the entry between the check and the removal.
        let mut table = lock(&self.locks.table);
        let Some(entry) = self.entry.take() else { return };
        *lock(&entry.locked) = false;
        // Two owners left — the table and this guard — means no one is waiting.
        if Arc::strong_count(&entry) == 2 {
            table.remove(&self.path);
        } else {
            entry.freed.notify_one();
        }
        // This guard's share goes before the table is let go: a waiter that
        // takes over and lets go at once must not count it as a third owner,
        // or the entry would stay in the table for good.
        drop(entry);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::thread;

    use super::*;

    #[test]
    fn concurrent_updates_of_one_file_do_not_lose_each_other() {
        let dir = tempfile::tempdir().expect("dir");
        let path = Arc::new(dir.path().join("counter"));
        let locks = Arc::new(PathLocks::new());
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let (path, locks) = (path.clone(), locks.clone());
                thread::spawn(move || {
                    for _ in 0..50 {
                        locks
                            .update(&path, &WriteOptions::default(), |current| {
                                let n: u32 = current
                                    .map_or(0, |bytes| String::from_utf8_lossy(&bytes).parse().expect("a number"));
                                Ok::<_, Error>((Some((n + 1).to_string().into_bytes()), ()))
                            })
                            .expect("update");
                    }
                })
            })
            .collect();
        for w in workers {
            w.join().expect("worker");
        }
        assert_eq!(fs::read_to_string(&*path).expect("read"), "400");
        assert_eq!(locks.held(), 0, "no entry outlives its users");
    }

    #[test]
    fn different_paths_do_not_wait_on_each_other_and_the_same_path_does() {
        let locks = Arc::new(PathLocks::new());
        let a = locks.lock(Path::new("/x/a"));
        let _b = locks.lock(Path::new("/x/b"));
        assert_eq!(locks.held(), 2);

        let entered = Arc::new(AtomicU32::new(0));
        let waiter = {
            let (locks, entered) = (locks.clone(), entered.clone());
            thread::spawn(move || {
                let _a = locks.lock(Path::new("/x/a"));
                entered.store(1, Ordering::SeqCst);
            })
        };
        thread::sleep(std::time::Duration::from_millis(50));
        assert_eq!(entered.load(Ordering::SeqCst), 0, "the second holder waits");
        drop(a);
        waiter.join().expect("waiter");
        assert_eq!(entered.load(Ordering::SeqCst), 1);
        assert_eq!(locks.held(), 1);
    }

    #[test]
    fn no_entry_is_left_behind_when_a_waiter_takes_over_a_released_path() {
        // The holder hands the path to a waiter and the waiter lets it go at
        // once, over and over: the table must end empty every time.
        let locks = Arc::new(PathLocks::new());
        for round in 0..2_000 {
            let held = locks.lock(Path::new("/x/a"));
            let waiter = {
                let locks = locks.clone();
                thread::spawn(move || drop(locks.lock(Path::new("/x/a"))))
            };
            while lock(&locks.table).get(Path::new("/x/a")).is_some_and(|e| Arc::strong_count(e) < 3) {
                thread::yield_now();
            }
            drop(held);
            waiter.join().expect("waiter");
            assert_eq!(locks.held(), 0, "round {round}: an entry outlived its users");
        }
    }

    #[test]
    fn an_update_can_decline_to_write_or_fail_without_touching_the_file() {
        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join("file");
        let locks = PathLocks::new();
        let seen = locks
            .update(&path, &WriteOptions::default(), |current| Ok::<_, Error>((None, current.is_none())))
            .expect("update");
        assert!(seen, "a missing file is None");
        assert!(!path.exists());

        fs::write(&path, "kept").expect("write");
        let failed: Result<(), Error> =
            locks.update(&path, &WriteOptions::default(), |_| Err(Error::Yaml("stale".to_owned())));
        assert!(failed.is_err());
        assert_eq!(fs::read_to_string(&path).expect("read"), "kept");
        assert_eq!(locks.held(), 0, "the lock is released on failure too");
    }
}
