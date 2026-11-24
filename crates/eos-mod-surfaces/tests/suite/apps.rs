//! `app_propose`: a session building a routine's App hands it in; Eos's
//! scan refuses a way out of the frame or an undeclared name, and what
//! passes waits as the App's version for its review and its tests, shown
//! to nobody. With Apps off in Settings nothing is taken.

use eos_contracts::SettingValue;
use eos_core::Error;
use eos_surface::{Level, MadeBy, Place, VersionStatus};
use serde_json::{Value, json};

use crate::rig::{Rig, surface};

pub(crate) const GAME: &str = r#"<!doctype html><button id="go">Again</button><p id="out"></p>
<script>
  let id = 0;
  const call = (name, args) => parent.postMessage({jsonrpc: "2.0", id: ++id, method: "tools/call", params: {name, arguments: args}}, "*");
  document.getElementById("go").onclick = () => call("probe.again", {});
  call("query.probe.count", {});
  call("state.get", {});
</script>"#;

pub(crate) fn app(html: &str) -> Value {
    json!({
        "html": html,
        "manifest": {"title": "Level editor", "summary": "Edits the game's levels.", "uses": ["probe.again"],
                     "queries": ["probe.count"], "files": {"root": "project", "read": ["levels/*.json"]}},
        "tests": "eosTest.click('#go'); eosTest.expect(eosTest.calls().length === 3, 'it called');",
    })
}

/// A routine that makes an App, with a project run whose lead is `w-lead`.
pub(crate) async fn game() -> Rig {
    let rig = Rig::new().await;
    rig.run_worker("rt-1", "Game", "rn-p", "project", "w-lead");
    rig.run_worker("rt-1", "Game", "rn-s", "standing", "w-other");
    rig.seed(vec![surface("sf-app", "rt-1", Level::App, Place::RoutinePage, 1)], vec![], vec![]).await;
    rig
}

pub(crate) async fn row(rig: &Rig, n: i64) -> eos_core::store::StoredSurfaceVersion {
    rig.temp.port().read(move |tx| tx.surface_versions().find("sf-app", n)).await.expect("reads").expect("a version")
}

async fn propose(rig: &Rig, worker: &str, body: Value) -> Result<String, Error> {
    rig.module.tools().app_propose(worker, body, "A level editor".into()).await
}

#[tokio::test(flavor = "multi_thread")]
async fn an_app_that_passes_the_scan_waits_for_its_review_and_tests() {
    let rig = game().await;
    let line = propose(&rig, "w-lead", app(GAME)).await.expect("scanned");
    assert!(line.contains("waits for its review and its tests"), "{line}");
    let v1 = row(&rig, 1).await;
    assert_eq!((v1.status, v1.made_by, v1.run_id.as_deref()), (VersionStatus::Checking, MadeBy::Builder, Some("rn-p")));
    let body: Value = serde_json::from_str(&v1.body_json).expect("json");
    assert_eq!(body["manifest"]["stateMaxBytes"], 256 * 1024);
    let (_, shown) = rig.ask(eos_runtime::http::Method::Get, "/api/surfaces/sf-app", None).await;
    assert_eq!(shown["currentVersion"], Value::Null, "nobody sees it before its review and tests: {shown}");

    // A second App takes the place of the one still waiting.
    propose(&rig, "w-lead", app(GAME)).await.expect("scanned");
    assert_eq!(row(&rig, 1).await.status, VersionStatus::Discarded);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_scan_refuses_and_nothing_is_written() {
    let rig = game().await;
    let refused = |result: Result<String, Error>| match result {
        Err(Error::Validation(problems)) => problems,
        other => panic!("taken: {other:?}"),
    };
    let fetching = refused(propose(&rig, "w-lead", app(&format!("{GAME}<script>fetch('https://x')</script>"))).await);
    assert!(fetching.contains("`fetch(`"), "{fetching}");
    let undeclared =
        refused(propose(&rig, "w-lead", app(&format!("{GAME}<script>call('probe.erase')</script>"))).await);
    assert_eq!(undeclared, "html: calls `probe.erase`, which its manifest does not declare");
    let mut unknown = app(GAME);
    unknown["manifest"]["uses"] = json!(["probe.again", "nobody.knows"]);
    let found = refused(propose(&rig, "w-lead", unknown).await);
    assert_eq!(found, "manifest.uses[1]: `nobody.knows` is no action Eos has");
    let elsewhere = refused(propose(&rig, "w-other", app(GAME)).await);
    assert!(elsewhere.contains("builds an App"), "{elsewhere}");
    assert_eq!(rig.temp.count("SELECT COUNT(*) FROM surface_versions WHERE surface_id = 'sf-app'"), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn with_apps_off_in_settings_no_app_is_taken() {
    let rig = game().await;
    rig.settings.0.lock().expect("settings").insert("genui.apps".into(), SettingValue::Flag(false));
    let Err(Error::Validation(why)) = propose(&rig, "w-lead", app(GAME)).await else { panic!("taken") };
    assert!(why.contains("switched off"), "{why}");
}
