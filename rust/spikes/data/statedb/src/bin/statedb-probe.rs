//! Reads a `state.db` copy and prints what the Rust side sees: SQLite versions,
//! pragmas, migration state against the TypeScript ids, row counts (counts only)
//! and how the schema compares to one built from the 64 migrations.
//!
//!   statedb-probe <state.db>            read-only report (JSON)
//!   statedb-probe <state.db> --add-065  apply one additive migration (on YOUR copy)

use std::{
    collections::BTreeMap,
    fs::File,
    io::Read,
    path::Path,
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use rusqlite::Connection;
use serde_json::{Value, json};
use spike_statedb::{
    db::{Synchronous, open_ro, open_rw},
    migrate::{MIGRATIONS, Migration, pending, recorded_ids, run},
};

const SPIKE_065: Migration = Migration {
    id: "065_rs_spike_probe",
    sql: "CREATE TABLE IF NOT EXISTS rs_spike_probe (id TEXT PRIMARY KEY, data TEXT NOT NULL);
          ALTER TABLE workers ADD COLUMN rs_spike_probe TEXT;
          ALTER TABLE events ADD COLUMN rs_spike_probe INTEGER;",
};

fn ms(d: Duration) -> f64 {
    (d.as_secs_f64() * 1e5).round() / 100.0
}

fn pragma(conn: &Connection, name: &str) -> Value {
    conn.query_row(&format!("PRAGMA {name}"), [], |r| r.get::<_, rusqlite::types::Value>(0))
        .map(|v| match v {
            rusqlite::types::Value::Integer(i) => json!(i),
            rusqlite::types::Value::Text(t) => json!(t),
            other => json!(format!("{other:?}")),
        })
        .unwrap_or(Value::Null)
}

/// (type, name) → normalized SQL of every schema object.
fn schema(conn: &Connection) -> Result<BTreeMap<(String, String), String>> {
    let mut stmt =
        conn.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")?;
    let rows = stmt.query_map([], |r| Ok(((r.get(0)?, r.get(1)?), r.get::<_, String>(2)?)))?;
    let mut out = BTreeMap::new();
    for row in rows {
        let (key, sql) = row?;
        out.insert(key, sql.split_whitespace().collect::<Vec<_>>().join(" "));
    }
    Ok(out)
}

fn header(path: &Path) -> Result<Value> {
    let mut buf = [0u8; 100];
    File::open(path)?.read_exact(&mut buf)?;
    let be32 = |o: usize| u32::from_be_bytes([buf[o], buf[o + 1], buf[o + 2], buf[o + 3]]);
    let v = be32(96);
    Ok(json!({
        "writeFormat": buf[18], "readFormat": buf[19],
        "schemaFormat": be32(44), "textEncoding": be32(56),
        "lastWriterSqlite": format!("{}.{}.{}", v / 1_000_000, v / 1000 % 1000, v % 1000),
    }))
}

fn path_arg_tail() -> Vec<String> {
    std::env::args().skip(2).collect()
}

fn args_has_payloads(tail: &[String]) -> bool {
    tail.iter().any(|a| a == "--payloads")
}

/// Every stored event payload must be JSON that serde_json accepts: the plan
/// hands payloads through as raw JSON, and JavaScript can write things Rust's
/// parser refuses (a lone surrogate escape, for one).
fn payloads(path: &Path) -> Result<()> {
    let conn = open_ro(path)?;
    let t = Instant::now();
    let mut stmt = conn.prepare("SELECT payload FROM events")?;
    let mut rows = stmt.query([])?;
    let (mut n, mut nulls, mut bytes, mut rejected, mut surrogate_escapes, mut not_utf8) =
        (0u64, 0u64, 0u64, 0u64, 0u64, 0u64);
    let mut reasons: BTreeMap<String, u64> = BTreeMap::new();
    while let Some(row) = rows.next()? {
        n += 1;
        let raw = match row.get_ref(0)? {
            rusqlite::types::ValueRef::Null => {
                nulls += 1;
                continue;
            }
            rusqlite::types::ValueRef::Text(t) => t,
            _ => {
                rejected += 1;
                continue;
            }
        };
        bytes += raw.len() as u64;
        if std::str::from_utf8(raw).is_err() {
            not_utf8 += 1;
        }
        if raw.windows(4).any(|w| w == b"\\ud8" || w == b"\\ud9" || w == b"\\uda" || w == b"\\udb") {
            surrogate_escapes += 1;
        }
        if let Err(e) = serde_json::from_slice::<serde::de::IgnoredAny>(raw) {
            rejected += 1;
            // The category only: never a piece of the payload.
            let text = e.to_string();
            let reason = text.split(" at line").next().unwrap_or("").to_owned();
            *reasons.entry(reason).or_default() += 1;
        }
    }
    println!(
        "{}",
        json!({
            "events": n, "nullPayloads": nulls, "payloadBytes": bytes, "notUtf8": not_utf8,
            "withSurrogateEscapes": surrogate_escapes, "rejectedBySerdeJson": rejected, "rejectionReasons": reasons,
            "scanMs": ms(t.elapsed()),
        })
    );
    Ok(())
}

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let path = args.next().context("usage: statedb-probe <state.db> [--add-065]")?;
    let path = Path::new(&path);
    let add = args.next().as_deref() == Some("--add-065");

    if args_has_payloads(&path_arg_tail()) {
        return payloads(path);
    }
    if add {
        let conn = open_rw(path, Synchronous::Normal)?;
        let mut all = MIGRATIONS.to_vec();
        all.push(SPIKE_065);
        let report = run(&conn, &all, 1_800_000_000_000)?;
        println!("{}", json!({ "applied": report.applied, "adopted": report.adopted, "unknown": report.unknown }));
        return Ok(());
    }

    let t0 = Instant::now();
    let conn = open_ro(path)?;
    let n_recorded: i64 = conn.query_row("SELECT count(*) FROM schema_migrations", [], |r| r.get(0))?;
    let open_first_query = t0.elapsed();

    let t = Instant::now();
    let pend = pending(&conn, MIGRATIONS)?;
    let migration_check = t.elapsed();
    let recorded = {
        let mut stmt = conn.prepare("SELECT id FROM schema_migrations ORDER BY id")?;
        stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?
    };
    let known: Vec<&str> = MIGRATIONS.iter().map(|m| m.id).collect();
    let unknown: Vec<&String> = recorded.iter().filter(|id| !known.contains(&id.as_str())).collect();

    let t = Instant::now();
    let workers: i64 =
        conn.query_row("SELECT count(*) FROM (SELECT * FROM workers ORDER BY started_at DESC)", [], |r| r.get(0))?;
    let list_workers = t.elapsed();

    let biggest: Option<(String, i64)> = conn
        .query_row("SELECT worker_id, count(*) n FROM events GROUP BY worker_id ORDER BY n DESC LIMIT 1", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .ok();
    let mut recent_events = Duration::ZERO;
    if let Some((worker, _)) = &biggest {
        let t = Instant::now();
        let mut stmt = conn.prepare(
            "SELECT * FROM (SELECT * FROM events WHERE worker_id = ?1 AND ts > ?2 ORDER BY ts DESC, id DESC LIMIT ?3) ORDER BY ts ASC, id ASC",
        )?;
        let mut rows = stmt.query(rusqlite::params![worker, 0, 200])?;
        let mut bytes = 0usize;
        while let Some(r) = rows.next()? {
            bytes += r.get_ref(4)?.as_str_or_null()?.map_or(0, str::len);
        }
        std::hint::black_box(bytes);
        recent_events = t.elapsed();
    }

    let mut tables = BTreeMap::new();
    let names: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    for name in &names {
        let n: i64 = conn.query_row(&format!("SELECT count(*) FROM \"{name}\""), [], |r| r.get(0))?;
        tables.insert(name.clone(), n);
    }

    let t = Instant::now();
    let quick: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    let quick_check = t.elapsed();

    // The same schema built by rusqlite from the 64 migrations.
    let fresh = Connection::open_in_memory()?;
    run(&fresh, MIGRATIONS, 0)?;
    let (theirs, ours) = (schema(&conn)?, schema(&fresh)?);
    let differs: Vec<String> =
        ours.iter().filter(|(k, sql)| theirs.get(*k) != Some(*sql)).map(|((t, n), _)| format!("{t} {n}")).collect();
    let extra: Vec<String> =
        theirs.keys().filter(|k| !ours.contains_key(*k)).map(|(t, n)| format!("{t} {n}")).collect();

    let all_sql = theirs.values().cloned().collect::<Vec<_>>().join("\n").to_ascii_uppercase();
    let uses = |needle: &str| all_sql.contains(needle);
    let options: Vec<String> =
        fresh.prepare("PRAGMA compile_options")?.query_map([], |r| r.get::<_, String>(0))?.collect::<Result<_, _>>()?;

    let report = json!({
        "file": { "bytes": std::fs::metadata(path)?.len(), "header": header(path)? },
        "rusqlite": {
            "sqlite": rusqlite::version(),
            "sourceId": fresh.query_row("SELECT sqlite_source_id()", [], |r| r.get::<_, String>(0))?,
            "compileOptions": options,
        },
        "pragmas": {
            "journal_mode": pragma(&conn, "journal_mode"), "page_size": pragma(&conn, "page_size"),
            "page_count": pragma(&conn, "page_count"), "freelist_count": pragma(&conn, "freelist_count"),
            "auto_vacuum": pragma(&conn, "auto_vacuum"), "encoding": pragma(&conn, "encoding"),
            "user_version": pragma(&conn, "user_version"), "application_id": pragma(&conn, "application_id"),
            "foreign_keys": pragma(&conn, "foreign_keys"), "synchronous(default of a new connection)": pragma(&conn, "synchronous"),
        },
        "migrations": {
            "recordedRows": n_recorded, "knownToCode": known.len(), "pending": pend, "recordedButUnknown": unknown,
        },
        "schemaVsFreshBuild": { "objectsThatDiffer": differs, "objectsOnlyInTheFile": extra, "objectsInFresh": ours.len() },
        "schemaFeatures": {
            "AUTOINCREMENT": uses("AUTOINCREMENT"), "WITHOUT ROWID": uses("WITHOUT ROWID"), "STRICT": uses(") STRICT"),
            "GENERATED": uses("GENERATED ALWAYS"), "VIRTUAL TABLE": uses("VIRTUAL TABLE"), "TRIGGER": uses("CREATE TRIGGER"),
            "partial index": uses(") WHERE "), "FOREIGN KEY": uses("REFERENCES"), "CHECK": uses("CHECK"),
        },
        "tables": tables,
        "biggestWorkerEvents": biggest.map(|(_, n)| n),
        "timingsMs": {
            "open+pragmas+firstQuery": ms(open_first_query), "migrationCheck": ms(migration_check),
            "listAllWorkers": ms(list_workers), "workersListed": workers,
            "newest200EventsOfBiggestWorker": ms(recent_events),
            "quick_check": ms(quick_check), "quick_check_result": quick,
        },
    });
    println!("{}", serde_json::to_string_pretty(&report)?);
    let _ = recorded_ids;
    Ok(())
}
