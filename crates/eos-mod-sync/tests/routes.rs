//! The sync routes, answer by answer as the Node daemon recorded them while
//! sync is off (`16-services`), and their access rules.

#![allow(clippy::unwrap_used)]

mod support;

use std::sync::Arc;

use eos_runtime::access::Caller;
use eos_runtime::http::{Method, Request};
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_testkit::fixtures;
use eos_testkit::vault::{FakeVault, VaultLimits};
use serde_json::{Value, json};
use support::Mac;
use tokio::sync::Notify;

async fn answer(app: &Runtime, method: Method, path: &str, caller: Caller, body: Option<Value>) -> (u16, Value) {
    let mut request = Request::new(method, path, caller);
    if let Some(body) = body {
        request = request.body(body.to_string());
    }
    let res = app.router.handle(request).await;
    let body = serde_json::from_slice(&res.body.collect().await.unwrap()).unwrap_or(Value::Null);
    (res.status, body)
}

#[tokio::test(flavor = "multi_thread")]
async fn the_routes_answer_as_recorded_while_sync_is_off() {
    let rang = Arc::new(Notify::new());
    let mac = Mac::new(None, "air", b'a', &rang).await;
    let app = Runtime::build(Kernel::new(KernelOptions::default()), vec![mac.module.clone()], Arc::new(AllPluginsOn))
        .unwrap();
    let recording = fixtures::recording("16-services");
    let mut replayed = 0;
    for exchange in recording["exchanges"].as_array().unwrap() {
        let step = &exchange["step"];
        let name = step["name"].as_str().unwrap();
        if !name.starts_with("sync") {
            continue;
        }
        let (method, path) = step["request"].as_str().and_then(|r| r.split_once(' ')).unwrap();
        let caller = if step["auth"] == "none" { Caller::UNTRUSTED } else { Caller::DASHBOARD };
        let (status, body) =
            answer(&app, Method::parse(method).unwrap(), path, caller, step.get("body").cloned()).await;
        assert_eq!(Value::from(status), exchange["response"]["status"], "{name}");
        assert_eq!(body, exchange["response"]["json"], "{name}");
        replayed += 1;
    }
    assert_eq!(
        replayed, 6,
        "sync, sync-key-off, sync-key-without-token, sync-join-bad-key, sync-now-off, sync-leave-off"
    );

    // Creating needs a relay; without one the answer names where to set it up.
    let (status, body) = answer(&app, Method::Post, "/api/sync/create", Caller::DASHBOARD, None).await;
    assert_eq!((status, body), (400, json!({ "error": "set up a relay first (Settings › Remote)" })));
    let (status, body) =
        answer(&app, Method::Post, "/api/sync/join", Caller::DASHBOARD, Some(json!({ "key": "short" }))).await;
    assert_eq!(
        (status, body),
        (400, json!({ "error": "invalid request: key: String must contain at least 10 character(s)" }))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_key_and_every_change_are_the_users_and_nothing_crosses_to_a_paired_computer() {
    let vault = FakeVault::new(VaultLimits::default());
    let served = vault.serve().await;
    let rang = Arc::new(Notify::new());
    let mac = Mac::new(Some(served.relay_url()), "air", b'a', &rang).await;
    let app = Runtime::build(Kernel::new(KernelOptions::default()), vec![mac.module.clone()], Arc::new(AllPluginsOn))
        .unwrap();

    for (method, path) in [
        (Method::Get, "/api/sync/key"),
        (Method::Post, "/api/sync/create"),
        (Method::Post, "/api/sync/join"),
        (Method::Post, "/api/sync/now"),
        (Method::Post, "/api/sync/leave"),
    ] {
        let (status, body) = answer(&app, method, path, Caller::UNTRUSTED, None).await;
        assert_eq!((status, body), (403, json!({ "error": "ui token required" })), "{path}");
    }
    assert_eq!(answer(&app, Method::Get, "/api/sync", Caller::UNTRUSTED, None).await.0, 200, "the status is open");
    assert_eq!(mac.sync.key(), None, "none of the refused calls did anything");

    let paired = Caller::Peer { device: "f".repeat(64).into(), human: true };
    for (method, path) in
        [(Method::Get, "/api/sync"), (Method::Get, "/api/sync/key"), (Method::Post, "/api/sync/create")]
    {
        assert_eq!(answer(&app, method, path, paired.clone(), None).await.0, 403, "{path} stays on this computer");
    }

    let (status, created) = answer(&app, Method::Post, "/api/sync/create", Caller::DASHBOARD, None).await;
    assert_eq!(status, 200);
    assert_eq!(created["relay"], served.http_base().trim_start_matches("http://"));
    assert_eq!(
        created["counts"],
        json!({ "profile": 0, "avatar": 0, "memory": 0, "template": 0, "worker": 0, "page": 0 })
    );
    let (status, key) = answer(&app, Method::Get, "/api/sync/key", Caller::DASHBOARD, None).await;
    assert_eq!(status, 200);
    assert!(key["key"].as_str().unwrap().starts_with("eos-sync1."));
    assert_eq!(answer(&app, Method::Post, "/api/sync/now", Caller::DASHBOARD, None).await.0, 202);
    let (status, left) = answer(&app, Method::Post, "/api/sync/leave", Caller::DASHBOARD, None).await;
    assert_eq!((status, &left["phase"]), (200, &json!("off")));
}
