//! The migration runner: the TypeScript runner's contract
//! (`infra/src/persistence/MigrationRunner.ts`) on the same table.
//!
//! - `schema_migrations(id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`, ids only.
//! - A recorded id is skipped. Recorded ids this build does not know are left
//!   alone: the vacuum marker, and migrations an older or a newer build ran.
//! - "duplicate column" / "already exists" means the schema already has the
//!   change: the migration is recorded, as today.
//! - New here: each migration and its record commit together, so a failure
//!   leaves nothing half-applied.

use std::collections::HashSet;

use rusqlite::{Connection, params};

use crate::error::Error;

#[derive(Debug, Clone, Copy)]
pub struct Migration {
    pub id: &'static str,
    pub sql: &'static str,
}

macro_rules! embed {
    ($id:literal) => {
        Migration { id: $id, sql: include_str!(concat!("../../migrations/", $id, ".sql")) }
    };
}

mod embedded;

/// Every migration today's app knows, verbatim, in run order. New ones are
/// appended and only add tables, so the previous app version can still open the file.
pub const EMBEDDED: &[Migration] = embedded::EMBEDDED;

/// Reserved row the weekly vacuum keeps in the same table.
pub const VACUUM_MARKER: &str = "__vacuum_last_run";

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct MigrationReport {
    /// Ids whose SQL ran now.
    pub applied: Vec<&'static str>,
    /// Ids recorded because the schema already had the change.
    pub adopted: Vec<&'static str>,
    /// Recorded ids this build has no SQL for; ignored.
    pub unknown: Vec<String>,
}

impl MigrationReport {
    pub fn up_to_date(&self) -> bool {
        self.applied.is_empty() && self.adopted.is_empty()
    }
}

pub(crate) fn recorded_ids(conn: &Connection) -> rusqlite::Result<HashSet<String>> {
    let mut stmt = conn.prepare("SELECT id FROM schema_migrations")?;
    stmt.query_map([], |r| r.get(0))?.collect()
}

pub(crate) fn unknown_ids(recorded: &HashSet<String>, migrations: &[Migration]) -> Vec<String> {
    let known: HashSet<&str> = migrations.iter().map(|m| m.id).collect();
    let mut unknown: Vec<String> =
        recorded.iter().filter(|id| !known.contains(id.as_str()) && *id != VACUUM_MARKER).cloned().collect();
    unknown.sort();
    unknown
}

/// Applies what is not recorded yet, one transaction per migration.
pub fn run(conn: &Connection, migrations: &[Migration], now_ms: i64) -> Result<MigrationReport, Error> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
    )?;
    let recorded = recorded_ids(conn)?;
    let mut report = MigrationReport { unknown: unknown_ids(&recorded, migrations), ..MigrationReport::default() };

    for m in migrations.iter().filter(|m| !recorded.contains(m.id)) {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let ran = conn.execute_batch(m.sql);
        let outcome = match ran {
            Ok(()) => Ok(true),
            // The statements before the one that failed stay, as they do today.
            Err(e) if is_already_there(&e) => Ok(false),
            Err(e) => Err(e),
        };
        let recorded = outcome.and_then(|applied| {
            conn.execute("INSERT INTO schema_migrations (id, applied_at) VALUES (?1, ?2)", params![m.id, now_ms])?;
            conn.execute_batch("COMMIT")?;
            Ok(applied)
        });
        match recorded {
            Ok(true) => report.applied.push(m.id),
            Ok(false) => report.adopted.push(m.id),
            Err(source) => {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(Error::Migration { id: m.id.to_owned(), source });
            }
        }
    }
    Ok(report)
}

