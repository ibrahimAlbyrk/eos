//! Memory's embedder that did not load, push that is not set up and a sync domain that is
//! full, each where the user reads it: Memory's health line, Settings › Remote's test
//! notification and Needs you.

use std::time::Duration;

use eos_contracts::SyncFull;
use eos_runtime::bus::Topic;
use eos_runtime::http::Method;
use eos_testkit::{ScriptedRuntime, TempHome};
use serde_json::Value;

use super::{items, read};
use crate::rig;
use crate::routines_rig::eventually;

#[tokio::test(flavor = "multi_thread")]
async fn an_embedder_that_did_not_load_shows_on_memory_s_health_line() {
    let (home, agents) = (TempHome::new(), ScriptedRuntime::new());
    // No model folder is handed in: the embedder cannot load.
    let app = rig::build(home.path(), &agents);
    app.start().await.expect("starts");
    let summary = read(&app, "/api/memory/summary").await;
    assert_eq!(summary["health"]["embedder"], "off", "{summary}");
    app.shutdown(Duration::from_secs(5)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn push_that_is_not_set_up_says_so_in_settings_remote() {
    let (home, agents) = (TempHome::new(), ScriptedRuntime::new());
    let app = rig::build(home.path(), &agents);
    app.start().await.expect("starts");
    let (status, tested) = rig::call(&app, Method::Post, "/api/remote/push-test", None).await;
    assert_eq!(status, 200, "{tested}");
    assert_eq!((tested["sent"].as_i64(), tested["reason"].as_str()), (Some(0), Some("link-off")), "{tested}");
    assert!(!home.path().join("remote").exists(), "nothing was set up for it");
    app.shutdown(Duration::from_secs(5)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_full_sync_domain_opens_one_notice() {
    let (home, agents) = (TempHome::new(), ScriptedRuntime::new());
    let app = rig::build(home.path(), &agents);
    app.start().await.expect("starts");
    // As the sync feature tells it once each time a domain reaches its vault budget.
    let full: Topic<SyncFull> = Topic::new("sync:full");
    app.runtime().kernel.bus.publish(&full, &SyncFull { domain: "memory".into() });
    let told = || async { sync_notices(&app).await };
    eventually("a notice says sync is full", || async { !told().await.is_empty() }).await;
    let notices = told().await;
    assert_eq!(notices.len(), 1, "{notices:?}");
    assert_eq!(notices[0]["payload"]["domain"], "memory");
    assert!(notices[0]["item"]["summary"].as_str().is_some_and(|s| s.contains("Settings › Sync")));
    app.shutdown(Duration::from_secs(5)).await;
}

async fn sync_notices(app: &eos_app::App) -> Vec<Value> {
    let notices = items(app, "notice").await;
    notices.into_iter().filter(|n| n["item"]["title"] == "Sync is full for some of your data").collect()
}
