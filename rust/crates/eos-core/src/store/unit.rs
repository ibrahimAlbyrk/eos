//! The unit of work: jobs over one transaction, and what a write announces.

use std::sync::{Arc, Mutex};

use serde::Serialize;

use super::{EventRepo, WorkerRepo};
use crate::{BoxFuture, Error};

/// The repositories over one transaction (a write) or one snapshot (a read).
pub trait Tx {
    fn events(&self) -> &dyn EventRepo;
    fn workers(&self) -> &dyn WorkerRepo;
}

/// One event to publish once the write that caused it is saved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Announcement {
    /// The bus topic.
    pub topic: &'static str,
    /// The payload as JSON, serialized once here; empty for "none".
    pub payload: Vec<u8>,
}

/// What a write job announces. Nothing leaves it unless the job succeeds and
/// its transaction commits; then everything goes out in the order pushed,
/// after the announcements of every write that committed before.
#[derive(Debug, Default)]
pub struct Outbox {
    events: Vec<Announcement>,
}

impl Outbox {
    pub fn push<T: Serialize + ?Sized>(&mut self, topic: &'static str, payload: &T) {
        match serde_json::to_vec(payload) {
            Ok(payload) => self.events.push(Announcement { topic, payload }),
            // A payload that cannot be written as JSON is a bug in its type;
            // dropping the event beats failing a write that is otherwise fine.
            Err(_) => debug_assert!(false, "the payload of {topic} cannot be serialized"),
        }
    }

    /// An event that carries nothing but its topic.
    pub fn push_bare(&mut self, topic: &'static str) {
        self.events.push(Announcement { topic, payload: Vec::new() });
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    pub fn into_events(self) -> Vec<Announcement> {
        self.events
    }
}

/// Where committed writes' announcements go: the app plugs the event bus in.
/// Called on the database's writer thread, in commit order; it must only hand
/// the events on, never wait for their delivery.
pub trait Announcer: Send + Sync + 'static {
    fn announce(&self, events: Vec<Announcement>);
}

pub type ReadJob = Box<dyn FnOnce(&dyn Tx) + Send>;
/// `Err` undoes the job's changes and drops its announcements.
pub type WriteJob = Box<dyn FnOnce(&dyn Tx, &mut Outbox) -> Result<(), Error> + Send>;

/// `state.db`. Use [`read`](dyn Store::read) and [`write`](dyn Store::write);
/// the two methods here are what an adapter implements.
pub trait Store: Send + Sync + 'static {
    /// Runs `job` on a read-only connection, inside one snapshot.
    fn run_read(&self, job: ReadJob) -> BoxFuture<'_, Result<(), Error>>;
    /// Runs `job` as one transaction step on the writer; resolves after COMMIT.
    fn run_write(&self, job: WriteJob) -> BoxFuture<'_, Result<(), Error>>;
}

type Slot<T> = Arc<Mutex<Option<Result<T, Error>>>>;

fn take<T>(slot: &Slot<T>) -> Result<T, Error> {
    let taken = slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
    taken.unwrap_or_else(|| Err(Error::Storage("the database job did not run".into())))
}

fn put<T>(slot: &Slot<T>, value: Result<T, Error>) {
    *slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(value);
}

impl dyn Store {
    /// A read: `job` sees one consistent snapshot. When too many jobs wait
    /// already it fails with [`Error::LimitExceeded`] instead of queueing more.
    pub async fn read<T, F>(&self, job: F) -> Result<T, Error>
    where
        T: Send + 'static,
        F: FnOnce(&dyn Tx) -> Result<T, Error> + Send + 'static,
    {
        let slot: Slot<T> = Arc::default();
        let out = slot.clone();
        self.run_read(Box::new(move |tx| put(&out, job(tx)))).await?;
        take(&slot)
    }

    /// A read-modify-write: `job` runs alone on the writer, and its result is
    /// returned once it is saved. See the module docs for what `Err` undoes.
    pub async fn write<T, F>(&self, job: F) -> Result<T, Error>
    where
        T: Send + 'static,
        F: FnOnce(&dyn Tx, &mut Outbox) -> Result<T, Error> + Send + 'static,
    {
        let slot: Slot<T> = Arc::default();
        let out = slot.clone();
        let ran = self
            .run_write(Box::new(move |tx, outbox| match job(tx, outbox) {
                Ok(value) => {
                    put(&out, Ok(value));
                    Ok(())
                }
                Err(e) => Err(e),
            }))
            .await;
        ran.and_then(|()| take(&slot))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_outbox_keeps_the_order_and_serializes_once() {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Change<'a> {
            worker_id: &'a str,
        }
        let mut out = Outbox::default();
        assert!(out.is_empty());
        out.push("worker:change", &Change { worker_id: "w-1" });
        out.push_bare("usage:change");
        let events = out.into_events();
        assert_eq!(events[0], Announcement { topic: "worker:change", payload: br#"{"workerId":"w-1"}"#.to_vec() });
        assert_eq!(events[1], Announcement { topic: "usage:change", payload: Vec::new() });
    }
}
