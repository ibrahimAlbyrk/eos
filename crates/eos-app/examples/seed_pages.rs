//! Seeds a page on a data folder (meant for a private copy) for the shell's page smoke,
//! `host/tests/page_smoke.py`.
//!
//!   cargo run -p eos-app --example seed_pages -- <data folder>
//!
//! Makes one routine whose result is the Morning Paper page of
//! `crates/eos-surface/tests/morning-paper`, through the router as the dashboard would and on
//! a scripted engine (no agent, model or outside service is reached), then writes its page:
//! version 1 kept, one issue of it filled with the fixture's sample, and version 2 the same
//! design left waiting for Eos's window, so the next start with a window probes it. Prints
//! `{"surfaceId", "issueId"}`.

#[path = "../tests/support/rig.rs"]
mod rig;

use eos_core::store::{StoredIssue, StoredSurfaceVersion};
use eos_runtime::http::Method;
use eos_surface::{IssueKind, IssueStatus, Level, MadeBy, VersionStatus};
use eos_testkit::ScriptedRuntime;
use serde_json::{Value, json};

const PAPER: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../eos-surface/tests/morning-paper");
const ISSUE: &str = "si-smoke-paper";

fn file(name: &str) -> String {
    std::fs::read_to_string(format!("{PAPER}/{name}")).expect("a fixture file")
}

fn json_file(name: &str) -> Value {
    serde_json::from_str(&file(name)).expect("a fixture's json")
}

fn blueprint() -> Value {
    json!({
        "format": 1, "name": "Morning Paper", "summary": "A page of the night's news.", "icon": "news",
        "kind": "standing",
        "takes": {"kind": "text", "label": "note", "placeholder": "", "empty": "none", "many": false},
        "options": [], "when": {"on": []}, "which": {},
        "who": {"depth": "solo", "agents": [{"key": "editor", "name": "Editor", "lead": true, "brief": "Fill the page.",
                "model": "sonnet", "effort": "medium", "tools": {}, "readsOutside": false, "workspace": "none"}],
                "checker": {"model": "sonnet", "effort": "high"}},
        "how": {"checks": [], "format": "page", "checkAgent": false},
        "makes": {"kind": "page", "description": "The paper."},
        "goesTo": [],
        "freedom": {"rung": "draft"},
        "limits": {"perRunMinutes": 30, "parallel": 1},
    })
}

fn version(surface_id: &str, n: i64, status: VersionStatus, body: &str) -> StoredSurfaceVersion {
    StoredSurfaceVersion {
        surface_id: surface_id.to_owned(),
        version: n,
        status,
        base_version: None,
        made_by: MadeBy::Designer,
        run_id: None,
        note: "Seeded for the page smoke".into(),
        body_json: body.to_owned(),
        body_bytes: i64::try_from(body.len()).unwrap_or(0),
        checks_json: if status == VersionStatus::Checking { json!({"passed": null}) } else { json!({}) }.to_string(),
        created_at: 0,
        kept_at: (status == VersionStatus::Kept).then_some(0),
    }
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let Some(home) = std::env::args().nth(1) else {
        eprintln!("usage: seed_pages <data folder>");
        std::process::exit(2);
    };
    let agents = ScriptedRuntime::unlogged();
    let app = rig::build(std::path::Path::new(&home), &agents);
    app.start().await.expect("the app starts");
    let (status, saved) = rig::call(&app, Method::Post, "/api/routines", Some(json!({"blueprint": blueprint()}))).await;
    assert_eq!(status, 201, "the routine was refused: {}", saved["error"]);
    let routine = saved["row"]["id"].as_str().expect("an id").to_owned();
    let body = json!({"template": file("template.html"), "style": file("style.css"),
                      "contract": json_file("contract.json"), "uses": ["surface.feedback"],
                      "sample": json_file("sample.json")})
    .to_string();
    let mut data = json_file("sample.json");
    // Nothing is fetched: the page is drawn with its lead image's alt text.
    data["lead"].as_object_mut().expect("a lead").remove("image");
    let issue_body = json!({ "data": data }).to_string();
    let surface_id = app
        .store()
        .write(move |tx, _| {
            let surfaces = tx.surfaces().of_routine(&routine)?;
            let mut page = surfaces.into_iter().find(|s| s.level == Level::Page).expect("the routine's page");
            tx.surface_versions().put(&version(&page.id, 1, VersionStatus::Kept, &body))?;
            tx.surface_versions().put(&version(&page.id, 2, VersionStatus::Checking, &body))?;
            (page.current_version, page.candidate_version) = (Some(1), Some(2));
            tx.surfaces().put(&page)?;
            tx.surface_issues().put(&StoredIssue {
                id: ISSUE.into(),
                surface_id: page.id.clone(),
                seq: Some(1),
                run_id: None,
                version: Some(1),
                kind: IssueKind::Page,
                status: IssueStatus::Ready,
                body_json: issue_body,
                rev: 1,
                images_json: "[]".into(),
                trial: false,
                kept: false,
                created_at: 0,
                updated_at: 0,
            })?;
            Ok(page.id)
        })
        .await
        .expect("the page is written");
    println!("{}", json!({ "surfaceId": surface_id, "issueId": ISSUE }));
    app.shutdown(std::time::Duration::from_secs(10)).await;
}
