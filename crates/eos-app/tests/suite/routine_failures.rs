//! Where a failure shows (09 §9.4), in the composed app with fakes only: each row's failure
//! is made happen and the place the user reads it is read through the routes. The holder of a
//! routine away on another Mac is not here: there is only this Mac until other Macs hold
//! routines (SG-21).

mod runs;

use eos_app::App;
use eos_runtime::http::Method;
use serde_json::{Value, json};

use crate::rig;

/// A run started by hand on pull request `n`; its id.
pub(super) async fn by_hand(app: &App, routine: &str, n: u64) -> String {
    let item = json!({"kind": "github.pull_request", "key": format!("github:pr:acme/game#{n}"),
                      "title": format!("Change {n}"), "version": format!("v{n}"), "untrusted": true});
    let body = json!({"routineId": routine, "door": "routine_page", "input": {"result": "usual"}, "items": [item]});
    let (status, started) = rig::call(app, Method::Post, "/api/runs", Some(body)).await;
    assert_eq!(status, 201, "{started}");
    started["runs"][0]["id"].as_str().expect("a run").to_owned()
}

/// A dashboard read that answers 200.
pub(super) async fn read(app: &App, target: &str) -> Value {
    let (status, body) = rig::call(app, Method::Get, target, None).await;
    assert_eq!(status, 200, "{target}: {body}");
    body
}

/// The open Needs-you items of `kind`, each with its payload.
pub(super) async fn items(app: &App, kind: &str) -> Vec<Value> {
    let list = read(app, "/api/inbox").await;
    let mut found = Vec::new();
    for item in list["items"].as_array().cloned().unwrap_or_default().into_iter().filter(|item| item["kind"] == kind) {
        let id = item["id"].as_str().expect("an id");
        found.push(read(app, &format!("/api/inbox/{id}")).await);
    }
    found
}
