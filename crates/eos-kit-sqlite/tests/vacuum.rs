//! The weekly vacuum.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::thread;

use eos_kit_sqlite::rusqlite::{Connection, params};
use eos_kit_sqlite::{Db, Error, Options, VACUUM_INTERVAL_MS, VACUUM_MARKER, VACUUM_SLICE_PAGES, VacuumOutcome};

const NOW: i64 = 1_800_000_000_000;

fn pragma(db: &Db, name: &'static str) -> i64 {
    db.maintain(move |c| Ok::<_, Error>(c.pragma_query_value(None, name, |r| r.get(0))?)).expect("pragma")
}

/// Frees `pages` pages: one overflow row per page, then a delete wave.
fn free_pages(db: &Db, pages: u32) {
    db.write(move |c| {
        let payload = "x".repeat(4000);
        let mut insert =
            c.prepare("INSERT INTO events (worker_id, ts, type, payload) VALUES ('w-gone', ?1, 'jsonl', ?2)")?;
        for i in 0..pages {
            insert.execute(params![i, payload])?;
        }
        Ok::<_, Error>(())
    })
    .expect("fill");
    db.write(|c| Ok::<_, Error>(c.execute("DELETE FROM events WHERE worker_id = 'w-gone'", [])?)).expect("delete");
}

#[test]
fn an_incremental_file_shrinks_in_slices_while_writes_keep_running() {
    let dir = tempfile::tempdir().expect("dir");
    let (db, _) = Db::open(dir.path().join("state.db"), Options::default(), NOW).expect("open");
    let db = Arc::new(db);
    assert_eq!(pragma(&db, "auto_vacuum"), 2, "a new file is born incremental");
    free_pages(&db, VACUUM_SLICE_PAGES * 8);
    let freed = pragma(&db, "freelist_count");
    assert!(freed >= i64::from(VACUUM_SLICE_PAGES) * 8);
    let pages_before = pragma(&db, "page_count");

    let running = Arc::new(AtomicBool::new(true));
    let during = Arc::new(AtomicU32::new(0));
    let writer = {
        let (db, running, during) = (db.clone(), running.clone(), during.clone());
        thread::spawn(move || {
            let mut written = 0i64;
            while running.load(Ordering::SeqCst) {
                db.write(|c| {
                    Ok::<_, Error>(c.execute(
                        "INSERT INTO events (worker_id, ts, type, payload) VALUES ('w-live', 0, 'jsonl', '{}')",
                        [],
                    )?)
                })
                .expect("live write");
                written += 1;
                during.fetch_add(1, Ordering::SeqCst);
            }
            written
        })
    };
    while during.load(Ordering::SeqCst) == 0 {
        thread::yield_now();
    }
    let outcome = db.maybe_vacuum(NOW).expect("vacuum");
    let during_run = i64::from(during.load(Ordering::SeqCst));
    running.store(false, Ordering::SeqCst);
    let written = writer.join().expect("writer thread");

    assert!(matches!(outcome, VacuumOutcome::Incremental { slices } if slices >= 8), "{outcome:?}");
    assert!(during_run > 1, "the writer ran between slices");
    assert_eq!(pragma(&db, "freelist_count"), 0);
    assert!(pragma(&db, "page_count") <= pages_before - freed + written);
    let (live, check, marker): (i64, String, i64) = db
        .read(|c| {
            Ok::<_, Error>((
                c.query_row("SELECT COUNT(*) FROM events WHERE worker_id = 'w-live'", [], |r| r.get(0))?,
                c.pragma_query_value(None, "quick_check", |r| r.get(0))?,
                c.query_row("SELECT applied_at FROM schema_migrations WHERE id = ?1", [VACUUM_MARKER], |r| r.get(0))?,
            ))
        })
        .expect("read");
    assert_eq!(live, written);
    assert_eq!(check, "ok");
    assert_eq!(marker, NOW);
}

#[test]
fn a_file_created_without_auto_vacuum_is_switched_by_one_full_vacuum() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("state.db");
    Connection::open(&path).and_then(|c| c.execute_batch("CREATE TABLE legacy (x)")).expect("legacy file");
    let (db, _) = Db::open(&path, Options::default(), NOW).expect("open");
    assert_eq!(pragma(&db, "auto_vacuum"), 0);
    free_pages(&db, 64);
    assert_eq!(db.maybe_vacuum(NOW).expect("vacuum"), VacuumOutcome::Full);
    assert_eq!(pragma(&db, "auto_vacuum"), 2);
    assert_eq!(pragma(&db, "freelist_count"), 0);
}

#[test]
fn it_waits_while_a_worker_is_live_and_until_the_week_is_up() {
    let dir = tempfile::tempdir().expect("dir");
    let (db, _) = Db::open(dir.path().join("state.db"), Options::default(), NOW).expect("open");
    db.write(|c| {
        Ok::<_, Error>(
            c.execute("INSERT INTO workers (id, state, prompt, started_at) VALUES ('w', 'WORKING', '', 0)", [])?,
        )
    })
    .expect("worker");
    free_pages(&db, 64);
    assert_eq!(db.maybe_vacuum(NOW).expect("vacuum"), VacuumOutcome::WorkersLive);
    assert!(pragma(&db, "freelist_count") > 0, "skipped while a worker is live");

    db.write(|c| Ok::<_, Error>(c.execute("UPDATE workers SET state = 'SUSPENDED'", [])?)).expect("suspend");
    db.write(|c| {
        Ok::<_, Error>(
            c.execute("INSERT INTO schema_migrations (id, applied_at) VALUES (?1, ?2)", params![VACUUM_MARKER, NOW])?,
        )
    })
    .expect("marker");
    assert_eq!(db.maybe_vacuum(NOW + VACUUM_INTERVAL_MS - 1).expect("vacuum"), VacuumOutcome::NotDue);
    assert!(pragma(&db, "freelist_count") > 0, "skipped inside the interval");

    assert!(matches!(db.maybe_vacuum(NOW + VACUUM_INTERVAL_MS).expect("vacuum"), VacuumOutcome::Incremental { .. }));
    assert_eq!(pragma(&db, "freelist_count"), 0);
}
