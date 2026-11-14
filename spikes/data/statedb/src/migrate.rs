//! The migration runner. Same table, same ids, same rules as the TypeScript one:
//! - `schema_migrations(id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`
//! - an id that is recorded is skipped; ids the code does not know are ignored
//!   (the vacuum marker, migrations a newer or older build recorded)
//! - "duplicate column" / "already exists" records the migration as applied.

use std::collections::HashSet;

use rusqlite::{Connection, params};

#[derive(Debug, Clone, Copy)]
pub struct Migration {
    pub id: &'static str,
    pub sql: &'static str,
}

include!(concat!(env!("OUT_DIR"), "/migrations.rs"));

/// Reserved row the weekly vacuum keeps in the same table.
pub const VACUUM_MARKER: &str = "__vacuum_last_run";

#[derive(Debug, Default, PartialEq, Eq)]
pub struct MigrationReport {
    /// Ids whose SQL ran now.
    pub applied: Vec<String>,
    /// Ids recorded without effect: the schema already had the change.
    pub adopted: Vec<String>,
    /// Recorded ids this build has no SQL for.
    pub unknown: Vec<String>,
}

pub fn recorded_ids(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
    )?;
    let mut stmt = conn.prepare("SELECT id FROM schema_migrations ORDER BY id")?;
    stmt.query_map([], |r| r.get(0))?.collect()
}

/// What `run` would do, without writing (the table must exist).
pub fn pending<'a>(conn: &Connection, migrations: &'a [Migration]) -> rusqlite::Result<Vec<&'a str>> {
    let mut stmt = conn.prepare("SELECT id FROM schema_migrations")?;
    let recorded: HashSet<String> = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
    Ok(migrations.iter().map(|m| m.id).filter(|id| !recorded.contains(*id)).collect())
}

pub fn run(conn: &Connection, migrations: &[Migration], now_ms: i64) -> rusqlite::Result<MigrationReport> {
    let recorded: HashSet<String> = recorded_ids(conn)?.into_iter().collect();
    let known: HashSet<&str> = migrations.iter().map(|m| m.id).collect();
    let mut unknown: Vec<String> =
        recorded.iter().filter(|id| !known.contains(id.as_str()) && *id != VACUUM_MARKER).cloned().collect();
    unknown.sort();
    let mut report = MigrationReport { unknown, ..MigrationReport::default() };

    for m in migrations {
        if recorded.contains(m.id) {
            continue;
        }
        match conn.execute_batch(m.sql) {
            Ok(()) => report.applied.push(m.id.to_owned()),
            Err(e) if is_already_there(&e) => report.adopted.push(m.id.to_owned()),
            Err(e) => return Err(e),
        }
        conn.execute("INSERT INTO schema_migrations (id, applied_at) VALUES (?1, ?2)", params![m.id, now_ms])?;
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
        Connection::open_in_memory().unwrap()
    }

    #[test]
    fn the_ts_migrations_are_all_here_in_order() {
        assert_eq!(MIGRATIONS.len(), 64);
        assert_eq!(MIGRATIONS[0].id, "001_init_workers");
        assert_eq!(MIGRATIONS[63].id, "064_genui_views");
        let mut sorted: Vec<_> = MIGRATIONS.iter().map(|m| m.id).collect();
        sorted.sort();
        assert_eq!(sorted, MIGRATIONS.iter().map(|m| m.id).collect::<Vec<_>>());
    }

    #[test]
    fn a_fresh_file_takes_every_migration_and_a_second_run_does_nothing() {
        let conn = mem();
        let first = run(&conn, MIGRATIONS, 1).unwrap();
        assert_eq!(first.applied.len(), 64);
        assert!(first.adopted.is_empty() && first.unknown.is_empty());
        assert_eq!(run(&conn, MIGRATIONS, 2).unwrap(), MigrationReport::default());
    }

    #[test]
    fn ids_this_build_does_not_know_are_left_alone() {
        let conn = mem();
        run(&conn, MIGRATIONS, 1).unwrap();
        conn.execute_batch(
            "INSERT INTO schema_migrations VALUES ('050_workflows', 1), ('999_from_the_future', 1), ('__vacuum_last_run', 5)",
        )
        .unwrap();
        let report = run(&conn, MIGRATIONS, 2).unwrap();
        assert!(report.applied.is_empty());
        assert_eq!(report.unknown, vec!["050_workflows", "999_from_the_future"]);
    }

    #[test]
    fn a_change_the_schema_already_has_is_recorded_not_fatal() {
        let conn = mem();
        run(&conn, MIGRATIONS, 1).unwrap();
        conn.execute("DELETE FROM schema_migrations WHERE id = '003_workers_add_model'", []).unwrap();
        let report = run(&conn, MIGRATIONS, 2).unwrap();
        assert_eq!(report.adopted, vec!["003_workers_add_model"]);
        assert!(pending(&conn, MIGRATIONS).unwrap().is_empty());
    }

    #[test]
    fn any_other_failure_stops_the_run() {
        let conn = mem();
        let bad = [Migration { id: "001_bad", sql: "ALTER TABLE nowhere ADD COLUMN x" }];
        assert!(run(&conn, &bad, 1).is_err());
        assert!(recorded_ids(&conn).unwrap().is_empty());
    }
}
