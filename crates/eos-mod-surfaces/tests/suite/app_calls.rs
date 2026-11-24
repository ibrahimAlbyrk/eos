//! `POST /api/surfaces/:id/app/call`: the App in use reaches only what its
//! manifest declares. Its actions pass the gate like a press, its queries
//! are read for its routine, its state is its own, and its files are the
//! ones its globs name below its root, never through `..`, an absolute path
//! or a link out of it. Too many calls are refused, and with Apps off none
//! is taken.

use std::fs;

use eos_contracts::{SettingValue, VersionAuthor};
use eos_core::inbox::ActionDecision;
use eos_core::store::StoredVersion;
use eos_domain::run_scope::Trust;
use eos_runtime::access::Caller;
use eos_runtime::http::Method;
use eos_surface::{Level, MadeBy, Place, VersionStatus};
use serde_json::{Value, json};

use crate::apps::{GAME, app};
use crate::rig::{Rig, surface, version};

const CALL: &str = "/api/surfaces/sf-app/app/call";

/// A routine whose project is a folder of the test's, with an App in use
/// that reads and writes its levels.
async fn in_use() -> (Rig, std::path::PathBuf) {
    let rig = Rig::new().await;
    rig.run_worker("rt-1", "Game", "rn-p", "project", "w-lead");
    let project = rig.dir.path().join("game");
    fs::create_dir_all(project.join("levels")).expect("levels");
    fs::write(project.join("levels/one.json"), r#"{"walls":3}"#).expect("a level");
    fs::write(project.join("secret.txt"), "not for the App").expect("a secret");
    let blueprint = json!({"project": {"repo": project.to_string_lossy()}}).to_string();
    rig.temp
        .port()
        .write(move |tx, _| {
            tx.routine_versions().insert(&StoredVersion {
                id: "rv-1".into(),
                routine_id: "rt-1".into(),
                parent_id: None,
                status: eos_contracts::VersionStatus::Kept,
                author: VersionAuthor::User,
                note: None,
                format: 1,
                blueprint,
                hash: "h".into(),
                no_trial: false,
                trust: Trust::Trusted,
                device: None,
                created_at: 1,
            })?;
            tx.routines().set_head("rt-1", "rv-1", 1)
        })
        .await
        .expect("a blueprint");
    let mut body = app(GAME);
    body["manifest"]["files"] = json!({"root": "project", "read": ["levels/*.json"], "write": ["levels/*.json"]});
    body["manifest"]["uses"] = json!(["probe.again", "probe.with"]);
    let mut v1 = version("sf-app", 1, VersionStatus::Kept);
    v1.made_by = MadeBy::Builder;
    v1.body_json = body.to_string();
    let mut app_surface = surface("sf-app", "rt-1", Level::App, Place::RoutinePage, 1);
    app_surface.current_version = Some(1);
    rig.seed(vec![app_surface], vec![v1], vec![]).await;
    (rig, project)
}

async fn call(rig: &Rig, name: &str, arguments: Value) -> (u16, Value) {
    rig.ask(Method::Post, CALL, Some(json!({"version": 1, "name": name, "arguments": arguments}))).await
}

/// A call a second after the last, under every rate limit.
async fn paced(rig: &Rig, name: &str, arguments: Value) -> (u16, Value) {
    rig.clock.advance(1_001);
    call(rig, name, arguments).await
}

#[tokio::test(flavor = "multi_thread")]
async fn a_declared_action_passes_the_gate_and_an_undeclared_one_is_refused() {
    let (rig, _) = in_use().await;
    let (status, answer) =
        rig.ask(Method::Post, CALL, Some(json!({"version": 1, "name": "probe.again", "clientId": "c-1"}))).await;
    assert_eq!((status, answer["result"]["status"].as_str()), (200, Some("done")), "{answer}");
    let heard = rig.heard.lock().expect("heard").clone();
    assert_eq!((heard.len(), heard[0].origin.as_str(), heard[0].routine_id.as_deref()), (1, "app", Some("rt-1")));
    assert_eq!(rig.gate.asked().last().map(|a| a.origin.clone()).as_deref(), Some("app"));

    // The same call again answers the first record and runs nothing.
    let (_, again) =
        rig.ask(Method::Post, CALL, Some(json!({"version": 1, "name": "probe.again", "clientId": "c-1"}))).await;
    assert_eq!(again["result"]["recordId"], answer["result"]["recordId"]);
    assert_eq!(rig.heard.lock().expect("heard").len(), 1);

    let (status, refused) = call(&rig, "probe.erase", json!({})).await;
    assert_eq!(status, 403, "{refused}");
    let (status, _) = call(&rig, "query.nobody.knows", json!({})).await;
    assert_eq!(status, 404);
    assert_eq!(rig.heard.lock().expect("heard").len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn what_the_gate_holds_is_held_and_arguments_are_typed() {
    let (rig, _) = in_use().await;
    rig.gate.set(ActionDecision::Hold { item_id: "it-1".into() });
    let (_, held) = call(&rig, "probe.again", json!({})).await;
    assert_eq!(held["result"]["status"], "held", "{held}");
    rig.gate.set(ActionDecision::Run);
    let (_, unfit) = call(&rig, "probe.with", json!({"item": "not a link"})).await;
    assert_eq!(unfit["result"]["status"], "refused", "{unfit}");
    assert!(rig.heard.lock().expect("heard").is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn its_query_is_read_for_its_routine_and_its_state_is_its_own() {
    let (rig, _) = in_use().await;
    let (status, answer) = call(&rig, "query.probe.count", json!({})).await;
    assert_eq!((status, answer["result"]["count"].as_i64()), (200, Some(1)), "{answer}");
    assert_eq!(rig.read.lock().expect("read")[0].routine_id.as_deref(), Some("rt-1"));

    let (status, saved) = call(&rig, "state.set", json!({"data": {"level": 2}})).await;
    assert_eq!(status, 200, "{saved}");
    let (_, read) = call(&rig, "state.get", json!({})).await;
    assert_eq!(read["result"]["data"], json!({"level": 2}));
    let (status, _) = call(&rig, "state.set", json!({"data": [1]})).await;
    assert_eq!(status, 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn files_are_only_the_ones_its_globs_name_below_its_root() {
    let (rig, project) = in_use().await;
    let outside = rig.dir.path().join("outside");
    fs::create_dir_all(&outside).expect("outside");
    fs::write(outside.join("key.json"), "{}").expect("a key");
    std::os::unix::fs::symlink(&outside, project.join("levels/out")).expect("a link");
    std::os::unix::fs::symlink(outside.join("key.json"), project.join("levels/key.json")).expect("a file link");

    let (_, listed) = paced(&rig, "files.list", json!({})).await;
    assert_eq!(listed["result"]["files"], json!(["levels/one.json"]), "{listed}");
    let (status, read) = paced(&rig, "files.read", json!({"path": "levels/one.json"})).await;
    assert_eq!((status, read["result"]["text"].as_str()), (200, Some(r#"{"walls":3}"#)));

    for path in ["../secret.txt", "/etc/hosts", "levels/../secret.txt", "secret.txt", "~/x.json"] {
        let (status, _) = paced(&rig, "files.read", json!({"path": path})).await;
        assert!(matches!(status, 400 | 403), "{path} answered {status}");
    }
    let (status, _) = paced(&rig, "files.read", json!({"path": "levels/key.json"})).await;
    assert_eq!(status, 400, "a link out of the root was followed");
    let (status, _) = paced(&rig, "files.write", json!({"path": "levels/key.json", "text": "x"})).await;
    assert_eq!(status, 400);
    assert_eq!(fs::read_to_string(outside.join("key.json")).expect("key"), "{}");

    let (status, wrote) = paced(&rig, "files.write", json!({"path": "levels/two.json", "text": "[]"})).await;
    assert_eq!((status, wrote["result"]["bytes"].as_u64()), (200, Some(2)), "{wrote}");
    assert_eq!(fs::read_to_string(project.join("levels/two.json")).expect("written"), "[]");
    let (status, _) = paced(&rig, "files.write", json!({"path": "notes.md", "text": "x"})).await;
    assert_eq!(status, 403);
    let big = "x".repeat(eos_surface::APP_FILE_BYTES + 1);
    let (status, _) = paced(&rig, "files.write", json!({"path": "levels/big.json", "text": big})).await;
    assert_eq!(status, 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn only_the_version_in_use_calls_and_never_too_often() {
    let (rig, _) = in_use().await;
    let (status, _) = rig.ask(Method::Post, CALL, Some(json!({"version": 2, "name": "state.get"}))).await;
    assert_eq!(status, 409);

    let mut statuses = Vec::new();
    for _ in 0..11 {
        statuses.push(call(&rig, "state.get", json!({})).await.0);
    }
    assert_eq!(statuses.iter().filter(|s| **s == 429).count(), 1, "{statuses:?}");
    rig.clock.advance(1_001);
    let mut written = Vec::new();
    for _ in 0..3 {
        written.push(call(&rig, "state.set", json!({"data": {}})).await.0);
    }
    assert_eq!(written, vec![200, 200, 429]);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_phone_cannot_call_and_with_apps_off_nothing_is_taken() {
    let (rig, _) = in_use().await;
    let body = json!({"version": 1, "name": "state.get"});
    let (status, _) = rig
        .ask_as(Caller::Phone { grant: eos_runtime::access::Tier::High, mutate: true }, Method::Post, CALL, Some(body))
        .await;
    assert_eq!(status, 403);
    rig.settings.0.lock().expect("settings").insert("genui.apps".into(), SettingValue::Flag(false));
    let (status, _) = call(&rig, "probe.again", json!({})).await;
    assert_eq!(status, 403);
    assert!(rig.heard.lock().expect("heard").is_empty());
}
