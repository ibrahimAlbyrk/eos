//! The write path and the readers.
//!
//! One thread owns the only read-write connection. A write is a closure that
//! runs there; whatever is queued when the thread wakes is folded into one
//! `BEGIN IMMEDIATE … COMMIT` (group commit), each closure under its own
//! savepoint, so a failing or panicking write undoes only itself. A caller
//! hears back after COMMIT, in the order the writes ran: a row id is durable
//! before anyone sees it.
//!
//! Reads run on a fixed set of read-only connections, one thread each, every
//! closure inside its own read transaction (one consistent snapshot).
//!
//! Both queues are bounded by [`Options::queue`]. When one is full, `write` /
//! `read` / `maintain` make the caller wait (durable work is never dropped);
//! the `_async` calls never block and answer [`Error::QueueFull`] instead.
//! A job must not call back into the same `Db`.

use std::any::Any;
use std::future::Future;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context, Poll};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crossbeam_channel::{Receiver, Sender, TrySendError, bounded};
use rusqlite::Connection;

use crate::error::Error;
use crate::migrate::{self, Migration, MigrationReport};
use crate::oneshot;
use crate::open::{Synchronous, open_read_only, open_read_write};

#[derive(Debug, Clone)]
pub struct Options {
    /// Read-only connections (at least one).
    pub readers: usize,
    /// Bound of the write queue and of the read queue.
    pub queue: usize,
    /// Most writes folded into one transaction.
    pub max_batch: usize,
    pub synchronous: Synchronous,
    pub busy_timeout: Duration,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            readers: 3,
            queue: 1024,
            max_batch: 256,
            synchronous: Synchronous::Full,
            busy_timeout: Duration::from_secs(5),
        }
    }
}

/// Counters of the writer since the open.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Stats {
    pub commits: u64,
    pub writes: u64,
    pub largest_batch: u64,
}

#[derive(Default)]
struct Counters {
    commits: AtomicU64,
    writes: AtomicU64,
    largest_batch: AtomicU64,
}

/// Runs after the batch's COMMIT (or its failure) and answers the caller.
type Reply = Box<dyn FnOnce(bool) + Send>;
/// `Err` = the transaction could not start. Returns the reply and whether the
/// transaction is still usable.
type TxJob = Box<dyn FnOnce(Result<&Connection, &rusqlite::Error>) -> (Reply, bool) + Send>;
type BareJob = Box<dyn FnOnce(&Connection) + Send>;

enum WriteJob {
    Tx(TxJob),
    /// Runs alone, outside any transaction (VACUUM cannot run inside one).
    Bare(BareJob),
}

pub struct Db {
    path: PathBuf,
    write_tx: Option<Sender<WriteJob>>,
    read_tx: Option<Sender<BareJob>>,
    writer: Option<JoinHandle<()>>,
    readers: Vec<JoinHandle<()>>,
    counters: Arc<Counters>,
}

impl std::fmt::Debug for Db {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Db").field("path", &self.path).field("readers", &self.readers.len()).finish_non_exhaustive()
    }
}

/// The answer to a non-blocking call: await it, or [`wait`](Receipt::wait) on a thread.
#[must_use = "the job runs either way, but its result is only seen through the receipt"]
pub struct Receipt<T, E> {
    inner: ReceiptInner<T, E>,
}

enum ReceiptInner<T, E> {
    Pending(oneshot::Receiver<Result<T, E>>),
    Refused(Option<Error>),
}

impl<T, E> std::fmt::Debug for Receipt<T, E> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Receipt").finish_non_exhaustive()
    }
}

impl<T, E: From<Error>> Receipt<T, E> {
    pub fn wait(self) -> Result<T, E> {
        match self.inner {
            ReceiptInner::Pending(rx) => rx.wait().unwrap_or_else(|| Err(Error::Closed.into())),
            ReceiptInner::Refused(e) => Err(e.unwrap_or(Error::Closed).into()),
        }
    }
}

impl<T, E: From<Error>> Future for Receipt<T, E> {
    type Output = Result<T, E>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        match &mut self.get_mut().inner {
            ReceiptInner::Pending(rx) => {
                Pin::new(rx).poll(cx).map(|answer| answer.unwrap_or_else(|| Err(Error::Closed.into())))
            }
            ReceiptInner::Refused(e) => Poll::Ready(Err(e.take().unwrap_or(Error::Closed).into())),
        }
    }
}

