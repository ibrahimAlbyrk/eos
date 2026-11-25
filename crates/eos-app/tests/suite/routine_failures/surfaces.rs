//! A page whose data does not fit, and a page design whose checks wait for Eos's window, each
//! where the user reads them: the plain View the run shows, the redesign item after two such
//! runs, and the candidate's line.

use std::time::Duration;

use eos_app::App;
use eos_core::store::StoredSurfaceVersion;
use eos_runtime::http::Method;
use eos_surface::{Level, MadeBy, VersionStatus};
use eos_testkit::{ScriptedRuntime, TempHome};
use serde_json::{Value, json};

use super::{items, read};
use crate::rig;
use crate::routines_rig::{Fakes, call_tool, eventually, lead, make, run, working_agents};

const PAPER: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../eos-surface/tests/morning-paper");

fn paper_file(name: &str) -> String {
    std::fs::read_to_string(format!("{PAPER}/{name}")).expect("fixture")
}

fn paper_json(name: &str) -> Value {
    serde_json::from_str(&paper_file(name)).expect("json")
}

/// A morning paper held as a draft for the user's own mail.
fn paper_blueprint() -> Value {
    json!({
        "format": 1, "name": "Morning Paper", "summary": "A page of the night's news.", "icon": "news",
        "kind": "standing",
        "takes": {"kind": "text", "label": "note", "placeholder": "", "empty": "none", "many": false}, "options": [], "when": {"on": []}, "which": {},
        "who": {"depth": "solo", "agents": [{"key": "editor", "name": "Editor", "lead": true, "brief": "Fill the page.",
                "model": "sonnet", "effort": "medium", "tools": {}, "readsOutside": false, "workspace": "none"}],
                "checker": {"model": "sonnet", "effort": "high"}},
        "how": {"checks": [], "format": "page", "checkAgent": false},
        "makes": {"kind": "page", "description": "The paper."},
        "goesTo": [{"id": "me", "kind": "fixed", "channel": "mail", "address": "me@acme.dev"}],
        "freedom": {"rung": "draft"},
        "limits": {"perRunUsd": 2, "perRunMinutes": 30, "perDayUsd": 5, "parallel": 1},
    })
}

fn design() -> Value {
    json!({"template": paper_file("template.html"), "style": paper_file("style.css"),
           "contract": paper_json("contract.json"), "uses": ["surface.feedback"], "sample": paper_json("sample.json")})
}

/// The routine's page with a kept design, as if its design run had made one; the page's id.
async fn keep_design(app: &App, routine: &str) -> String {
    let (id, body) = (routine.to_owned(), design().to_string());
    let store = app.store();
    let kept = store.write(move |tx, _| {
        let surfaces = tx.surfaces().of_routine(&id)?;
        let mut page = surfaces.into_iter().find(|s| s.level == Level::Page).expect("the routine's page");
        tx.surface_versions().put(&StoredSurfaceVersion {
            surface_id: page.id.clone(),
            version: 1,
            status: VersionStatus::Kept,
            base_version: None,
            made_by: MadeBy::Designer,
            run_id: None,
            note: String::new(),
            body_bytes: i64::try_from(body.len()).unwrap_or(0),
            body_json: body,
            checks_json: "{}".into(),
            created_at: 0,
            kept_at: Some(0),
        })?;
        page.current_version = Some(1);
        tx.surfaces().put(&page)?;
        Ok(page.id)
    });
    kept.await.expect("kept")
}

async fn paper(app: &App) -> (String, String) {
    let routine = make(app, paper_blueprint()).await;
    let surface = keep_design(app, &routine).await;
    (routine, surface)
}

/// A run of the paper whose lead fills data that does not fit until the page falls back;
/// what the last fill answered.
async fn falls_back(app: &App, agents: &ScriptedRuntime, routine: &str, n: u32) -> String {
    let body = json!({"routineId": routine, "input": {"result": "usual"}, "door": "home", "clientRequestId": format!("c-{n}")});
    let (status, started) = rig::call(app, Method::Post, "/api/runs", Some(body)).await;
    assert!(status < 300, "{status} {started}");
    let run_id = started["runs"][0]["id"].as_str().expect("a run").to_owned();
    let lead_id = lead(app, agents, &run_id).await;
    let mut last = String::new();
    for _ in 0..3 {
        last = call_tool(app, agents, &lead_id, "fill_page", json!({"data": {"title": 3}})).await.text;
    }
    let reply = call_tool(app, agents, &lead_id, "report_failure", json!({"reason": "The data did not fit."})).await;
    assert!(!reply.is_error, "{}", reply.text);
    eventually("the run ends", || async { run(app, &run_id).await.state.as_str() == "failed" }).await;
    last
}

#[tokio::test(flavor = "multi_thread")]
async fn page_data_that_does_not_fit_shows_as_a_plain_view_and_two_such_runs_ask_for_a_redesign() {
    let (home, agents, fakes) = (TempHome::new(), working_agents(), Fakes::new());
    let app = fakes.app(home.path(), &agents, true);
    app.start().await.expect("starts");
    let (routine, surface) = paper(&app).await;

    let line = falls_back(&app, &agents, &routine, 1).await;
    assert!(line.contains("is shown as a plain view"), "{line}");
    let issues = read(&app, &format!("/api/surfaces/{surface}/issues")).await;
    let issues = issues["issues"].as_array().cloned().unwrap_or_default();
    assert!(issues.iter().any(|issue| issue["kind"] == "fallback"), "the plain View is the run's issue: {issues:?}");
    assert!(redesigns(&app).await.is_empty(), "one fallback asks for nothing yet");

    falls_back(&app, &agents, &routine, 2).await;
    eventually("a redesign is asked for", || async { !redesigns(&app).await.is_empty() }).await;
    let alerts = redesigns(&app).await;
    assert_eq!(alerts.len(), 1, "{alerts:?}");
    assert_eq!(alerts[0]["payload"]["view"]["surfaceId"], surface.as_str(), "{}", alerts[0]);
    app.shutdown(Duration::from_secs(5)).await;
}

/// The Needs-you items that ask for the page's redesign: notices with reason `page_redesign`,
/// not the `routine_alert` G44 names, whose card offers Resume for a routine that never paused.
async fn redesigns(app: &App) -> Vec<Value> {
    let notices = items(app, "notice").await;
    notices.into_iter().filter(|n| n["payload"]["reason"] == "page_redesign").collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_page_design_whose_checks_need_eos_s_window_says_it_waits_for_it() {
    let (home, agents, fakes) = (TempHome::new(), working_agents(), Fakes::new());
    let app = fakes.app(home.path(), &agents, true);
    app.start().await.expect("starts");
    let (_routine, surface) = paper(&app).await;

    let asked = json!({"baseVersion": 1, "instruction": "Put the weather first."});
    let (status, started) =
        rig::call(&app, Method::Post, &format!("/api/surfaces/{surface}/reshape"), Some(asked)).await;
    assert!(status < 300, "{status} {started}");
    let run_id = started["runId"].as_str().expect("a design run").to_owned();
    let designer = lead(&app, &agents, &run_id).await;
    let mut proposal = design();
    proposal["note"] = json!("The weather first.");
    let reply = call_tool(&app, &agents, &designer, "page_design_propose", proposal).await;
    assert!(!reply.is_error, "{}", reply.text);
    assert!(reply.text.contains("once Eos's window is open"), "{}", reply.text);

    let version = read(&app, &format!("/api/surfaces/{surface}/versions/2")).await;
    assert_eq!(version["checks"]["waiting"], "Waiting for Eos's window", "{version}");
    app.shutdown(Duration::from_secs(5)).await;
}
