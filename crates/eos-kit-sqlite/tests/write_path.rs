//! The write path under concurrency: ordering, isolation of failures, bounds, shutdown.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, mpsc};
use std::thread;
use std::time::Duration;

use eos_kit_sqlite::rusqlite::{Connection, params};
use eos_kit_sqlite::{Db, Error, Options};

fn fresh(dir: &tempfile::TempDir, options: Options) -> Db {
    let (db, report) = Db::open(dir.path().join("state.db"), options, 1).expect("open");
    assert_eq!(report.applied.len(), eos_kit_sqlite::EMBEDDED.len());
    db
}

fn append(conn: &Connection, worker: &str, payload: &str) -> Result<i64, Error> {
    conn.prepare_cached("INSERT INTO events (worker_id, ts, type, payload) VALUES (?1, ?2, 'text', ?3)")?
        .execute(params![worker, 1, payload])?;
    Ok(conn.last_insert_rowid())
}

fn count(db: &Db) -> i64 {
    db.read(|c| Ok::<_, Error>(c.query_row("SELECT count(*) FROM events", [], |r| r.get(0))?)).expect("count")
}

fn payloads(db: &Db) -> Vec<String> {
    db.read(|c| {
        let mut stmt = c.prepare("SELECT payload FROM events ORDER BY id")?;
        let rows = stmt.query_map([], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
        Ok::<_, Error>(rows)
    })
    .expect("payloads")
}

#[test]
fn a_row_is_readable_as_soon_as_the_write_returns() {
    let dir = tempfile::tempdir().expect("dir");
    let db = fresh(&dir, Options::default());
    for i in 0..50 {
        let id = db.write(move |c| append(c, "w", &i.to_string())).expect("write");
        let seen: String = db
            .read(move |c| Ok::<_, Error>(c.query_row("SELECT payload FROM events WHERE id = ?1", [id], |r| r.get(0))?))
            .expect("read");
        assert_eq!(seen, i.to_string());
    }
}

#[test]
fn concurrent_writers_get_distinct_rising_ids_and_share_commits() {
    let dir = tempfile::tempdir().expect("dir");
    let db = Arc::new(fresh(&dir, Options::default()));
    let start = Arc::new(Barrier::new(8));
    let handles: Vec<_> = (0..8)
        .map(|t| {
            let (db, start) = (db.clone(), start.clone());
            thread::spawn(move || {
                start.wait();
                let mut last = 0;
                for i in 0..200 {
                    let id = db.write(move |c| append(c, &format!("w{t}"), &i.to_string())).expect("write");
                    assert!(id > last, "one caller's ids rise");
                    last = id;
                }
            })
        })
        .collect();
    for h in handles {
        h.join().expect("writer thread");
    }
    assert_eq!(count(&db), 1600);
    let stats = Arc::into_inner(db).expect("sole owner").close();
    assert_eq!(stats.writes, 1600);
    assert!(stats.commits < 1600 && stats.largest_batch > 1, "writes were folded into fewer commits: {stats:?}");
}

#[test]
fn queued_writes_run_and_answer_in_the_order_they_were_submitted() {
    let dir = tempfile::tempdir().expect("dir");
    let db = fresh(&dir, Options::default());
    // Hold the writer so everything below is queued behind it.
    let (release, held) = mpsc::channel::<()>();
    let gate = db.write_async(move |_| {
        let _ = held.recv();
        Ok::<_, Error>(())
    });
    let receipts: Vec<_> = (0..100).map(|i| db.write_async(move |c| append(c, "w", &i.to_string()))).collect();
    release.send(()).expect("release");
    gate.wait().expect("gate");
    let ids: Vec<i64> = receipts.into_iter().map(|r| r.wait().expect("write")).collect();
    assert!(ids.windows(2).all(|w| w[0] < w[1]), "row ids follow submission order");
    assert_eq!(payloads(&db), (0..100).map(|i| i.to_string()).collect::<Vec<_>>());
    assert!(db.stats().largest_batch >= 100, "the queued writes shared one commit");
}

#[test]
fn a_failing_write_undoes_only_itself() {
    let dir = tempfile::tempdir().expect("dir");
    let db = fresh(&dir, Options::default());
    let (release, held) = mpsc::channel::<()>();
    let gate = db.write_async(move |_| {
        let _ = held.recv();
        Ok::<_, Error>(())
    });
    // All three land in one batch.
    let before = db.write_async(|c| append(c, "w", "before"));
    let bad = db.write_async(|c| {
        append(c, "w", "half")?;
        c.execute("INSERT INTO nowhere VALUES (1)", [])?;
        Ok::<_, Error>(())
    });
    let after = db.write_async(|c| append(c, "w", "after"));
    release.send(()).expect("release");
    gate.wait().expect("gate");
    before.wait().expect("before");
    assert!(matches!(bad.wait(), Err(Error::Sqlite(_))));
    after.wait().expect("after");
    assert_eq!(payloads(&db), ["before", "after"]);
}

#[derive(Debug)]
enum DomainError {
    Conflict,
    Db(Error),
}

impl From<Error> for DomainError {
    fn from(e: Error) -> Self {
        Self::Db(e)
    }
}

#[test]
fn a_job_can_fail_with_the_callers_own_error() {
    let dir = tempfile::tempdir().expect("dir");
    let db = fresh(&dir, Options::default());
    let out: Result<(), DomainError> = db.write(|c| {
        append(c, "w", "undone")?;
        Err(DomainError::Conflict)
    });
    assert!(matches!(out, Err(DomainError::Conflict)));
    assert_eq!(count(&db), 0);
    drop(db);
    let closed: Result<(), DomainError> = Err(Error::Closed.into());
    assert!(matches!(closed, Err(DomainError::Db(Error::Closed))));
}

#[test]
fn a_panicking_job_is_undone_and_does_not_kill_the_writer_or_a_reader() {
    let dir = tempfile::tempdir().expect("dir");
    let db = fresh(&dir, Options { readers: 1, ..Options::default() });
    let boom: Result<(), Error> = db.write(|c| {
        append(c, "w", "lost")?;
        panic!("job blew up");
    });
    assert!(matches!(&boom, Err(Error::JobPanicked(msg)) if msg == "job blew up"), "{boom:?}");
    let read: Result<(), Error> = db.read(|_| panic!("read blew up"));
    assert!(matches!(read, Err(Error::JobPanicked(_))));
    let maintain: Result<(), Error> = db.maintain(|_| panic!("maintenance blew up"));
    assert!(matches!(maintain, Err(Error::JobPanicked(_))));

    db.write(|c| append(c, "w", "kept")).expect("the writer is still there");
    assert_eq!(payloads(&db), ["kept"]);
}

#[test]
fn a_job_that_ends_the_transaction_fails_its_batch_but_not_the_writer() {
    let dir = tempfile::tempdir().expect("dir");
    let db = fresh(&dir, Options::default());
    let rogue: Result<(), Error> = db.write(|c| {
        append(c, "w", "rogue")?;
        c.execute_batch("COMMIT")?;
        Ok(())
    });
    assert!(rogue.is_err(), "{rogue:?}");
    db.write(|c| append(c, "w", "next")).expect("next write");
    assert!(payloads(&db).contains(&"next".to_owned()));
}

#[test]
fn readers_cannot_write_and_see_one_snapshot_per_job() {
    let dir = tempfile::tempdir().expect("dir");
    let db = Arc::new(fresh(&dir, Options::default()));
    let denied: Result<usize, Error> = db.read(|c| Ok(c.execute("DELETE FROM events", [])?));
    assert!(denied.is_err());

    let stop = Arc::new(AtomicBool::new(false));
    let writer = {
        let (db, stop) = (db.clone(), stop.clone());
        thread::spawn(move || {
            let mut n = 0u32;
            while !stop.load(Ordering::Relaxed) {
                // Two rows per write: a reader must never see an odd count.
                db.write(|c| {
                    append(c, "pair", "a")?;
                    append(c, "pair", "b")
                })
                .expect("write");
                n += 1;
            }
            n
        })
    };
    let mut last = 0;
    for _ in 0..300 {
        let (first, second): (i64, i64) = db
            .read(|c| {
                let n = |c: &Connection| c.query_row("SELECT count(*) FROM events", [], |r| r.get::<_, i64>(0));
                let first = n(c)?;
                thread::sleep(Duration::from_micros(200));
                Ok::<_, Error>((first, n(c)?))
            })
            .expect("read");
        assert_eq!(first, second, "one job reads one snapshot");
        assert_eq!(first % 2, 0, "a write is seen whole or not at all");
        assert!(first >= last, "commits are never unseen again");
        last = first;
    }
    stop.store(true, Ordering::Relaxed);
    let written = writer.join().expect("writer thread");
    assert!(written > 0);
    assert_eq!(count(&db), i64::from(written) * 2);
}

#[test]
fn a_full_queue_makes_write_wait_and_write_async_refuse() {
    let dir = tempfile::tempdir().expect("dir");
    let db = Arc::new(fresh(&dir, Options { queue: 4, ..Options::default() }));
    let (release, held) = mpsc::channel::<()>();
    let (started_tx, started) = mpsc::channel::<()>();
    let gate = db.write_async(move |_| {
        let _ = started_tx.send(());
        let _ = held.recv();
        Ok::<_, Error>(())
    });
    started.recv().expect("the writer is busy");
    let queued: Vec<_> = (0..4).map(|i| db.write_async(move |c| append(c, "w", &i.to_string()))).collect();
    let refused = db.write_async(|c| append(c, "w", "refused"));
    assert!(matches!(refused.wait(), Err(Error::QueueFull)));

    let blocked = {
        let db = db.clone();
        thread::spawn(move || db.write(|c| append(c, "w", "waited")))
    };
    thread::sleep(Duration::from_millis(50));
    assert!(!blocked.is_finished(), "write waits for room instead of failing");
    release.send(()).expect("release");
    gate.wait().expect("gate");
    for r in queued {
        r.wait().expect("queued write");
    }
    blocked.join().expect("thread").expect("the waiting write went through");
    assert_eq!(count(&db), 5);
}

#[test]
fn closing_runs_everything_already_queued_and_truncates_the_wal() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("state.db");
    let db = fresh(&dir, Options::default());
    let (release, held) = mpsc::channel::<()>();
    let gate = db.write_async(move |_| {
        let _ = held.recv();
        Ok::<_, Error>(())
    });
    let receipts: Vec<_> = (0..500).map(|i| db.write_async(move |c| append(c, "w", &i.to_string()))).collect();
    let closer = thread::spawn(move || db.close());
    release.send(()).expect("release");
    let stats = closer.join().expect("close");
    gate.wait().expect("gate");
    for r in receipts {
        r.wait().expect("a queued write is not dropped by close");
    }
    assert_eq!(stats.writes, 501);

    let wal = std::fs::metadata(dir.path().join("state.db-wal")).map(|m| m.len()).unwrap_or(0);
    assert_eq!(wal, 0, "the WAL was folded back into the file");
    let (db, report) = Db::open(&path, Options::default(), 2).expect("reopen");
    assert!(report.up_to_date());
    assert_eq!(count(&db), 500);
}

