//! Opening connections the way the app expects them, and what a caller needs
//! to know before the first open.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

use crate::error::Error;
use crate::migrate::{self, Migration};

/// `PRAGMA synchronous`. `Full` is SQLite's default and what the file has always run with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Synchronous {
    Normal,
    #[default]
    Full,
}

const STATEMENT_CACHE: usize = 128;

/// The read-write connection, set up as `manager/container.ts` sets it up:
/// a file with no pages yet is made `auto_vacuum = INCREMENTAL` (it only takes
/// that before the first page exists), then WAL. `busy_timeout` is new: there
/// is now more than one connection.
pub fn open_read_write(path: &Path, synchronous: Synchronous, busy_timeout: Duration) -> Result<Connection, Error> {
    let conn = Connection::open(path)?;
    conn.busy_timeout(busy_timeout)?;
    let pages: i64 = conn.pragma_query_value(None, "page_count", |r| r.get(0))?;
    if pages == 0 {
        conn.pragma_update(None, "auto_vacuum", "INCREMENTAL")?;
    }
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", if synchronous == Synchronous::Full { "FULL" } else { "NORMAL" })?;
    conn.set_prepared_statement_cache_capacity(STATEMENT_CACHE);
    Ok(conn)
}

/// A connection that cannot write.
pub fn open_read_only(path: &Path, busy_timeout: Duration) -> Result<Connection, Error> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    conn.busy_timeout(busy_timeout)?;
    conn.pragma_update(None, "query_only", true)?;
    conn.set_prepared_statement_cache_capacity(STATEMENT_CACHE);
    Ok(conn)
}

/// The files that together are the database: copy all three for a snapshot.
pub fn database_files(path: &Path) -> [PathBuf; 3] {
    let with = |suffix: &str| {
        let mut name = path.as_os_str().to_owned();
        name.push(suffix);
        PathBuf::from(name)
    };
    [path.to_owned(), with("-wal"), with("-shm")]
}

/// What opening would do to a file, found without writing to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Preflight {
    /// The file is there (a missing file is created by the open).
    pub exists: bool,
    /// Migrations the open will apply, in order. Empty means "up to date".
    pub pending: Vec<&'static str>,
    /// Recorded ids this build has no SQL for (older or newer builds left them); they are ignored.
    pub unknown: Vec<String>,
}

impl Preflight {
    pub fn up_to_date(&self) -> bool {
        self.exists && self.pending.is_empty()
    }
}

/// Reads `schema_migrations` through a read-only connection.
pub fn preflight(path: &Path, migrations: &'static [Migration]) -> Result<Preflight, Error> {
    let all = || migrations.iter().map(|m| m.id).collect();
    if !path.exists() {
        return Ok(Preflight { exists: false, pending: all(), unknown: Vec::new() });
    }
    let conn = open_read_only(path, Duration::from_secs(5))?;
    let has_table: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations')",
        [],
        |r| r.get(0),
    )?;
    if !has_table {
        return Ok(Preflight { exists: true, pending: all(), unknown: Vec::new() });
    }
    let recorded: HashSet<String> = migrate::recorded_ids(&conn)?;
    Ok(Preflight {
        exists: true,
        pending: migrations.iter().map(|m| m.id).filter(|id| !recorded.contains(*id)).collect(),
        unknown: migrate::unknown_ids(&recorded, migrations),
    })
}
