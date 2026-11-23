//! An existing user: a data folder as the released app left it (its schema and the frozen
//! seed rows) takes every migration of this app, keeps what it held, answers the Eos reads
//! empty, and opens again with nothing left to migrate.

use std::sync::Arc;
use std::time::Duration;

use eos_app::{App, Options};
use eos_kit_sqlite::{EMBEDDED, TYPESCRIPT_MIGRATIONS, run_migrations, rusqlite::Connection};
use eos_runtime::http::{Method, Request};
use eos_testkit::fixtures::seed_sql;
use eos_testkit::{FakeClock, SeqIds, TempHome};
use serde_json::Value;

/// The folder the released app left: its own migrations, then the seed rows.
fn released_home() -> TempHome {
    let home = TempHome::new();
    let sandbox = home.join("sandbox").to_string_lossy().into_owned();
    for project in ["alpha", "beta"] {
        std::fs::create_dir_all(format!("{sandbox}/{project}")).expect("a project folder");
    }
    let conn = Connection::open(home.join("state.db")).expect("a database");
    let report = run_migrations(&conn, &EMBEDDED[..TYPESCRIPT_MIGRATIONS], 0).expect("the released schema");
    assert_eq!(report.applied.len(), TYPESCRIPT_MIGRATIONS);
    conn.execute_batch(&seed_sql(&sandbox)).expect("the seed rows");
    home
}

async fn started(home: &TempHome) -> App {
    let options = Options {
        clock: Arc::new(FakeClock::new()),
        ids: Arc::new(SeqIds::new()),
        env: Default::default(),
        ..Options::new(home.path())
    };
    let app = App::build(options).expect("builds");
    app.start().await.expect("starts");
    app
}

async fn get(app: &App, target: &str) -> Value {
    let caller = app.callers().classify(Some(app.callers().ui_token()));
    let res = app.router().handle(Request::new(Method::Get, target, caller)).await;
    let status = res.status;
    let body = res.body.collect().await.expect("a body");
    assert_eq!(status, 200, "{target}: {}", String::from_utf8_lossy(&body));
    serde_json::from_slice(&body).expect("JSON")
}

fn count(home: &TempHome, sql: &str) -> i64 {
    let conn = Connection::open(home.join("state.db")).expect("a database");
    conn.query_row(sql, [], |row| row.get(0)).expect("a count")
}

#[tokio::test(flavor = "multi_thread")]
async fn a_released_data_folder_takes_every_migration_and_keeps_what_it_held() {
    let home = released_home();
    let workers_before = count(&home, "SELECT count(*) FROM workers");
    let events_before = count(&home, "SELECT count(*) FROM events");
    let listed = count(&home, "SELECT count(*) FROM workers WHERE archived_at IS NULL") as usize;

    let app = started(&home).await;
    let workers = get(&app, "/workers").await;
    assert_eq!(workers.as_array().map(Vec::len), Some(listed), "the seeded chats: {workers}");
    for target in ["/api/routines", "/api/runs", "/api/inbox", "/api/memory/notes", "/api/surfaces", "/api/signals"] {
        get(&app, target).await;
    }
    assert!(app.shutdown(Duration::from_secs(5)).await.clean());

    assert_eq!(
        count(&home, "SELECT count(*) FROM schema_migrations WHERE id NOT LIKE '\\_\\_%' ESCAPE '\\'"),
        EMBEDDED.len() as i64
    );
    assert_eq!(count(&home, "SELECT count(*) FROM workers"), workers_before, "no chat was lost");
    assert!(count(&home, "SELECT count(*) FROM events") >= events_before, "no row of a transcript was lost");
    for table in ["routines", "runs", "signals", "inbox_items", "mem_notes", "surface_defs", "capability_installs"] {
        let found =
            count(&home, &format!("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = '{table}'"));
        assert_eq!(found, 1, "{table}");
    }

    let again = started(&home).await;
    let workers = get(&again, "/workers").await;
    assert_eq!(workers.as_array().map(Vec::len), Some(listed), "it opens again as it was");
    assert!(again.shutdown(Duration::from_secs(5)).await.clean());
}
