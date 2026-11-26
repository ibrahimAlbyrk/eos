//! Surfaces: a routine's App in use whose code holds a planted line calls Eos through its
//! bridge with planted state and a planted file under a planted name, and a routine's page is
//! reshaped by a planted instruction. The log tells the App's calls and the reshape by id and
//! kind; none of the planted text, and no path inside the App's folder, reaches it.

use std::time::Duration;

use eos_app::App;
use eos_core::store::StoredSurfaceVersion;
use eos_runtime::http::Method;
use eos_surface::{Level, MadeBy, VersionStatus};
use eos_testkit::TempHome;
use serde_json::{Value, json};

use crate::routines_rig::{Fakes, make, working_agents};
use crate::{Area, rig};

const CODE: &str = "PLANTED-app-code-stoat-lantern";
const STATE: &str = "PLANTED-app-state-ibex-thistle";
const FILE: &str = "PLANTED-app-file-text-crane-ember";
const FILE_NAME: &str = "PLANTED-file-name-vole";
const INSTRUCTION: &str = "PLANTED-reshape-instruction-gecko-moor";
const PAPER: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../eos-surface/tests/morning-paper");

fn paper(name: &str) -> String {
    std::fs::read_to_string(format!("{PAPER}/{name}")).expect("fixture")
}

fn blueprint(name: &str, makes: &str) -> Value {
    json!({
        "format": 1, "name": name, "summary": "s", "icon": "news", "kind": "standing",
        "takes": {"kind": "text", "label": "note", "placeholder": "", "empty": "none", "many": false},
        "options": [], "when": {"on": []}, "which": {},
        "who": {"depth": "solo", "agents": [{"key": "maker", "name": "Maker", "lead": true, "brief": "Make it.",
                "model": "sonnet", "effort": "medium", "tools": {}, "readsOutside": false, "workspace": "none"}],
                "checker": {"model": "sonnet", "effort": "high"}},
        "how": {"checks": [], "format": makes, "checkAgent": false},
        "makes": {"kind": makes, "description": "It."},
        "goesTo": [], "freedom": {"rung": "ask"},
        "limits": {"perRunMinutes": 30, "parallel": 1},
    })
}

/// Keeps `body` as version 1 of the routine's surface of `level`; its id.
async fn keep(app: &App, routine: &str, level: Level, body: Value, made_by: MadeBy) -> String {
    let (id, body) = (routine.to_owned(), body.to_string());
    app.store()
        .write(move |tx, _| {
            let found = tx.surfaces().of_routine(&id)?.into_iter().find(|s| s.level == level);
            let mut surface = found.expect("the routine's surface");
            tx.surface_versions().put(&StoredSurfaceVersion {
                surface_id: surface.id.clone(),
                version: 1,
                status: VersionStatus::Kept,
                base_version: None,
                made_by,
                run_id: None,
                note: String::new(),
                body_bytes: i64::try_from(body.len()).unwrap_or(0),
                body_json: body,
                checks_json: "{}".into(),
                created_at: 0,
                kept_at: Some(0),
            })?;
            surface.current_version = Some(1);
            tx.surfaces().put(&surface)?;
            Ok(surface.id)
        })
        .await
        .expect("kept")
}

async fn app_call(app: &App, surface: &str, name: &str, arguments: Value) -> Value {
    let body = json!({"version": 1, "name": name, "arguments": arguments});
    let (status, answer) = rig::call(app, Method::Post, &format!("/api/surfaces/{surface}/app/call"), Some(body)).await;
    assert_eq!(status, 200, "{name}: {answer}");
    answer
}

pub(crate) async fn steps() -> Area {
    let (home, agents, fakes) = (TempHome::new(), working_agents(), Fakes::new());
    // As the installed app: a dev run refuses an App's calls.
    let app = fakes.app(home.path(), &agents, true);
    app.start().await.expect("starts");

    let levels = make(&app, blueprint("Levels", "app")).await;
    let html = format!("<!doctype html><!-- {CODE} --><p id=\"out\"></p>");
    let manifest = json!({"title": "Notes", "summary": "Keeps notes.", "uses": [], "queries": [],
                          "files": {"root": "routine_files", "read": ["notes/*.md"], "write": ["notes/*.md"]}});
    let surface = keep(&app, &levels, Level::App, json!({"html": html, "manifest": manifest}), MadeBy::Builder).await;
    app_call(&app, &surface, "state.set", json!({"data": {"note": STATE}})).await;
    let path = format!("notes/{FILE_NAME}.md");
    app_call(&app, &surface, "files.write", json!({"path": path, "text": FILE})).await;
    tokio::time::sleep(Duration::from_millis(1_100)).await;
    let read = app_call(&app, &surface, "files.read", json!({"path": path})).await;
    assert_eq!(read["result"]["text"], FILE);

    let paper_routine = make(&app, blueprint("Paper", "page")).await;
    let design = json!({"template": paper("template.html"), "style": paper("style.css"), "uses": ["surface.feedback"],
                        "contract": serde_json::from_str::<Value>(&paper("contract.json")).expect("json"),
                        "sample": serde_json::from_str::<Value>(&paper("sample.json")).expect("json")});
    let page = keep(&app, &paper_routine, Level::Page, design, MadeBy::Designer).await;
    let reshape = json!({"baseVersion": 1, "instruction": INSTRUCTION});
    let (status, started) =
        rig::call(&app, Method::Post, &format!("/api/surfaces/{page}/reshape"), Some(reshape)).await;
    assert!(status < 300, "{status} {started}");
    tokio::time::sleep(Duration::from_millis(200)).await;
    app.shutdown(Duration::from_secs(5)).await;

    let planted = [CODE, STATE, FILE, FILE_NAME, INSTRUCTION];
    let told = [surface.as_str(), page.as_str(), "an App called Eos", "a page's reshape started its designer"];
    Area { planted: planted.map(str::to_owned).to_vec(), told: told.map(str::to_owned).to_vec() }
}
