//! A fresh file migrated here has the schema today's TypeScript runner builds
//! (`tests/fixtures/ts-schema.json`, written by `scripts/gen-reference-schema.ts`).

use eos_kit_sqlite::{Db, EMBEDDED, Error, Options, preflight};
use serde::Deserialize;

#[derive(Debug, Deserialize, PartialEq, Eq)]
struct Object {
    r#type: String,
    name: String,
    tbl_name: String,
    sql: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Reference {
    applied: usize,
    auto_vacuum: i64,
    journal_mode: String,
    ids: Vec<String>,
    objects: Vec<Object>,
}

#[test]
fn a_fresh_database_equals_the_one_typescript_creates() {
    let reference: Reference = serde_json::from_str(include_str!("fixtures/ts-schema.json")).expect("reference schema");
    assert_eq!(reference.applied, EMBEDDED.len());

    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("state.db");
    let before = preflight(&path, EMBEDDED).expect("preflight");
    assert!(!before.exists && before.pending.len() == EMBEDDED.len());

    let (db, report) = Db::open(&path, Options::default(), 1).expect("open");
    assert_eq!(report.applied.len(), reference.applied);

    let (objects, ids, auto_vacuum, journal_mode) = db
        .read(|c| {
            let mut stmt = c.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")?;
            let objects = stmt
                .query_map([], |r| {
                    Ok(Object { r#type: r.get(0)?, name: r.get(1)?, tbl_name: r.get(2)?, sql: r.get(3)? })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let mut stmt = c.prepare("SELECT id FROM schema_migrations ORDER BY id")?;
            let ids = stmt.query_map([], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
            let auto_vacuum: i64 = c.pragma_query_value(None, "auto_vacuum", |r| r.get(0))?;
            let journal_mode: String = c.pragma_query_value(None, "journal_mode", |r| r.get(0))?;
            Ok::<_, Error>((objects, ids, auto_vacuum, journal_mode))
        })
        .expect("read schema");

    assert_eq!(objects.len(), reference.objects.len());
    for (ours, theirs) in objects.iter().zip(&reference.objects) {
        assert_eq!(ours, theirs);
    }
    assert_eq!(ids, reference.ids);
    assert_eq!(auto_vacuum, reference.auto_vacuum);
    assert_eq!(journal_mode, reference.journal_mode);

    drop(db);
    let after = preflight(&path, EMBEDDED).expect("preflight");
    assert!(after.up_to_date() && after.unknown.is_empty());
}
