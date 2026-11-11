//! Measures the write path on a copy of a real `state.db`:
//!   1. event append throughput: one commit per row (what the TypeScript daemon
//!      does) vs the writer thread's group commit, synchronous FULL and NORMAL
//!   2. latency of the "newest 200 events" read while appends run flat out
//!   3. backup API vs APFS clone for the pre-open snapshot
//!
//!   statedb-bench <state.db copy> [seconds per run]
//!
//! Every run works on its own APFS clone of the file and removes it afterwards.

use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use rusqlite::{Connection, params};
use serde_json::json;
use spike_statedb::db::{Db, DbOptions, Synchronous, open_ro, open_rw};

const INSERT: &str = "INSERT INTO events (worker_id, ts, type, payload) VALUES (?1, ?2, ?3, ?4)";
const NEWEST: &str = "SELECT * FROM (SELECT * FROM events WHERE worker_id = ?1 AND ts > ?2 ORDER BY ts DESC, id DESC LIMIT ?3) ORDER BY ts ASC, id ASC";
const PROBE_PREFIX: &str = "rs-bench-";

fn payload() -> String {
    // 1.4 KB of JSON-shaped text: the mean payload length in the real file.
    let filler = "the quick brown fox jumps over the lazy dog ".repeat(30);
    json!({ "kind": "text", "text": filler, "seq": 0 }).to_string()
}

