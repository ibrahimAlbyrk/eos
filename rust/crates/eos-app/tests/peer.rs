//! Peering in the composed app: the settings answer, and a run that was not
//! told it may use the network never does.

use std::sync::Arc;

use eos_app::{App, Options};
use eos_runtime::access::Caller;
use eos_runtime::http::{Method, Request};
use eos_testkit::{FakeClock, SeqIds, TempHome};
use serde_json::Value;

fn options(home: &TempHome) -> Options {
    Options {
        clock: Arc::new(FakeClock::new()),
        ids: Arc::new(SeqIds::new()),
        // No `EOS_PEER_ENABLED`: hosting is on by default where the system offers remote access.
        env: Default::default(),
        ..Options::new(home.path())
    }
}

async fn json(app: &App, method: Method, target: &str, caller: Caller) -> (u16, Value) {
    let response = app.router().handle(Request::new(method, target, caller)).await;
    let status = response.status;
    let bytes = response.body.collect().await.expect("a whole body");
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

#[tokio::test(flavor = "multi_thread")]
async fn an_app_that_was_not_told_it_may_use_the_network_never_listens() {
    let home = TempHome::new();
    assert!(!options(&home).peer_network, "off unless the host says so");
    let app = App::build(options(&home)).expect("builds");
    app.start().await.expect("starts");

    // The identity is minted with the data folder, as today.
    assert!(home.join("peer/device.key").is_file() && home.join("peer/device.crt").is_file());
    let (status, info) = json(&app, Method::Get, "/api/host", Caller::UNTRUSTED).await;
    assert_eq!(status, 200);
    assert_eq!(info["id"].as_str().map(str::len), Some(64));
    assert_eq!(info["servesUi"], false);

    let (status, peer) = json(&app, Method::Get, "/api/peer", Caller::DASHBOARD).await;
    assert_eq!(status, 200);
    assert_eq!(peer["enabled"], app.config().current().peer.enabled, "the setting keeps its value");
    assert_eq!(peer["listening"], false, "the side effect needs the host's go");
    assert_eq!(peer["addrs"], serde_json::json!([]));
    assert_eq!(peer["relay"], Value::Null);
    assert_eq!(peer["host"], info);

    // Applying the settings again still opens nothing.
    let save = Request::new(Method::Put, "/api/peer", Caller::DASHBOARD).body(r#"{"enabled":true,"direct":true}"#);
    let saved = app.router().handle(save).await;
    assert_eq!(saved.status, 200);
    let saved: Value = serde_json::from_slice(&saved.body.collect().await.expect("whole")).expect("json");
    assert_eq!((saved["enabled"].as_bool(), saved["listening"].as_bool()), (Some(true), Some(false)));

    // The Machines menu is empty, and a view token names its host's view under that host's prefix.
    assert_eq!(json(&app, Method::Get, "/api/hosts", Caller::DASHBOARD).await.1, serde_json::json!({ "hosts": [] }));
    let host = "a".repeat(64);
    let token = app.callers().view_tokens().mint(&host);
    let view = app.callers().classify_for(Some(&token), &format!("/h/{host}/workers"));
    let (status, unknown) = json(&app, Method::Get, &format!("/h/{host}/workers"), view).await;
    assert_eq!((status, unknown["code"].as_str()), (404, Some("unknown-host")));

    app.shutdown(std::time::Duration::from_secs(5)).await;
}
