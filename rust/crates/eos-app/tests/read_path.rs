//! The read path end to end, against the recorded wire: a seeded data folder
//! in, today's answers out. `scripts/replay.sh` runs every recorded step with
//! the full normalizer; this keeps the core of it inside `cargo test`.

use std::sync::Arc;
use std::time::Duration;

use eos_app::{App, Options};
use eos_runtime::http::{Method, Request};
use eos_testkit::{FakeClock, SeqIds, TempHome, fixtures};
use serde_json::Value;

/// A data folder with the invented rows, whose projects' folders exist (a
/// chat is only resumable while its folder does). Also returns the folder
/// that stands for the recordings' `{sandbox}`.
fn seeded() -> (TempHome, String) {
    let home = TempHome::new();
    let sandbox = home.join("sandbox").to_string_lossy().into_owned();
    for project in ["alpha", "beta"] {
        std::fs::create_dir_all(format!("{sandbox}/{project}")).expect("a project folder");
    }
    (home.with_seed(&sandbox), sandbox)
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

async fn get(app: &App, target: &str) -> (u16, String) {
    let res = app.router().handle(Request::new(Method::Get, target, app.callers().classify(None))).await;
    let status = res.status;
    let body = res.body.collect().await.expect("a body");
    (status, String::from_utf8_lossy(&body).into_owned())
}

fn json(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or(Value::Null)
}

/// Whether `actual` is what was recorded, wherever the recording did not
/// replace a value by a placeholder (`<uuid:1>`, `<now>`, `<ms>`, …).
fn same(actual: &Value, recorded: &Value) -> bool {
    match (actual, recorded) {
        (_, Value::String(text)) if text.contains('<') && text.contains('>') => true,
        (Value::Object(a), Value::Object(r)) => {
            a.len() == r.len() && r.iter().all(|(k, v)| a.get(k).is_some_and(|x| same(x, v)))
        }
        (Value::Array(a), Value::Array(r)) => a.len() == r.len() && a.iter().zip(r).all(|(x, y)| same(x, y)),
        _ => actual == recorded,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_seeded_folder_answers_as_the_daemon_did() {
    let (home, sandbox) = seeded();
    let app = started(&home).await;
    assert_eq!((app.reconciled().suspended, app.reconciled().closed), (1, 0), "the chat left working is parked");

    let steps = [
        ("11-chats", "list", "/workers"),
        ("11-chats", "list-brief", "/workers?brief=1"),
        ("11-chats", "orchestrators", "/orchestrators"),
        ("11-chats", "list-children", "/workers?parentId=o-ORCH"),
        ("11-chats", "archived", "/workers/archived"),
        ("11-chats", "row", "/workers/w-BUSY"),
        ("11-chats", "row-orchestrator", "/workers/o-ORCH"),
        ("11-chats", "row-child-as-parent", "/workers/w-KID2?actorId=o-ORCH"),
        ("11-chats", "row-foreign-actor", "/workers/w-BUSY?actorId=w-KID2"),
        ("11-chats", "row-archived-for-dashboard", "/workers/w-ARCH"),
        ("11-chats", "row-archived-for-agent", "/workers/w-ARCH?actorId=w-ARCH"),
        ("11-chats", "row-unknown", "/workers/w-nope0000"),
        ("11-chats", "events-bad-query", "/workers/w-BUSY/events?limit=0&order=sideways"),
        ("11-chats", "events-unknown-worker", "/workers/w-nope0000/events"),
        ("11-chats", "attachments", "/workers/w-BUSY/attachments"),
        ("12-transcript", "default-page", "/workers/w-LONG/events"),
        ("12-transcript", "page-over-max", "/workers/w-LONG/events?limit=5001"),
        ("12-transcript", "since-time", "/workers/w-LONG/events?since=1790000715000&order=asc"),
        ("12-transcript", "full-transcript", "/workers/w-CHAT/events?order=asc"),
        ("12-transcript", "interrupted-chat", "/workers/w-BUSY/events?order=asc"),
        ("12-transcript", "prompt-events", "/workers/w-CHAT/prompt-events"),
        ("12-transcript", "subagent-events", "/workers/w-CHAT/subagent-events"),
        ("12-transcript", "child-row", "/workers/w-KID1"),
        ("20-reads", "projects", "/projects"),
        ("20-reads", "recents", "/fs/recents"),
    ];
    for (scenario, step, target) in steps {
        let recorded = fixtures::recorded_response(scenario, step);
        let (status, body) = get(&app, target).await;
        // The recordings write the projects' folder as `{sandbox}`.
        let body = json(&body.replace(&sandbox, "{sandbox}"));
        assert_eq!(status, recorded["status"], "{scenario} / {step}");
        assert!(same(&body, &recorded["json"]), "{scenario} / {step}: GET {target} answered\n{body:#}");
    }

    let (status, health) = get(&app, "/health").await;
    let health = json(&health);
    assert_eq!(
        (status, &health["ok"], &health["startedAt"]),
        (200, &Value::Bool(true), &Value::from(FakeClock::START_MS))
    );
    let (_, ui) = get(&app, "/api/ui-config").await;
    let ui = json(&ui);
    let recorded = fixtures::recorded_response("20-reads", "ui-config")["json"].clone();
    for key in ["models", "modelCatalog", "prices", "permissions", "sse", "backendProfiles", "features"] {
        assert_eq!(ui[key], recorded[key], "ui-config.{key}");
    }
    assert_eq!(ui["backends"], Value::Array(Vec::new()), "no engine is linked yet");

    assert!(app.shutdown(Duration::from_secs(5)).await.clean());
}

#[tokio::test(flavor = "multi_thread")]
async fn start_up_snapshots_the_data_and_leaves_what_it_does_not_know() {
    let (home, _) = seeded();
    home.write("pages/pg-1.md", "# Mine");
    {
        // What older builds left in a real file: tables and migration ids no current code knows.
        let conn = eos_kit_sqlite::rusqlite::Connection::open(home.join("state.db")).expect("opens");
        conn.execute_batch(
            "CREATE TABLE scheduled_prompts (id TEXT PRIMARY KEY, body TEXT);
             INSERT INTO scheduled_prompts VALUES ('sp-1', 'kept');
             INSERT INTO schema_migrations VALUES ('050_workflows', 1), ('058_scheduled_prompts', 1);",
        )
        .expect("the leftovers");
    }
    let app = started(&home).await;
    app.runtime().lifecycle.deferred_done().await;
    app.shutdown(Duration::from_secs(5)).await;
    drop(app);

    let snapshots: Vec<_> = std::fs::read_dir(home.join("backups")).expect("a snapshot folder").flatten().collect();
    assert_eq!(snapshots.len(), 1);
    let snapshot = snapshots[0].path();
    assert!(snapshot.join("state.db").exists() && snapshot.join("pages/pg-1.md").exists());
    // The copy was taken before start-up touched the rows: the chat is still WORKING in it.
    let state_in = |db: std::path::PathBuf| -> String {
        let conn = eos_kit_sqlite::rusqlite::Connection::open(db).expect("opens");
        conn.query_row("SELECT state FROM workers WHERE id = 'w-BUSY'", [], |r| r.get(0)).expect("the row")
    };
    assert_eq!(state_in(snapshot.join("state.db")), "WORKING");
    assert_eq!(state_in(home.join("state.db")), "SUSPENDED");

    let conn = eos_kit_sqlite::rusqlite::Connection::open(home.join("state.db")).expect("opens");
    let kept: String =
        conn.query_row("SELECT body FROM scheduled_prompts", [], |r| r.get(0)).expect("the leftover row");
    let unknown: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM schema_migrations WHERE id IN ('050_workflows', '058_scheduled_prompts')",
            [],
            |r| r.get(0),
        )
        .expect("counts");
    assert_eq!((kept.as_str(), unknown), ("kept", 2));
}
