//! The write path: one writer thread owns the only read-write connection and
//! commits whatever is queued as one transaction (group commit); a fixed set of
//! read-only connections serves reads.
//!
//! A write is a closure run on the writer thread inside the batch's transaction,
//! each under its own savepoint, so one failing write undoes only itself. The
//! caller hears back after COMMIT — a row id is durable before anyone sees it —
//! and replies go out in the order the writes ran.

use std::{
    path::{Path, PathBuf},
    sync::mpsc,
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use crossbeam_channel as cb;
use rusqlite::{Connection, OpenFlags};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Synchronous {
    Normal,
    Full,
}

#[derive(Debug, Clone)]
pub struct DbOptions {
    pub synchronous: Synchronous,
    pub readers: usize,
    /// Most writes folded into one transaction.
    pub max_batch: usize,
    /// How long the writer waits for more writes once it has one.
    pub linger: Duration,
    pub queue: usize,
}

impl Default for DbOptions {
    fn default() -> Self {
        Self { synchronous: Synchronous::Normal, readers: 3, max_batch: 256, linger: Duration::ZERO, queue: 1024 }
    }
}

type WriteJob = Box<dyn FnOnce(&Connection) -> Box<dyn FnOnce(bool) + Send> + Send>;
type ReadJob = Box<dyn FnOnce(&Connection) + Send>;

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("the batch this write was part of failed to commit")]
    CommitFailed,
    #[error("the database is closed")]
    Closed,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct WriterStats {
    pub commits: u64,
    pub writes: u64,
    pub largest_batch: usize,
}

pub struct Db {
    write_tx: Option<cb::Sender<WriteJob>>,
    read_tx: Option<cb::Sender<ReadJob>>,
    writer: Option<JoinHandle<WriterStats>>,
    readers: Vec<JoinHandle<()>>,
}

impl std::fmt::Debug for Db {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Db").field("readers", &self.readers.len()).finish()
    }
}

/// The pragmas every connection gets. `journal_mode=WAL` is persistent and
/// already set on a file the TypeScript daemon created.
pub fn open_rw(path: &Path, synchronous: Synchronous) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", if synchronous == Synchronous::Full { "FULL" } else { "NORMAL" })?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.pragma_update(None, "journal_size_limit", 64 * 1024 * 1024)?;
    conn.set_prepared_statement_cache_capacity(128);
    Ok(conn)
}

pub fn open_ro(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.pragma_update(None, "query_only", true)?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.set_prepared_statement_cache_capacity(128);
    Ok(conn)
}

impl Db {
    pub fn open(path: impl Into<PathBuf>, opts: DbOptions) -> rusqlite::Result<Self> {
        let path: PathBuf = path.into();
        let conn = open_rw(&path, opts.synchronous)?;
        let (write_tx, write_rx) = cb::bounded::<WriteJob>(opts.queue);
        let writer = thread::Builder::new()
            .name("db-writer".into())
            .spawn(move || writer_loop(conn, write_rx, opts.max_batch, opts.linger))
            .expect("spawn writer");

        let (read_tx, read_rx) = cb::bounded::<ReadJob>(opts.queue);
        let mut readers = Vec::new();
        for i in 0..opts.readers {
            let conn = open_ro(&path)?;
            let rx = read_rx.clone();
            readers.push(
                thread::Builder::new()
                    .name(format!("db-reader-{i}"))
                    .spawn(move || {
                        for job in rx {
                            job(&conn);
                        }
                    })
                    .expect("spawn reader"),
            );
        }
        Ok(Self { write_tx: Some(write_tx), read_tx: Some(read_tx), writer: Some(writer), readers })
    }

    /// Runs `f` on the writer thread and returns once its batch has committed.
    pub fn write<T, F>(&self, f: F) -> Result<T, DbError>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> rusqlite::Result<T> + Send + 'static,
    {
        let (reply_tx, reply_rx) = mpsc::sync_channel::<Result<T, DbError>>(1);
        let job: WriteJob = Box::new(move |conn| {
            // A savepoint per write: a failure rolls back this write only.
            let result = (|| {
                conn.prepare_cached("SAVEPOINT w")?.execute([])?;
                match f(conn) {
                    Ok(value) => {
                        conn.prepare_cached("RELEASE w")?.execute([])?;
                        Ok(value)
                    }
                    Err(e) => {
                        conn.execute_batch("ROLLBACK TO w; RELEASE w")?;
                        Err(e)
                    }
                }
            })();
            Box::new(move |committed| {
                let _ = reply_tx.send(match result {
                    Ok(v) if committed => Ok(v),
                    Ok(_) => Err(DbError::CommitFailed),
                    Err(e) => Err(DbError::Sqlite(e)),
                });
            })
        });
        self.write_tx.as_ref().ok_or(DbError::Closed)?.send(job).map_err(|_| DbError::Closed)?;
        reply_rx.recv().map_err(|_| DbError::Closed)?
    }