#[test]
fn dropping_the_database_still_runs_a_write_already_queued() {
    let dir = tempfile::tempdir().expect("dir");
    let db = fresh(&dir, Options::default());
    let pending = db.write_async(|c| append(c, "w", "x"));
    drop(db);
    pending.wait().expect("ran before the close finished");
}

#[test]
fn a_receipt_can_be_awaited() {
    use std::future::Future;
    use std::pin::pin;
    use std::task::{Context, Poll, Wake, Waker};

    struct Flag(AtomicBool);
    impl Wake for Flag {
        fn wake(self: Arc<Self>) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    let dir = tempfile::tempdir().expect("dir");
    let db = fresh(&dir, Options::default());
    let (release, held) = mpsc::channel::<()>();
    let mut receipt = pin!(db.write_async(move |c| {
        let _ = held.recv();
        append(c, "w", "awaited")
    }));
    let flag = Arc::new(Flag(AtomicBool::new(false)));
    let waker = Waker::from(flag.clone());
    let mut cx = Context::from_waker(&waker);
    assert!(receipt.as_mut().poll(&mut cx).is_pending());
    release.send(()).expect("release");
    while !flag.0.load(Ordering::SeqCst) {
        thread::yield_now();
    }
    assert!(matches!(receipt.as_mut().poll(&mut cx), Poll::Ready(Ok(id)) if id > 0));
}

#[test]
fn after_commit_hooks_run_in_commit_order_and_only_for_saved_writes() {
    let dir = tempfile::tempdir().expect("dir");
    let db = Arc::new(fresh(&dir, Options::default()));
    let announced = Arc::new(std::sync::Mutex::new(Vec::<i64>::new()));

    // Eight threads write flat out; each write announces its row id from the hook.
    let threads: Vec<_> = (0..8)
        .map(|t| {
            let (db, announced) = (db.clone(), announced.clone());
            thread::spawn(move || {
                for i in 0..200 {
                    let seen = announced.clone();
                    let saved = db
                        .write_then_async(
                            move |c| append(c, "w", &format!("{t}-{i}")),
                            move |id| seen.lock().expect("announced").push(*id),
                        )
                        .wait();
                    assert!(saved.is_ok() || matches!(saved, Err(Error::QueueFull)));
                }
            })
        })
        .collect();
    for t in threads {
        t.join().expect("writer thread");
    }
    let failed =
        db.write_then_async(|_| Err::<i64, Error>(Error::Closed), |_| panic!("a failed write announces nothing"));
    assert!(failed.wait().is_err());
    let panicking = db.write_then_async(|c| append(c, "w", "after a hook that panics"), |_| panic!("hook bug"));
    assert!(panicking.wait().is_ok(), "the write is saved whatever its hook does");

    let announced = announced.lock().expect("announced");
    assert!(!announced.is_empty());
    assert!(announced.windows(2).all(|w| w[0] < w[1]), "announced in the order the rows were saved");
    assert_eq!(count(&db), announced.len() as i64 + 1);
}

#[test]
fn every_thread_of_the_database_runs_the_start_hook_first() {
    static STARTED: AtomicUsize = AtomicUsize::new(0);
    let dir = tempfile::tempdir().expect("dir");
    let db = fresh(
        &dir,
        Options {
            readers: 4,
            on_thread_start: || {
                STARTED.fetch_add(1, Ordering::SeqCst);
            },
            ..Options::default()
        },
    );
    db.write(|c| append(c, "w", "x")).expect("write");
    assert_eq!(count(&db), 1);
    db.close();
    assert_eq!(STARTED.load(Ordering::SeqCst), 5, "the writer and four readers");
}