impl Db {
    /// Opens (or creates) the file, applies the embedded migrations and starts the threads.
    pub fn open(path: impl Into<PathBuf>, options: Options, now_ms: i64) -> Result<(Self, MigrationReport), Error> {
        Self::open_with(path, options, migrate::EMBEDDED, now_ms)
    }

    pub fn open_with(
        path: impl Into<PathBuf>,
        options: Options,
        migrations: &[Migration],
        now_ms: i64,
    ) -> Result<(Self, MigrationReport), Error> {
        let path: PathBuf = path.into();
        let conn = open_read_write(&path, options.synchronous, options.busy_timeout)?;
        let report = migrate::run(&conn, migrations, now_ms)?;

        let queue = options.queue.max(1);
        let max_batch = options.max_batch.max(1);
        let counters = Arc::new(Counters::default());
        let (write_tx, write_rx) = bounded::<WriteJob>(queue);
        let writer = {
            let counters = counters.clone();
            thread::Builder::new()
                .name("db-writer".into())
                .spawn(move || writer_loop(conn, write_rx, max_batch, &counters))
                .map_err(Error::Spawn)?
        };

        let (read_tx, read_rx) = bounded::<BareJob>(queue);
        let mut db = Self {
            path,
            write_tx: Some(write_tx),
            read_tx: Some(read_tx),
            writer: Some(writer),
            readers: Vec::new(),
            counters,
        };
        // On an error below, dropping `db` stops the threads already started.
        for i in 0..options.readers.max(1) {
            let conn = open_read_only(&db.path, options.busy_timeout)?;
            let rx = read_rx.clone();
            let handle = thread::Builder::new()
                .name(format!("db-reader-{i}"))
                .spawn(move || reader_loop(conn, rx))
                .map_err(Error::Spawn)?;
            db.readers.push(handle);
        }
        Ok((db, report))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn stats(&self) -> Stats {
        Stats {
            commits: self.counters.commits.load(Ordering::Relaxed),
            writes: self.counters.writes.load(Ordering::Relaxed),
            largest_batch: self.counters.largest_batch.load(Ordering::Relaxed),
        }
    }

    /// Runs `job` on the writer thread and returns once its transaction has
    /// committed. An `Err` from the job undoes the job's own changes only.
    /// Waits while the queue is full.
    pub fn write<T, E, F>(&self, job: F) -> Result<T, E>
    where
        T: Send + 'static,
        E: From<Error> + Send + 'static,
        F: FnOnce(&Connection) -> Result<T, E> + Send + 'static,
    {
        let (job, rx) = tx_job(job);
        match &self.write_tx {
            Some(tx) if tx.send(WriteJob::Tx(job)).is_ok() => rx.wait().unwrap_or_else(|| Err(Error::Closed.into())),
            _ => Err(Error::Closed.into()),
        }
    }

    /// [`write`](Self::write) without blocking: a full queue is answered with [`Error::QueueFull`].
    pub fn write_async<T, E, F>(&self, job: F) -> Receipt<T, E>
    where
        T: Send + 'static,
        E: From<Error> + Send + 'static,
        F: FnOnce(&Connection) -> Result<T, E> + Send + 'static,
    {
        let (job, rx) = tx_job(job);
        submit(self.write_tx.as_ref(), WriteJob::Tx(job), rx)
    }

    /// [`write_async`](Self::write_async), then `after_commit` with the job's
    /// result: on the writer thread, once the transaction has committed and
    /// before the caller hears back. Hooks run in commit order, so one that
    /// announces its write (posts an event) announces writes in the order they
    /// were saved. It must not block and must not call back into this `Db`. It
    /// does not run when the job failed or the commit did.
    pub fn write_then_async<T, E, F, A>(&self, job: F, after_commit: A) -> Receipt<T, E>
    where
        T: Send + 'static,
        E: From<Error> + Send + 'static,
        F: FnOnce(&Connection) -> Result<T, E> + Send + 'static,
        A: FnOnce(&T) + Send + 'static,
    {
        let (job, rx) = tx_job_then(job, after_commit);
        submit(self.write_tx.as_ref(), WriteJob::Tx(job), rx)
    }

    /// Runs `job` on the writer thread alone and outside a transaction — for
    /// statements that refuse to run inside one (VACUUM) and for maintenance
    /// that should not share a commit with other writes.
    pub fn maintain<T, E, F>(&self, job: F) -> Result<T, E>
    where
        T: Send + 'static,
        E: From<Error> + Send + 'static,
        F: FnOnce(&Connection) -> Result<T, E> + Send + 'static,
    {
        let (job, rx) = bare_job(job, false);
        match &self.write_tx {
            Some(tx) if tx.send(WriteJob::Bare(job)).is_ok() => rx.wait().unwrap_or_else(|| Err(Error::Closed.into())),
            _ => Err(Error::Closed.into()),
        }
    }

    /// Runs `job` on a read-only connection, inside one read transaction.
    /// Waits while the queue is full.
    pub fn read<T, E, F>(&self, job: F) -> Result<T, E>
    where
        T: Send + 'static,
        E: From<Error> + Send + 'static,
        F: FnOnce(&Connection) -> Result<T, E> + Send + 'static,
    {
        let (job, rx) = bare_job(job, true);
        match &self.read_tx {
            Some(tx) if tx.send(job).is_ok() => rx.wait().unwrap_or_else(|| Err(Error::Closed.into())),
            _ => Err(Error::Closed.into()),
        }
    }

    /// [`read`](Self::read) without blocking: a full queue is answered with [`Error::QueueFull`].
    pub fn read_async<T, E, F>(&self, job: F) -> Receipt<T, E>
    where
        T: Send + 'static,
        E: From<Error> + Send + 'static,
        F: FnOnce(&Connection) -> Result<T, E> + Send + 'static,
    {
        let (job, rx) = bare_job(job, true);
        submit(self.read_tx.as_ref(), job, rx)
    }

    /// Runs everything already queued, then stops the threads and folds the
    /// WAL back into the file.
    pub fn close(mut self) -> Stats {
        self.shutdown();
        self.stats()
    }

    fn shutdown(&mut self) {
        self.read_tx.take();
        for reader in self.readers.drain(..) {
            let _ = reader.join();
        }
        // Readers first: the writer's final checkpoint can then truncate the WAL.
        self.write_tx.take();
        if let Some(writer) = self.writer.take() {
            let _ = writer.join();
        }
    }
}

impl Drop for Db {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn submit<J, T, E>(tx: Option<&Sender<J>>, job: J, rx: oneshot::Receiver<Result<T, E>>) -> Receipt<T, E> {
    let inner = match tx.map(|tx| tx.try_send(job)) {
        Some(Ok(())) => ReceiptInner::Pending(rx),
        Some(Err(TrySendError::Full(_))) => ReceiptInner::Refused(Some(Error::QueueFull)),
        Some(Err(TrySendError::Disconnected(_))) | None => ReceiptInner::Refused(Some(Error::Closed)),
    };
    Receipt { inner }
}

fn panic_message(payload: Box<dyn Any + Send>) -> String {
    match payload.downcast::<String>() {
        Ok(s) => *s,
        Err(payload) => payload.downcast::<&'static str>().map_or_else(|_| "panic".to_owned(), |s| (*s).to_owned()),
    }
}

fn tx_job<T, E, F>(job: F) -> (TxJob, oneshot::Receiver<Result<T, E>>)
where
    T: Send + 'static,
    E: From<Error> + Send + 'static,
    F: FnOnce(&Connection) -> Result<T, E> + Send + 'static,
{
    tx_job_then(job, |_| ())
}

fn tx_job_then<T, E, F, A>(job: F, after_commit: A) -> (TxJob, oneshot::Receiver<Result<T, E>>)
where
    T: Send + 'static,
    E: From<Error> + Send + 'static,
    F: FnOnce(&Connection) -> Result<T, E> + Send + 'static,
    A: FnOnce(&T) + Send + 'static,
{
    let (tx, rx) = oneshot::channel();
    let run: TxJob = Box::new(move |conn| {
        let (result, usable) = match conn {
            Ok(conn) => in_savepoint(conn, job),
            Err(e) => (Err(Error::BeginFailed(e.to_string()).into()), false),
        };
        let reply: Reply = Box::new(move |committed| {
            tx.send(match result {
                Ok(_) if !committed => Err(Error::CommitFailed.into()),
                Ok(value) => {
                    // The write is saved whatever the hook does: a panic in it must not take the writer down.
                    let _ = catch_unwind(AssertUnwindSafe(|| after_commit(&value)));
                    Ok(value)
                }
                other => other,
            });
        });
        (reply, usable)
    });
    (run, rx)
}

/// Runs one write under a savepoint. The flag is false when the surrounding
/// transaction can no longer be trusted (the savepoint itself failed).
fn in_savepoint<T, E, F>(conn: &Connection, job: F) -> (Result<T, E>, bool)
where
    E: From<Error>,
    F: FnOnce(&Connection) -> Result<T, E>,
{
    let exec = |sql: &str| conn.prepare_cached(sql).and_then(|mut s| s.execute([]));
    if let Err(e) = exec("SAVEPOINT eos_job") {
        return (Err(Error::Sqlite(e).into()), false);
    }
    let undo = || exec("ROLLBACK TO eos_job").and_then(|_| exec("RELEASE eos_job")).is_ok();
    match catch_unwind(AssertUnwindSafe(|| job(conn))) {
        Ok(Ok(value)) => match exec("RELEASE eos_job") {
            Ok(_) => (Ok(value), true),
            Err(e) => (Err(Error::Sqlite(e).into()), false),
        },
        Ok(Err(e)) => (Err(e), undo()),
        Err(payload) => (Err(Error::JobPanicked(panic_message(payload)).into()), undo()),
    }
}

fn bare_job<T, E, F>(job: F, read_snapshot: bool) -> (BareJob, oneshot::Receiver<Result<T, E>>)
where
    T: Send + 'static,
    E: From<Error> + Send + 'static,
    F: FnOnce(&Connection) -> Result<T, E> + Send + 'static,
{
    let (tx, rx) = oneshot::channel();
    let run: BareJob = Box::new(move |conn| {
        if read_snapshot && let Err(e) = conn.prepare_cached("BEGIN").and_then(|mut s| s.execute([])) {
            tx.send(Err(Error::Sqlite(e).into()));
            return;
        }
        let result = catch_unwind(AssertUnwindSafe(|| job(conn)))
            .unwrap_or_else(|payload| Err(Error::JobPanicked(panic_message(payload)).into()));
        // Whatever the job left open ends here: a read snapshot, or a transaction a failed job abandoned.
        if !conn.is_autocommit() {
            let _ = conn.execute_batch("ROLLBACK");
        }
        tx.send(result);
    });
    (run, rx)
}

fn reader_loop(conn: Connection, rx: Receiver<BareJob>) {
    for job in rx {
        job(&conn);
    }
}

fn writer_loop(conn: Connection, rx: Receiver<WriteJob>, max_batch: usize, counters: &Counters) {
    let mut replies: Vec<Reply> = Vec::with_capacity(max_batch);
    // A maintenance job met while draining waits here until the batch has committed.
    let mut carried: Option<WriteJob> = None;
    loop {
        let job = match carried.take() {
            Some(job) => job,
            // Ends once every sender is gone and the queue is empty.
            None => match rx.recv() {
                Ok(job) => job,
                Err(_) => break,
            },
        };
        let first = match job {
            WriteJob::Bare(run) => {
                run(&conn);
                continue;
            }
            WriteJob::Tx(run) => run,
        };

        let committed = match conn.execute_batch("BEGIN IMMEDIATE") {
            Err(e) => {
                replies.push(first(Err(&e)).0);
                false
            }
            Ok(()) => {
                let mut usable = true;
                let mut next = Some(first);
                while let Some(run) = next.take() {
                    let (reply, ok) = run(Ok(&conn));
                    replies.push(reply);
                    if !ok {
                        usable = false;
                    } else if replies.len() < max_batch {
                        match rx.try_recv() {
                            Ok(WriteJob::Tx(run)) => next = Some(run),
                            Ok(bare) => carried = Some(bare),
                            Err(_) => {}
                        }
                    }
                }
                let committed = usable && conn.execute_batch("COMMIT").is_ok();
                if !committed && !conn.is_autocommit() {
                    let _ = conn.execute_batch("ROLLBACK");
                }
                committed
            }
        };
        counters.commits.fetch_add(u64::from(committed), Ordering::Relaxed);
        counters.writes.fetch_add(replies.len() as u64, Ordering::Relaxed);
        counters.largest_batch.fetch_max(replies.len() as u64, Ordering::Relaxed);
        for reply in replies.drain(..) {
            reply(committed);
        }
    }
    // Leave the file as a clean close would: WAL folded in and truncated.
    let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
}