    /// Runs `f` on one of the read-only connections.
    pub fn read<T, F>(&self, f: F) -> Result<T, DbError>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> rusqlite::Result<T> + Send + 'static,
    {
        let (reply_tx, reply_rx) = mpsc::sync_channel::<rusqlite::Result<T>>(1);
        let job: ReadJob = Box::new(move |conn| {
            let _ = reply_tx.send(f(conn));
        });
        self.read_tx.as_ref().ok_or(DbError::Closed)?.send(job).map_err(|_| DbError::Closed)?;
        Ok(reply_rx.recv().map_err(|_| DbError::Closed)??)
    }

    /// Stops both sides after the queued work is done.
    pub fn close(mut self) -> WriterStats {
        self.shutdown()
    }

    fn shutdown(&mut self) -> WriterStats {
        self.write_tx.take();
        self.read_tx.take();
        let stats = self.writer.take().and_then(|w| w.join().ok()).unwrap_or_default();
        for r in self.readers.drain(..) {
            let _ = r.join();
        }
        stats
    }
}

impl Drop for Db {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn writer_loop(mut conn: Connection, rx: cb::Receiver<WriteJob>, max_batch: usize, linger: Duration) -> WriterStats {
    let mut stats = WriterStats::default();
    let mut replies: Vec<Box<dyn FnOnce(bool) + Send>> = Vec::with_capacity(max_batch);
    while let Ok(first) = rx.recv() {
        let committed = (|| {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            replies.push(first(&tx));
            let deadline = Instant::now() + linger;
            while replies.len() < max_batch {
                let next = if linger.is_zero() { rx.try_recv().ok() } else { rx.recv_deadline(deadline).ok() };
                match next {
                    Some(job) => replies.push(job(&tx)),
                    None => break,
                }
            }
            tx.commit()
        })()
        .is_ok();
        stats.commits += 1;
        stats.writes += replies.len() as u64;
        stats.largest_batch = stats.largest_batch.max(replies.len());
        for reply in replies.drain(..) {
            reply(committed);
        }
    }
    // Leave the file as a clean close would: WAL folded in and truncated.
    let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
    stats
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrate::{MIGRATIONS, run};
    use std::sync::Arc;

    fn fresh(dir: &tempfile::TempDir, opts: DbOptions) -> Db {
        let path = dir.path().join("state.db");
        let conn = open_rw(&path, Synchronous::Normal).unwrap();
        run(&conn, MIGRATIONS, 1).unwrap();
        drop(conn);
        Db::open(path, opts).unwrap()
    }

    fn append(tx: &Connection, worker: &str, payload: &str) -> rusqlite::Result<i64> {
        tx.prepare_cached("INSERT INTO events (worker_id, ts, type, payload) VALUES (?1, ?2, 'text', ?3)")?
            .execute(rusqlite::params![worker, 1, payload])?;
        Ok(tx.last_insert_rowid())
    }

    #[test]
    fn a_row_id_is_readable_as_soon_as_the_write_returns() {
        let dir = tempfile::tempdir().unwrap();
        let db = fresh(&dir, DbOptions::default());
        for i in 0..50 {
            let id = db.write(move |tx| append(tx, "w", &format!("{i}"))).unwrap();
            let seen: String =
                db.read(move |c| c.query_row("SELECT payload FROM events WHERE id = ?1", [id], |r| r.get(0))).unwrap();
            assert_eq!(seen, format!("{i}"));
        }
    }

    #[test]
    fn concurrent_writers_get_distinct_increasing_ids_and_are_batched() {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(fresh(&dir, DbOptions { linger: Duration::from_millis(1), ..DbOptions::default() }));
        let handles: Vec<_> = (0..8)
            .map(|t| {
                let db = db.clone();
                thread::spawn(move || {
                    let mut last = 0;
                    for i in 0..200 {
                        let id = db.write(move |tx| append(tx, &format!("w{t}"), &format!("{i}"))).unwrap();
                        assert!(id > last, "ids of one caller rise");
                        last = id;
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let n: i64 = db.read(|c| c.query_row("SELECT count(*) FROM events", [], |r| r.get(0))).unwrap();
        assert_eq!(n, 1600);
        let stats = Arc::into_inner(db).unwrap().close();
        assert_eq!(stats.writes, 1600);
        assert!(stats.commits < 1600, "writes were folded into fewer commits: {stats:?}");
    }

    #[test]
    fn a_failing_write_undoes_only_itself() {
        let dir = tempfile::tempdir().unwrap();
        let db = fresh(&dir, DbOptions::default());
        let bad = db.write(|tx| {
            append(tx, "w", "half")?;
            tx.execute("INSERT INTO nowhere VALUES (1)", [])?;
            Ok(())
        });
        assert!(matches!(bad, Err(DbError::Sqlite(_))));
        db.write(|tx| append(tx, "w", "whole")).unwrap();
        let rows: Vec<String> =
            db.read(|c| c.prepare("SELECT payload FROM events")?.query_map([], |r| r.get(0))?.collect()).unwrap();
        assert_eq!(rows, vec!["whole"]);
    }

    #[test]
    fn a_read_connection_cannot_write() {
        let dir = tempfile::tempdir().unwrap();
        let db = fresh(&dir, DbOptions::default());
        let res = db.read(|c| c.execute("DELETE FROM events", []));
        assert!(res.is_err());
    }
}