// The TypeScript runner tests the message with /duplicate column|already exists/i.
fn is_already_there(e: &rusqlite::Error) -> bool {
    let msg = e.to_string().to_ascii_lowercase();
    msg.contains("duplicate column") || msg.contains("already exists")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        Connection::open_in_memory().expect("in-memory database")
    }

    fn ids(conn: &Connection) -> Vec<String> {
        let mut all: Vec<String> = recorded_ids(conn).expect("ids").into_iter().collect();
        all.sort();
        all
    }

    #[test]
    fn every_typescript_migration_is_embedded_in_order() {
        assert_eq!(EMBEDDED.len(), 64);
        assert_eq!(EMBEDDED[0].id, "001_init_workers");
        assert_eq!(EMBEDDED[63].id, "064_genui_views");
        let listed: Vec<&str> = EMBEDDED.iter().map(|m| m.id).collect();
        let mut sorted = listed.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted, listed, "ids are unique and run in id order");

        let mut on_disk: Vec<String> = std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/migrations"))
            .expect("migrations dir")
            .filter_map(|e| e.ok()?.file_name().to_str()?.strip_suffix(".sql").map(str::to_owned))
            .collect();
        on_disk.sort();
        assert_eq!(on_disk, listed, "the list and the folder agree");
    }

    #[test]
    fn a_fresh_file_takes_every_migration_and_a_second_run_does_nothing() {
        let conn = mem();
        let first = run(&conn, EMBEDDED, 1).expect("first run");
        assert_eq!(first.applied.len(), 64);
        assert!(first.adopted.is_empty() && first.unknown.is_empty());
        let second = run(&conn, EMBEDDED, 2).expect("second run");
        assert!(second.up_to_date());
        assert_eq!(second, MigrationReport::default());
    }

    #[test]
    fn ids_this_build_does_not_know_are_left_alone() {
        let conn = mem();
        run(&conn, EMBEDDED, 1).expect("run");
        conn.execute_batch(
            "INSERT INTO schema_migrations VALUES ('050_workflows', 1), ('999_from_the_future', 1), ('__vacuum_last_run', 5)",
        )
        .expect("insert");
        let report = run(&conn, EMBEDDED, 2).expect("run");
        assert!(report.up_to_date());
        assert_eq!(report.unknown, vec!["050_workflows", "999_from_the_future"]);
        assert_eq!(ids(&conn).len(), 67);
    }

    #[test]
    fn a_change_the_schema_already_has_is_recorded_not_fatal() {
        let conn = mem();
        run(&conn, EMBEDDED, 1).expect("run");
        conn.execute("DELETE FROM schema_migrations WHERE id = '003_workers_add_model'", []).expect("delete");
        let report = run(&conn, EMBEDDED, 2).expect("run");
        assert_eq!(report.adopted, vec!["003_workers_add_model"]);
        assert!(run(&conn, EMBEDDED, 3).expect("run").up_to_date());
    }

    #[test]
    fn statements_before_an_already_there_error_are_kept() {
        let conn = mem();
        conn.execute_batch("CREATE TABLE b (x)").expect("b");
        let two = [Migration { id: "001_two", sql: "CREATE TABLE a (x); CREATE TABLE b (x); CREATE TABLE c (x)" }];
        let report = run(&conn, &two, 1).expect("run");
        assert_eq!(report.adopted, vec!["001_two"]);
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE name IN ('a', 'c') ORDER BY name")
            .and_then(|mut s| s.query_map([], |r| r.get(0))?.collect())
            .expect("tables");
        assert_eq!(tables, vec!["a"], "exec stops at the failing statement, as node:sqlite's does");
    }

    #[test]
    fn any_other_failure_stops_the_run_and_keeps_nothing_of_that_migration() {
        let conn = mem();
        let bad = [
            Migration { id: "001_ok", sql: "CREATE TABLE a (x)" },
            Migration { id: "002_bad", sql: "CREATE TABLE half (x); ALTER TABLE nowhere ADD COLUMN x" },
            Migration { id: "003_never", sql: "CREATE TABLE c (x)" },
        ];
        let err = run(&conn, &bad, 1).expect_err("fails");
        assert!(matches!(&err, Error::Migration { id, .. } if id == "002_bad"), "{err}");
        assert_eq!(ids(&conn), vec!["001_ok"]);
        let half: bool = conn
            .query_row("SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE name = 'half')", [], |r| r.get(0))
            .expect("query");
        assert!(!half, "the failed migration was rolled back whole");
        assert!(conn.is_autocommit());
    }
}
