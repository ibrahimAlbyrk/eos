//! Arms routines on a data folder (meant for a private copy) for the idle
//! measurement, `host/tests/memory.py --idle`.
//!
//!   cargo run -p eos-app --example arm_routines -- <data folder> [count]
//!
//! Makes `count` (20) routines, each with one daily schedule, and starts them,
//! all through the router as the dashboard would, on a scripted engine: no
//! agent, model or outside service is reached. Their times are spread over the
//! small hours, so none fires during a measurement taken in the day. Folders
//! that already hold the routines are left as they are. Prints the count only.

#[path = "../tests/support/rig.rs"]
mod rig;

use eos_runtime::http::Method;
use eos_testkit::ScriptedRuntime;
use serde_json::{Value, json};

/// Names every routine this makes, so a second run finds them.
const NAME: &str = "Idle check";

fn blueprint(n: usize) -> Value {
    json!({
        "format": 1, "name": format!("{NAME} {n}"), "summary": "Reviews a pull request.", "icon": "eye",
        "kind": "standing",
        "takes": {"kind": "github.pull_request", "label": "pull request", "placeholder": "#470",
                  "empty": "latest", "many": true},
        "options": [],
        "when": {"on": [{"schedule": {"daily": format!("0{}:{:02}", 1 + n % 4, (n * 7) % 60), "days": "all",
                                      "zone": "UTC"}}]},
        "which": {},
        "who": {"depth": "solo", "agents": [{"key": "reviewer", "name": "Reviewer", "lead": true,
                "brief": "Review the pull request.", "model": "sonnet", "effort": "medium", "tools": {},
                "readsOutside": false, "workspace": "none"}],
                "checker": {"model": "sonnet", "effort": "high"}},
        "how": {"checks": [], "format": "review", "checkAgent": true},
        "makes": {"kind": "github.review", "description": "A pending review."},
        "goesTo": [{"id": "pr", "kind": "item_place", "channel": "github"}],
        "freedom": {"rung": "draft"},
        "limits": {"perRunMinutes": 30, "parallel": 1},
    })
}

async fn armed(app: &eos_app::App) -> usize {
    let (status, listed) = rig::call(app, Method::Get, "/api/routines", None).await;
    assert_eq!(status, 200, "the routines list answered {status}");
    listed.as_array().map_or(0, |rows| {
        rows.iter()
            .filter(|row| row["name"].as_str().is_some_and(|name| name.starts_with(NAME)) && row["state"] == "active")
            .count()
    })
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let mut args = std::env::args().skip(1);
    let Some(home) = args.next() else {
        eprintln!("usage: arm_routines <data folder> [count]");
        std::process::exit(2);
    };
    let count: usize = args.next().and_then(|n| n.parse().ok()).unwrap_or(20);
    let agents = ScriptedRuntime::unlogged();
    let app = rig::build(std::path::Path::new(&home), &agents);
    app.start().await.expect("the app starts");
    for n in armed(&app).await..count {
        let (status, saved) =
            rig::call(&app, Method::Post, "/api/routines", Some(json!({"blueprint": blueprint(n + 1)}))).await;
        assert_eq!(status, 201, "a routine was refused: {}", saved["error"]);
        let id = saved["row"]["id"].as_str().expect("an id").to_owned();
        let (status, started) =
            rig::call(&app, Method::Post, &format!("/api/routines/{id}/start"), Some(json!({"withoutTrial": true})))
                .await;
        assert_eq!(status, 200, "a routine did not start: {}", started["error"]);
    }
    println!("{} routines armed", armed(&app).await);
    app.shutdown(std::time::Duration::from_secs(10)).await;
}
