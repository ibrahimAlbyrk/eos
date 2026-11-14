//! The migration runner: the TypeScript runner's contract on the same table.
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
mod own;

/// Every migration this app runs, in run order: the ones today's TypeScript app knows,
/// verbatim, then this app's own, which only add tables or indexes so the previous app
/// version can still open the file.
pub const EMBEDDED: &[Migration] = &ALL;

/// How many of [`EMBEDDED`] today's TypeScript app knows; the ones after are this app's own.
pub const TYPESCRIPT_MIGRATIONS: usize = embedded::EMBEDDED.len();

const ALL: [Migration; TYPESCRIPT_MIGRATIONS + own::OWN.len()] = concat(embedded::EMBEDDED, own::OWN);

const fn concat<const N: usize>(first: &[Migration], then: &[Migration]) -> [Migration; N] {
    let mut all = [Migration { id: "", sql: "" }; N];
    let mut i = 0;
    while i < N {
        all[i] = if i < first.len() { first[i] } else { then[i - first.len()] };
        i += 1;
    }
    all
}

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
        assert_eq!(TYPESCRIPT_MIGRATIONS, 64);
        assert_eq!(EMBEDDED[0].id, "001_init_workers");
        assert_eq!(EMBEDDED[63].id, "064_genui_views");
        assert_eq!(EMBEDDED[64].id, "065_idx_events_worker_type_id");
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
        assert_eq!(first.applied.len(), EMBEDDED.len());
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
        assert_eq!(ids(&conn).len(), EMBEDDED.len() + 3);
    }

    fn schema(conn: &Connection) -> Vec<(String, String, Option<String>)> {
        conn.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
            .and_then(|mut s| s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect())
            .expect("schema")
    }

    #[test]
    fn this_apps_own_migrations_only_add_tables_and_indexes() {
        let conn = mem();
        run(&conn, &EMBEDDED[..TYPESCRIPT_MIGRATIONS], 1).expect("typescript's");
        let before = schema(&conn);
        run(&conn, EMBEDDED, 2).expect("ours");
        let after = schema(&conn);
        for object in &before {
            assert!(after.contains(object), "{} {} changed", object.0, object.1);
        }
        let added: Vec<_> = after.iter().filter(|o| !before.contains(o)).collect();
        assert!(!added.is_empty());
        for (kind, name, _) in added {
            assert!(kind == "table" || kind == "index", "{kind} {name}");
        }
    }

    #[test]
    fn the_previous_app_opens_a_file_this_app_migrated() {
        let conn = mem();
        run(&conn, EMBEDDED, 1).expect("this app");
        let previous = run(&conn, &EMBEDDED[..TYPESCRIPT_MIGRATIONS], 2).expect("the previous app");
        assert!(previous.up_to_date());
        let own: Vec<&str> = EMBEDDED[TYPESCRIPT_MIGRATIONS..].iter().map(|m| m.id).collect();
        assert_eq!(previous.unknown, own);
        // Its writes keep the new index up to date by themselves.
        conn.execute_batch(
            "INSERT INTO events (worker_id, ts, type, payload) VALUES ('w', 1, 'user_message', '{}'), ('w', 2, 'state', NULL)",
        )
        .expect("write");
        let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).expect("check");
        assert_eq!(integrity, "ok");
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

    // Builds before 067 wrote the worker's own id into `workers.session_id`,
    // where the TypeScript app reads the Claude Code session it resumes a chat
    // by (`options.resume`: a UUID). Every resume, in either
    // app, logs the session it resumed in its `spawn` row.
    #[test]
    fn a_session_an_earlier_build_overwrote_is_put_back_from_the_log() {
        let conn = mem();
        let before_067 = EMBEDDED.len() - 1;
        assert_eq!(EMBEDDED[before_067].id, "067_engine_sessions");
        run(&conn, &EMBEDDED[..before_067], 1).expect("an earlier build");
        let (older, newer) = ("1d6c5b0e-2f43-4a8e-9c1d-5e7f8a9b0c12", "0b8f3c1e-7d2a-4c55-9a51-3e9d2f6a8b10");
        conn.execute_batch(&format!(
            "INSERT INTO workers (id, state, prompt, started_at, session_id) VALUES
               ('w-touched', 'SUSPENDED', 'p', 1, 'w-touched'),
               ('w-begun-here', 'SUSPENDED', 'p', 1, 'w-begun-here'),
               ('w-log-cut', 'DONE', 'p', 1, 'w-log-cut'),
               ('w-untouched', 'SUSPENDED', 'p', 1, '{older}'),
               ('w-never', 'DONE', 'p', 1, NULL);
             INSERT INTO events (worker_id, ts, type, payload) VALUES
               ('w-touched', 1, 'spawn', '{{\"pid\":7}}'),
               ('w-touched', 2, 'spawn', '{{\"resumed\":true,\"sessionId\":\"{older}\",\"pid\":8}}'),
               ('w-touched', 3, 'spawn', '{{\"resumed\":true,\"sessionId\":\"{newer}\",\"pid\":null}}'),
               ('w-touched', 4, 'spawn', '{{\"resumed\":true,\"sessionId\":\"w-touched\",\"pid\":null}}'),
               ('w-touched', 5, 'spawn', 'not json'),
               ('w-touched', 6, 'user_message', '{{\"sessionId\":\"{older}\"}}'),
               ('w-begun-here', 1, 'spawn', '{{\"pid\":null}}'),
               ('w-begun-here', 2, 'spawn', '{{\"resumed\":true,\"sessionId\":\"w-begun-here\",\"pid\":null}}');"
        ))
        .expect("rows");

        let report = run(&conn, EMBEDDED, 2).expect("this build");
        assert_eq!(report.applied, vec!["067_engine_sessions"]);
        let column = |id: &str| -> Option<String> {
            conn.query_row("SELECT session_id FROM workers WHERE id = ?1", [id], |r| r.get(0)).expect("the row")
        };
        assert_eq!(column("w-touched").as_deref(), Some(newer), "the session it had when this app took it");
        assert_eq!(column("w-begun-here"), None, "none the TypeScript app could resume");
        assert_eq!(column("w-log-cut"), None, "nothing in the log names it any more");
        assert_eq!(column("w-untouched").as_deref(), Some(older));
        assert_eq!(column("w-never"), None);
        let own: Vec<(String, String)> = conn
            .prepare("SELECT worker_id, session_id FROM engine_sessions ORDER BY worker_id")
            .and_then(|mut s| s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect())
            .expect("rows");
        let own: Vec<(&str, &str)> = own.iter().map(|(w, s)| (w.as_str(), s.as_str())).collect();
        assert_eq!(own, [("w-begun-here", "w-begun-here"), ("w-log-cut", "w-log-cut"), ("w-touched", "w-touched")]);
    }
}
