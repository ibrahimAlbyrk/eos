//! The sample data a dev run shows (`eos_testkit::samples`), read through the app's own
//! routes: every area answers it, and every item of it opens.

use std::time::Duration;

use eos_app::{App, CapabilityOptions};
use eos_runtime::http::Method;
use eos_testkit::samples::{MAIL_ISSUES, MAIL_SURFACE, MORNING_MAIL};
use eos_testkit::{ScriptedRuntime, TempHome};
use serde_json::{Value, json};

use crate::rig;

async fn get(app: &App, target: &str) -> Value {
    let (status, body) = rig::call(app, Method::Get, target, None).await;
    assert_eq!(status, 200, "{target}: {body}");
    body
}

/// The rows of a list answer: the answer itself, or its first list (`items`, `notes`).
fn rows(body: &Value) -> &[Value] {
    let first = || body.as_object()?.values().find_map(Value::as_array);
    body.as_array().or_else(first).map_or(&[], Vec::as_slice)
}

#[tokio::test(flavor = "multi_thread")]
async fn every_area_reads_its_samples_and_each_item_opens() {
    let home = TempHome::new();
    let app = rig::build_with(home.path(), &ScriptedRuntime::new(), CapabilityOptions::default());
    assert!(eos_testkit::samples::seed(app.store().as_ref()).await.expect("seeds"));
    app.start().await.expect("starts");

    let routines = get(&app, "/api/routines").await;
    assert_eq!(rows(&routines).len(), 4, "four routines: {routines}");
    let inbox = get(&app, "/api/inbox").await;
    // An item of every kind, and the one GitHub opens: the sample PR Review
    // needs it, and nobody signed in to it here.
    assert_eq!(rows(&inbox).len(), 14, "an item of every kind: {inbox}");
    let github = rows(&inbox).iter().filter(|item| item["title"] == "GitHub needs setting up").count();
    assert_eq!(github, 1, "{inbox}");
    for item in rows(&inbox) {
        let id = item["id"].as_str().expect("an id");
        get(&app, &format!("/api/inbox/{id}")).await;
    }
    let signals = get(&app, "/api/signals").await;
    assert!(rows(&signals).len() >= 6, "the signals: {signals}");
    let summary = get(&app, "/api/signals/summary?since=0").await;
    assert!(summary["counts"]["handled"].as_i64() > Some(0), "{summary}");
    let notes = get(&app, "/api/memory/notes").await;
    assert_eq!(rows(&notes).len(), 4, "the notes: {notes}");

    let surfaces = get(&app, "/api/surfaces").await;
    assert_eq!(rows(&surfaces).len(), 1, "{surfaces}");
    assert_eq!(
        (&rows(&surfaces)[0]["id"], &rows(&surfaces)[0]["routineId"]),
        (&json!(MAIL_SURFACE), &json!(MORNING_MAIL))
    );
    let issues = get(&app, &format!("/api/surfaces/{MAIL_SURFACE}/issues")).await;
    assert_eq!(rows(&issues).len(), 3, "{issues}");
    for issue in MAIL_ISSUES {
        let one = get(&app, &format!("/api/surfaces/{MAIL_SURFACE}/issues/{issue}")).await;
        assert_eq!(one["body"]["view"]["title"], "Overnight mail", "{one}");
    }

    let capabilities = get(&app, "/api/capabilities").await;
    let states: std::collections::BTreeSet<&str> = rows(&capabilities)
        .iter()
        .filter(|row| row["id"].as_str().is_some_and(|id| id.starts_with("sample-")))
        .filter_map(|row| row["state"].as_str())
        .collect();
    assert_eq!(states.len(), 7, "a capability in each state: {states:?}");
    assert!(app.shutdown(Duration::from_secs(5)).await.clean());
}
