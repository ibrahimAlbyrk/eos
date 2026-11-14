//! The store: jobs in, entities out, announcements after COMMIT.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use eos_core::store::{Announcement, Announcer, Outbox, ReadJob, Store, Tx, WriteJob};
use eos_core::{BoxFuture, Error};
use eos_kit_sqlite::rusqlite::Connection;
use eos_kit_sqlite::{Db, Receipt, Stats};

use crate::tx::{Shared, SqliteTx};

#[derive(Debug, Clone, Copy)]
pub struct StoreOptions {
    /// Each worker keeps its newest this-many events (`events.maxPerWorker`);
    /// 0 keeps them all.
    pub events_max_per_worker: i64,
}

impl Default for StoreOptions {
    fn default() -> Self {
        Self { events_max_per_worker: 20_000 }
    }
}

/// A job's failure on its way through the kit, which wants its own error convertible.
struct Failure(Error);

impl From<eos_kit_sqlite::Error> for Failure {
    fn from(e: eos_kit_sqlite::Error) -> Self {
        Failure(match e {
            // The queue has a bound: a caller is told to come back, not parked.
            eos_kit_sqlite::Error::QueueFull => Error::LimitExceeded("the database is busy".into()),
            other => Error::Storage(other.to_string()),
        })
    }
}

/// A saved write: its result, and what it announces.
struct Saved<T> {
    value: T,
    events: Mutex<Vec<Announcement>>,
}

pub struct SqliteStore {
    db: Db,
    announcer: Arc<dyn Announcer>,
    shared: Arc<Shared>,
}

impl std::fmt::Debug for SqliteStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SqliteStore").field("db", &self.db).finish_non_exhaustive()
    }
}

impl SqliteStore {
    /// `db` is open and migrated. `announcer` receives what committed writes
    /// announce, on the writer thread, in commit order.
    pub fn new(db: Db, announcer: Arc<dyn Announcer>, options: StoreOptions) -> Self {
        let shared = Shared {
            events_max_per_worker: options.events_max_per_worker,
            appends_since_prune: Mutex::new(HashMap::new()),
        };
        Self { db, announcer, shared: Arc::new(shared) }
    }

    pub fn db(&self) -> &Db {
        &self.db
    }

    /// Runs what is queued, stops the threads and folds the WAL into the file.
    pub fn close(self) -> Stats {
        self.db.close()
    }

    /// Waits for every write queued so far to be saved, then folds the WAL
    /// into the file. For shutdown; blocks the calling thread.
    pub fn drain(&self) -> Result<(), Error> {
        self.write_blocking(|_, _| Ok(()))?;
        let folded = self.db.maintain(|conn: &Connection| {
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").map_err(|e| Failure(crate::tx::failed(e)))
        });
        folded.map_err(|Failure(e)| e)
    }

    fn queue_read<T: Send + 'static>(
        &self,
        job: impl FnOnce(&dyn Tx) -> Result<T, Error> + Send + 'static,
    ) -> Receipt<T, Failure> {
        let shared = self.shared.clone();
        self.db.read_async(move |conn: &Connection| job(&SqliteTx { conn, shared: &shared }).map_err(Failure))
    }

    fn queue_write<T: Send + 'static>(
        &self,
        job: impl FnOnce(&dyn Tx, &mut Outbox) -> Result<T, Error> + Send + 'static,
    ) -> Receipt<Saved<T>, Failure> {
        let (shared, announcer) = (self.shared.clone(), self.announcer.clone());
        self.db.write_then_async(
            move |conn: &Connection| {
                let mut outbox = Outbox::default();
                let value = job(&SqliteTx { conn, shared: &shared }, &mut outbox).map_err(Failure)?;
                Ok(Saved { value, events: Mutex::new(outbox.into_events()) })
            },
            move |saved: &Saved<T>| {
                let events = std::mem::take(&mut *saved.events.lock().unwrap_or_else(|p| p.into_inner()));
                if !events.is_empty() {
                    announcer.announce(events);
                }
            },
        )
    }

    /// [`read`](dyn Store::read) for code that is not async: start-up, tests.
    /// Blocks the calling thread until the job has run.
    pub fn read_blocking<T: Send + 'static>(
        &self,
        job: impl FnOnce(&dyn Tx) -> Result<T, Error> + Send + 'static,
    ) -> Result<T, Error> {
        self.queue_read(job).wait().map_err(|Failure(e)| e)
    }

    /// [`write`](dyn Store::write) for code that is not async.
    pub fn write_blocking<T: Send + 'static>(
        &self,
        job: impl FnOnce(&dyn Tx, &mut Outbox) -> Result<T, Error> + Send + 'static,
    ) -> Result<T, Error> {
        self.queue_write(job).wait().map(|saved| saved.value).map_err(|Failure(e)| e)
    }
}

impl Store for SqliteStore {
    fn run_read(&self, job: ReadJob) -> BoxFuture<'_, Result<(), Error>> {
        let receipt = self.queue_read(move |tx| {
            job(tx);
            Ok(())
        });
        Box::pin(async move { receipt.await.map_err(|Failure(e)| e) })
    }

    fn run_write(&self, job: WriteJob) -> BoxFuture<'_, Result<(), Error>> {
        let receipt = self.queue_write(job);
        Box::pin(async move { receipt.await.map(|_| ()).map_err(|Failure(e)| e) })
    }
}
