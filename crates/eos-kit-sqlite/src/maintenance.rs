//! Handing freed pages back to the filesystem.
//!
//! SQLite never shrinks the file after a delete wave. A file with
//! `auto_vacuum = INCREMENTAL` is shrunk in slices, each its own job on the
//! writer, so other writes run between them; a file created before that
//! setting gets it from one full VACUUM. The last run is remembered in
//! `schema_migrations` under a reserved id, so it survives restarts.

use rusqlite::{Connection, OptionalExtension};

use crate::db::Db;
use crate::error::Error;
use crate::migrate::VACUUM_MARKER;

pub const VACUUM_INTERVAL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// About 14 µs a page on a 190 MB file, so a slice holds the writer a few ms.
pub const VACUUM_SLICE_PAGES: u32 = 512;
const AUTO_VACUUM_INCREMENTAL: i64 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VacuumOutcome {
    /// A worker is live; nothing was done.
    WorkersLive,
    /// The last run is younger than a week; nothing was done.
    NotDue,
    /// Freed pages were returned in this many slices.
    Incremental { slices: u32 },
    /// The file was switched to incremental with one full VACUUM.
    Full,
}

fn pragma(conn: &Connection, name: &str) -> rusqlite::Result<i64> {
    conn.pragma_query_value(None, name, |r| r.get(0))
}

enum Plan {
    Skip(VacuumOutcome),
    Incremental,
    Full,
}

impl Db {
    /// Runs the weekly vacuum when it is due and no worker is live. Blocks
    /// until done; other writes keep running between the slices.
    pub fn maybe_vacuum(&self, now_ms: i64) -> Result<VacuumOutcome, Error> {
        let plan = self.maintain(move |conn| -> Result<Plan, Error> {
            let live: i64 = conn.query_row(
                "SELECT COUNT(*) FROM workers WHERE state NOT IN ('DONE','KILLING','SUSPENDED')",
                [],
                |r| r.get(0),
            )?;
            if live > 0 {
                return Ok(Plan::Skip(VacuumOutcome::WorkersLive));
            }
            let last: Option<i64> = conn
                .query_row("SELECT applied_at FROM schema_migrations WHERE id = ?1", [VACUUM_MARKER], |r| r.get(0))
                .optional()?;
            if last.is_some_and(|at| now_ms - at < VACUUM_INTERVAL_MS) {
                return Ok(Plan::Skip(VacuumOutcome::NotDue));
            }
            Ok(if pragma(conn, "auto_vacuum")? == AUTO_VACUUM_INCREMENTAL { Plan::Incremental } else { Plan::Full })
        })?;

        let outcome = match plan {
            Plan::Skip(outcome) => return Ok(outcome),
            Plan::Incremental => {
                let mut slices = 0;
                while self.maintain(vacuum_slice)? > 0 {
                    slices += 1;
                }
                VacuumOutcome::Incremental { slices }
            }
            Plan::Full => {
                self.maintain(|conn| -> Result<(), Error> {
                    conn.pragma_update(None, "auto_vacuum", "INCREMENTAL")?;
                    conn.execute_batch("VACUUM")?;
                    Ok(())
                })?;
                VacuumOutcome::Full
            }
        };
        self.write(move |conn| -> Result<(), Error> {
            conn.execute(
                "INSERT INTO schema_migrations (id, applied_at) VALUES (?1, ?2)
                 ON CONFLICT(id) DO UPDATE SET applied_at = excluded.applied_at",
                rusqlite::params![VACUUM_MARKER, now_ms],
            )?;
            Ok(())
        })?;
        Ok(outcome)
    }
}

/// Frees one slice and returns how many free pages it found before doing so.
fn vacuum_slice(conn: &Connection) -> Result<i64, Error> {
    let free = pragma(conn, "freelist_count")?;
    if free > 0 {
        // The pragma frees pages as it is stepped: run it to the end.
        let mut stmt = conn.prepare(&format!("PRAGMA incremental_vacuum({VACUUM_SLICE_PAGES})"))?;
        let mut rows = stmt.query([])?;
        while rows.next()?.is_some() {}
    }
    Ok(free)
}
