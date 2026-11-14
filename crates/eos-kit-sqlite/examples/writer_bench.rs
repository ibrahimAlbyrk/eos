//! Throughput of the write path. Not a test: run it on a quiet machine.
//!
//!   cargo run --release -p eos-kit-sqlite --example writer_bench [state.db to copy]
//!
//! With a path, the file is copied first (a clone on APFS) and never touched.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use eos_kit_sqlite::rusqlite::{Connection, params};
use eos_kit_sqlite::{Db, Error, Options, Synchronous, database_files};

const PAYLOAD_BYTES: usize = 1400;
const RUN: Duration = Duration::from_secs(3);

fn append(conn: &Connection, worker: &str, payload: &str) -> Result<i64, Error> {
    conn.prepare_cached("INSERT INTO events (worker_id, ts, type, payload) VALUES (?1, ?2, 'text', ?3)")?
        .execute(params![worker, 1, payload])?;
    Ok(conn.last_insert_rowid())
}

fn percentile(sorted: &[Duration], p: f64) -> Duration {
    sorted.get(((sorted.len() as f64 - 1.0) * p) as usize).copied().unwrap_or_default()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let source = std::env::args_os().nth(1).map(PathBuf::from);
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("state.db");
    if let Some(source) = &source {
        let started = Instant::now();
        for (from, to) in database_files(source).iter().zip(database_files(&path)) {
            if from.exists() {
                std::fs::copy(from, to)?;
            }
        }
        println!("snapshot copy: {:.1} ms", started.elapsed().as_secs_f64() * 1000.0);
    }
    let payload: Arc<str> = "x".repeat(PAYLOAD_BYTES).into();

    for synchronous in [Synchronous::Full, Synchronous::Normal] {
        for producers in [1usize, 8, 64] {
            let started = Instant::now();
            let (db, report) = Db::open(&path, Options { synchronous, ..Options::default() }, 1)?;
            let first: i64 =
                db.read(|c| Ok::<_, Error>(c.query_row("SELECT count(*) FROM workers", [], |r| r.get(0))?))?;
            let open = started.elapsed();
            let db = Arc::new(db);

            let stop = Arc::new(AtomicBool::new(false));
            let writers: Vec<_> = (0..producers)
                .map(|t| {
                    let (db, stop, payload) = (db.clone(), stop.clone(), payload.clone());
                    thread::spawn(move || {
                        let worker = format!("bench-{t}");
                        let mut latencies = Vec::new();
                        while !stop.load(Ordering::Relaxed) {
                            let (worker, payload) = (worker.clone(), payload.clone());
                            let at = Instant::now();
                            if db.write(move |c| append(c, &worker, &payload)).is_err() {
                                break;
                            }
                            latencies.push(at.elapsed());
                        }
                        latencies
                    })
                })
                .collect();
            // Reads on a read-only connection while the appends run flat out.
            let reader = {
                let (db, stop) = (db.clone(), stop.clone());
                thread::spawn(move || {
                    let mut latencies = Vec::new();
                    while !stop.load(Ordering::Relaxed) {
                        let at = Instant::now();
                        let read: Result<usize, Error> = db.read(|c| {
                            let mut stmt = c.prepare_cached(
                                "SELECT id, payload FROM events WHERE worker_id = 'bench-0' ORDER BY id DESC LIMIT 200",
                            )?;
                            let rows = stmt.query_map([], |r| r.get::<_, String>(1))?.count();
                            Ok(rows)
                        });
                        if read.is_err() {
                            break;
                        }
                        latencies.push(at.elapsed());
                        thread::sleep(Duration::from_millis(2));
                    }
                    latencies
                })
            };
            thread::sleep(RUN);
            stop.store(true, Ordering::Relaxed);
            let mut writes: Vec<Duration> = Vec::new();
            for w in writers {
                writes.extend(w.join().map_err(|_| "writer panicked")?);
            }
            let mut reads = reader.join().map_err(|_| "reader panicked")?;
            writes.sort_unstable();
            reads.sort_unstable();
            let stats = Arc::into_inner(db).ok_or("database still shared")?.close();
            println!(
                "{synchronous:?} · {producers:>2} producers: {:>6.0} rows/s · mean batch {:>5.1} · append p50 {:>6.0} µs p99 {:>6.0} µs · \
                 read p50 {:>5.0} µs p99 {:>6.0} µs · open+first read {:.1} ms ({} workers, {} applied)",
                writes.len() as f64 / RUN.as_secs_f64(),
                stats.writes as f64 / stats.commits.max(1) as f64,
                percentile(&writes, 0.5).as_secs_f64() * 1e6,
                percentile(&writes, 0.99).as_secs_f64() * 1e6,
                percentile(&reads, 0.5).as_secs_f64() * 1e6,
                percentile(&reads, 0.99).as_secs_f64() * 1e6,
                open.as_secs_f64() * 1000.0,
                first,
                report.applied.len(),
            );
        }
    }
    Ok(())
}
