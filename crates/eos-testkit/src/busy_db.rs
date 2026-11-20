//! The app's database open and busy in this process, for tests that hold
//! Eos's own code to never opening the database's files outside SQLite.
//!
//! A plain handle on one of those files, closed anywhere in the process,
//! drops SQLite's locks on it; the next other program that opens the
//! database then rebuilds the shared-memory index under the app's mapped
//! copy, and the process dies of a bus error. So a test opens a
//! [`BusyDatabase`], runs the path under test, then calls
//! [`another_program_opens`](BusyDatabase::another_program_opens) and
//! [`finish`](BusyDatabase::finish): the test process survives and the
//! app's connections keep working only while the path left the files alone.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;

use eos_kit_sqlite::rusqlite::params;
use eos_kit_sqlite::{Db, Error, Options};

/// Where macOS keeps its own `sqlite3`.
const SQLITE3: &str = "/usr/bin/sqlite3";

/// `state.db` in a folder of the test's, opened as the app opens it, its
/// writer and eight readers busy until [`finish`](Self::finish).
pub struct BusyDatabase {
    db: Arc<Db>,
    stop: Arc<AtomicBool>,
    threads: Vec<JoinHandle<()>>,
}

impl std::fmt::Debug for BusyDatabase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BusyDatabase").field("path", &self.db.path()).finish_non_exhaustive()
    }
}

fn append(db: &Db, payload: &'static str) {
    db.write(move |c| {
        c.prepare_cached("INSERT INTO events (worker_id, ts, type, payload) VALUES ('w', 1, 'text', ?1)")?
            .execute(params![payload])?;
        Ok::<_, Error>(())
    })
    .expect("the app writes");
}

fn count(db: &Db) -> i64 {
    db.read(|c| Ok::<_, Error>(c.query_row("SELECT count(*) FROM events", [], |r| r.get(0))?)).expect("the app reads")
}

impl BusyDatabase {
    /// Opens `<dir>/state.db` and sets its connections to work.
    pub fn open(dir: &Path) -> Self {
        let (db, _) = Db::open(dir.join("state.db"), Options { readers: 8, ..Options::default() }, 1).expect("open");
        let db = Arc::new(db);
        append(&db, "first");
        let stop = Arc::new(AtomicBool::new(false));
        let threads = (0..9)
            .map(|i| {
                let (db, stop) = (db.clone(), stop.clone());
                std::thread::spawn(move || {
                    while !stop.load(Ordering::Relaxed) {
                        if i == 0 {
                            append(&db, "row");
                        } else {
                            count(&db);
                        }
                    }
                })
            })
            .collect();
        Self { db, stop, threads }
    }

    /// Opens the database from another process again and again, read-only
    /// and read-write; each must read or be told the file is busy. Does
    /// nothing where there is no `sqlite3`.
    pub fn another_program_opens(&self) {
        if !Path::new(SQLITE3).exists() {
            eprintln!("no sqlite3 command: the other program was not run");
            return;
        }
        let path = self.db.path().to_string_lossy().into_owned();
        let uri = format!("file:{path}?mode=ro");
        for target in [uri.as_str(), path.as_str()].iter().cycle().take(20) {
            let out = std::process::Command::new(SQLITE3)
                .args([*target, "SELECT count(*) FROM events;"])
                .output()
                .expect("sqlite3 runs");
            let (stdout, stderr) = (String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
            let read = out.status.success() && stdout.trim().parse::<i64>().is_ok();
            assert!(read || stderr.contains("locked") || stderr.contains("busy"), "{stdout}{stderr}");
        }
    }

    /// Stops the busy connections; each must have kept working, and the
    /// writer and a reader still do.
    pub fn finish(self) {
        self.stop.store(true, Ordering::Relaxed);
        for thread in self.threads {
            thread.join().expect("the app's connections kept working");
        }
        append(&self.db, "after");
        assert!(count(&self.db) > 1);
    }
}