fn percentile(sorted: &[u64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let i = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    sorted[i] as f64 / 1000.0
}

fn summarize(mut us: Vec<u64>) -> serde_json::Value {
    us.sort_unstable();
    json!({
        "n": us.len(), "p50_ms": percentile(&us, 0.50), "p99_ms": percentile(&us, 0.99),
        "max_ms": us.last().map_or(0.0, |v| *v as f64 / 1000.0),
    })
}

/// One connection, one implicit transaction per insert — the daemon today.
fn autocommit(path: &Path, sync: Synchronous, secs: f64) -> Result<serde_json::Value> {
    let conn = open_rw(path, sync)?;
    let body = payload();
    let mut stmt = conn.prepare(INSERT)?;
    let start = Instant::now();
    let mut n = 0u64;
    let mut lat = Vec::new();
    while start.elapsed().as_secs_f64() < secs {
        let t = Instant::now();
        stmt.execute(params![format!("{PROBE_PREFIX}auto"), n as i64, "text", body])?;
        lat.push(t.elapsed().as_micros() as u64);
        n += 1;
    }
    let rate = n as f64 / start.elapsed().as_secs_f64();
    Ok(json!({ "rows_per_s": rate.round(), "append": summarize(lat) }))
}

fn read_newest(conn: &Connection, worker: &str) -> rusqlite::Result<usize> {
    let mut stmt = conn.prepare_cached(NEWEST)?;
    let mut rows = stmt.query(params![worker, 0, 200])?;
    let mut bytes = 0;
    while let Some(r) = rows.next()? {
        bytes += r.get_ref(4)?.as_str_or_null()?.map_or(0, str::len);
    }
    Ok(bytes)
}

/// `producers` threads each append in a closed loop through the writer thread;
/// `readers` threads read the biggest worker's newest 200 events meanwhile.
fn group_commit(
    path: &Path,
    sync: Synchronous,
    producers: usize,
    readers: usize,
    linger: Duration,
    secs: f64,
    big_worker: &str,
) -> Result<serde_json::Value> {
    let db = Arc::new(Db::open(
        path,
        DbOptions { synchronous: sync, readers: readers.max(1), linger, ..Default::default() },
    )?);
    let stop = Arc::new(AtomicBool::new(false));
    let total = Arc::new(AtomicU64::new(0));
    let start = Instant::now();

    let writers: Vec<_> = (0..producers)
        .map(|p| {
            let (db, stop, total) = (db.clone(), stop.clone(), total.clone());
            let body = payload();
            thread::spawn(move || {
                let worker = format!("{PROBE_PREFIX}{p}");
                let mut lat = Vec::new();
                let mut i = 0i64;
                while !stop.load(Ordering::Relaxed) {
                    let (w, b) = (worker.clone(), body.clone());
                    let t = Instant::now();
                    let id = db
                        .write(move |c| {
                            c.prepare_cached(INSERT)?.execute(params![w, i, "text", b])?;
                            Ok(c.last_insert_rowid())
                        })
                        .expect("append");
                    assert!(id > 0);
                    lat.push(t.elapsed().as_micros() as u64);
                    i += 1;
                    total.fetch_add(1, Ordering::Relaxed);
                }
                lat
            })
        })
        .collect();

    let read_threads: Vec<_> = (0..readers)
        .map(|_| {
            let (db, stop) = (db.clone(), stop.clone());
            let worker = big_worker.to_owned();
            thread::spawn(move || {
                let mut lat = Vec::new();
                while !stop.load(Ordering::Relaxed) {
                    let w = worker.clone();
                    let t = Instant::now();
                    db.read(move |c| read_newest(c, &w)).expect("read");
                    lat.push(t.elapsed().as_micros() as u64);
                    thread::sleep(Duration::from_millis(2));
                }
                lat
            })
        })
        .collect();

    thread::sleep(Duration::from_secs_f64(secs));
    stop.store(true, Ordering::Relaxed);
    let elapsed = start.elapsed().as_secs_f64();
    let mut append_lat = Vec::new();
    for w in writers {
        append_lat.extend(w.join().expect("writer thread"));
    }
    let mut read_lat = Vec::new();
    for r in read_threads {
        read_lat.extend(r.join().expect("reader thread"));
    }
    let stats = Arc::into_inner(db).context("db still shared")?.close();
    Ok(json!({
        "rows_per_s": (total.load(Ordering::Relaxed) as f64 / elapsed).round(),
        "commits": stats.commits, "mean_batch": (stats.writes as f64 / stats.commits.max(1) as f64 * 10.0).round() / 10.0,
        "largest_batch": stats.largest_batch,
        "append": summarize(append_lat),
        "read_newest_200": summarize(read_lat),
    }))
}

fn idle_reads(path: &Path, big_worker: &str) -> Result<serde_json::Value> {
    let conn = open_ro(path)?;
    let mut lat = Vec::new();
    for _ in 0..500 {
        let t = Instant::now();
        read_newest(&conn, big_worker)?;
        lat.push(t.elapsed().as_micros() as u64);
    }
    Ok(summarize(lat))
}

fn snapshot(path: &Path) -> Result<serde_json::Value> {
    let dir = path.parent().context("no parent")?;
    let via_backup: PathBuf = dir.join("bench-backup.db");
    let via_clone: PathBuf = dir.join("bench-clone.db");
    let _ = std::fs::remove_file(&via_backup);
    let _ = std::fs::remove_file(&via_clone);

    let src = open_ro(path)?;
    let t = Instant::now();
    {
        let mut dst = Connection::open(&via_backup)?;
        let backup = rusqlite::backup::Backup::new(&src, &mut dst)?;
        backup.run_to_completion(4096, Duration::ZERO, None)?;
    }
    let backup_ms = t.elapsed().as_secs_f64() * 1000.0;

    // std::fs::copy uses clonefile on APFS; a clone shares blocks until written.
    let t = Instant::now();
    std::fs::copy(path, &via_clone)?;
    let clone_ms = t.elapsed().as_secs_f64() * 1000.0;

    let same = std::fs::metadata(&via_backup)?.len() == std::fs::metadata(path)?.len();
    std::fs::remove_file(&via_backup)?;
    std::fs::remove_file(&via_clone)?;
    Ok(
        json!({ "backup_api_ms": backup_ms.round(), "fs_copy_ms": (clone_ms * 100.0).round() / 100.0, "backup_same_size": same }),
    )
}

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let path = PathBuf::from(args.next().context("usage: statedb-bench <state.db copy> [seconds]")?);
    let secs: f64 = args.next().map(|s| s.parse()).transpose()?.unwrap_or(5.0);

    let big_worker: String = open_ro(&path)?.query_row(
        "SELECT worker_id FROM events GROUP BY worker_id ORDER BY count(*) DESC LIMIT 1",
        [],
        |r| r.get(0),
    )?;

    // Every run starts from its own APFS clone, so all of them see the same file.
    let scratch = path.with_file_name("bench-run.db");
    let fresh = || -> Result<()> {
        for ext in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{ext}", scratch.display()));
        }
        std::fs::copy(&path, &scratch)?;
        Ok(())
    };

    let mut out = serde_json::Map::new();
    out.insert("snapshot".into(), snapshot(&path)?);
    out.insert("read_idle".into(), idle_reads(&path, &big_worker)?);
    fresh()?;
    out.insert("autocommit_full (today)".into(), autocommit(&scratch, Synchronous::Full, secs)?);
    fresh()?;
    out.insert("autocommit_normal".into(), autocommit(&scratch, Synchronous::Normal, secs)?);
    for (name, sync) in [("full", Synchronous::Full), ("normal", Synchronous::Normal)] {
        for (producers, readers) in [(1usize, 0usize), (1, 4), (8, 4), (64, 4)] {
            fresh()?;
            let key = format!("group_{name}_{producers}p_{readers}r");
            out.insert(key, group_commit(&scratch, sync, producers, readers, Duration::ZERO, secs, &big_worker)?);
        }
    }
    fresh()?;
    out.insert(
        "group_normal_64p_4r_linger2ms".into(),
        group_commit(&scratch, Synchronous::Normal, 64, 4, Duration::from_millis(2), secs, &big_worker)?,
    );
    for ext in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{ext}", scratch.display()));
    }
    println!("{}", serde_json::to_string_pretty(&out)?);
    Ok(())
}
