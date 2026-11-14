//! The phone link's files and the keep-awake hold, in memory.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use eos_core::Error;
use eos_core::os::{AwakeHold, KeepAwake};
use eos_core::store::{RemoteAuditEntry, RemoteStore, RoomSecrets};

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

/// Fixed secrets and an audit log kept as a list.
#[derive(Debug)]
pub struct FakeRemoteStore {
    secrets: RoomSecrets,
    audit: Mutex<Vec<RemoteAuditEntry>>,
}

impl Default for FakeRemoteStore {
    fn default() -> Self {
        Self::new("Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4")
    }
}

impl FakeRemoteStore {
    /// With `room` as the room id, and secrets of the real length.
    pub fn new(room: &str) -> Self {
        Self {
            secrets: RoomSecrets {
                room: room.to_owned(),
                bearer: "YmVhcmVyLXNlY3JldC1iZWFyZXItc2VjcmV0LWJlYXJlci1zZWM".to_owned(),
                owner: "b3duZXItc2VjcmV0LW93bmVyLXNlY3JldC1vd25lci1zZWNyZXQ".to_owned(),
            },
            audit: Mutex::default(),
        }
    }

    pub fn room(&self) -> &str {
        &self.secrets.room
    }

    pub fn bearer(&self) -> &str {
        &self.secrets.bearer
    }

    /// Every audited request, oldest first.
    pub fn audited(&self) -> Vec<RemoteAuditEntry> {
        lock(&self.audit).clone()
    }
}

impl RemoteStore for FakeRemoteStore {
    fn secrets(&self) -> Result<RoomSecrets, Error> {
        Ok(self.secrets.clone())
    }

    fn audit(&self, entry: &RemoteAuditEntry) -> Result<(), Error> {
        lock(&self.audit).push(entry.clone());
        Ok(())
    }
}

/// Counts the holds it handed out and the ones still held. Starts no process.
#[derive(Debug, Default)]
pub struct FakeKeepAwake {
    taken: AtomicUsize,
    held: Arc<AtomicUsize>,
}

struct Hold(Arc<AtomicUsize>);

impl AwakeHold for Hold {}

impl Drop for Hold {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl FakeKeepAwake {
    pub fn new() -> Self {
        Self::default()
    }

    /// Holds handed out so far.
    pub fn taken(&self) -> usize {
        self.taken.load(Ordering::SeqCst)
    }

    /// Holds not released yet.
    pub fn held(&self) -> usize {
        self.held.load(Ordering::SeqCst)
    }
}

impl KeepAwake for FakeKeepAwake {
    fn hold(&self) -> Option<Box<dyn AwakeHold>> {
        self.taken.fetch_add(1, Ordering::SeqCst);
        self.held.fetch_add(1, Ordering::SeqCst);
        Some(Box::new(Hold(self.held.clone())))
    }
}
