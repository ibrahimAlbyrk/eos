//! What of routines follows the user to their other computers: a routine
//! and its kept versions land on the second computer as they were made,
//! a kept version never changes, a newer format is kept but not run, and
//! built-in routines, drafts and trials stay. Finished runs travel as
//! summaries for 30 days. A routine exported to a file imports anywhere
//! as a draft.

use std::sync::Arc;

use eos_contracts::RoutineState;
use eos_core::Clock;
use eos_core::net::sync::RecordSync;
use eos_core::store::{RunMove, StoredRun};
use eos_domain::routine::blueprint::hash;
use eos_domain::routine::run::RunState;
use eos_domain::sync::SyncItem;
use eos_runtime::access::Caller;
use eos_runtime::http::{Method, Request};
use eos_runtime::module::Module;
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use serde_json::{Value, json};

use crate::bench::{Bench, blueprint};

const DAY: i64 = 24 * 60 * 60 * 1000;

fn records(bench: &Bench, domain: &str) -> Arc<dyn RecordSync> {
    let contribution = bench.module.sync().into_iter().find(|c| c.domain == domain).expect("the domain");
    contribution.handle.downcast_ref::<Arc<dyn RecordSync>>().expect("a record handle").clone()
}

async fn carry(from: &Bench, to: &Bench, domain: &str) -> Vec<SyncItem> {
    let items = records(from, domain).list().await.expect("lists");
    let into = records(to, domain);
    for item in &items {
        into.apply(&item.id, &item.data).await.expect("applies");
    }
    items
}

async fn ask(bench: &Bench, path: &str) -> (u16, Value) {
    let module: Arc<dyn Module> = bench.module.clone();
    let runtime =
        Runtime::build(Kernel::new(KernelOptions::default()), vec![module], Arc::new(AllPluginsOn)).expect("composes");
    let response = runtime.router.handle(Request::new(Method::Get, path, Caller::DASHBOARD)).await;
    let status = response.status;
    let bytes = response.body.collect().await.expect("a body");
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

#[tokio::test]
async fn a_routine_and_its_kept_versions_land_on_the_other_computer_as_they_were_made() {
    let (air, pro) = (Bench::new(false), Bench::new(false));
    let id = air.routine(RoutineState::Active, blueprint(1));
    let items = carry(&air, &pro, "routine").await;
    let ids: Vec<&str> = items.iter().map(|item| item.id.as_str()).collect();
    assert_eq!(ids.len(), 2);
    assert!(ids[0].starts_with(&format!("{id}/")) && ids[1] == id, "the version before the routine: {ids:?}");

    let landed = pro.temp.store.read_blocking({
        let id = id.clone();
        move |tx| tx.routines().find(&id)
    });
    let landed = landed.expect("reads").expect("landed");
    assert_eq!((landed.origin.as_str(), landed.state), ("sync", RoutineState::Active));
    assert_eq!(records(&pro, "routine").list().await.expect("lists"), items, "the same records on both");
    let (status, list) = ask(&pro, "/api/routines").await;
    assert_eq!((status, list[0]["id"].as_str()), (200, Some(id.as_str())), "{list}");
    let announced = pro.temp.announced.list();
    assert!(announced.iter().any(|(topic, payload)| *topic == "routine:change" && payload.contains(&id)), "announced");

    // Paused there, paused here.
    let mut routine = items[1].data.clone();
    routine["state"] = json!("paused");
    routine["changedAt"] = json!(5_000);
    records(&pro, "routine").apply(&id, &routine).await.expect("applies");
    let got = records(&pro, "routine").get(&id).await.expect("reads").expect("there");
    assert_eq!((got.data["state"].clone(), got.updated_at), (json!("paused"), Some(5_000.0)));
}

#[tokio::test]
async fn a_kept_version_never_changes_and_a_newer_format_is_kept_but_not_runnable() {
    let (air, pro) = (Bench::new(false), Bench::new(false));
    let id = air.routine(RoutineState::Active, blueprint(1));
    let items = carry(&air, &pro, "routine").await;
    let into = records(&pro, "routine");
    let mut changed = items[0].data.clone();
    let text = r#"{"format":1,"name":"Changed"}"#;
    (changed["blueprint"], changed["hash"]) = (json!(text), json!(hash(text)));
    assert!(into.apply(&items[0].id, &changed).await.is_err(), "a kept version never changes");
    let mut forged = items[0].data.clone();
    forged["hash"] = json!("0000");
    assert!(into.apply(&format!("{id}/rv-other"), &forged).await.is_err(), "a hash that does not match");

    let newer = r#"{"format":99,"name":"PR Review","when":{"on":[]}}"#;
    let mut version = items[0].data.clone();
    (version["blueprint"], version["hash"], version["format"]) = (json!(newer), json!(hash(newer)), json!(99));
    into.apply(&format!("{id}/rv-newer"), &version).await.expect("kept");
    let mut routine = items[1].data.clone();
    (routine["head"], routine["changedAt"]) = (json!("rv-newer"), json!(9_000));
    into.apply(&id, &routine).await.expect("applies");
    let (status, versions) = ask(&pro, &format!("/api/routines/{id}/versions")).await;
    assert_eq!(status, 200, "{versions}");
    let runnable: Vec<Value> = versions.as_array().into_iter().flatten().map(|v| v["runnable"].clone()).collect();
    assert!(runnable.contains(&json!(false)), "{versions}");
    let (status, detail) = ask(&pro, &format!("/api/routines/{id}")).await;
    assert_eq!(status, 200, "readable: {detail}");

    let mut unknown = items[1].data.clone();
    unknown["state"] = json!("hibernating");
    assert!(into.apply(&id, &unknown).await.is_err(), "a word this app does not know is refused");
}

#[tokio::test]
async fn built_in_routines_drafts_and_trials_never_travel() {
    let air = Bench::new(false);
    let draft = air.routine(RoutineState::Draft, blueprint(1));
    let builtin = air.routine(RoutineState::Active, blueprint(1));
    air.temp.exec(&format!("UPDATE routines SET origin = 'builtin' WHERE id = '{builtin}'"));
    let items = records(&air, "routine").list().await.expect("lists");
    assert!(items.iter().all(|item| !item.id.starts_with(&draft) && !item.id.starts_with(&builtin)), "{items:?}");
    let as_builtin = json!({"slug": "forge", "name": "Forge", "kind": "standing", "state": "active",
        "pausedReason": null, "head": "rv-x", "agentsMayStart": false, "createdAt": 1, "changedAt": 2,
        "deletedAt": null});
    assert!(records(&air, "routine").apply(&builtin, &as_builtin).await.is_err());
}

fn finished(
    id: &str,
    routine_id: &str,
    kind: &str,
    ended_at: i64,
) -> impl FnOnce(&dyn eos_core::store::Tx, &mut eos_core::store::Outbox) -> Result<(), eos_core::Error> + Send + 'static
{
    let (id, routine_id, kind) = (id.to_owned(), routine_id.to_owned(), kind.to_owned());
    move |tx, _| {
        tx.runs().insert(&StoredRun {
            id: id.clone(),
            routine_id,
            version_id: None,
            kind,
            origin: "hand".into(),
            origin_ref: None,
            door: None,
            input: r#"{"result":"usual"}"#.into(),
            item_key: None,
            state: RunState::Queued,
            station: None,
            reason: None,
            attempt: 1,
            resumed: 0,
            not_before: None,
            priority: 0,
            progress_done: None,
            progress_total: None,
            headline: Some("Reviewed #12".into()),
            outcome: None,
            cost_usd: 0.4,
            work_ms: 60_000,
            lead_id: None,
            device: "mac-1".into(),
            remote: false,
            created_at: ended_at - 60_000,
            started_at: None,
            ended_at: None,
            updated_at: ended_at,
        })?;
        tx.runs().move_to(&id, &RunMove { state: RunState::Done, station: None, reason: None, at: ended_at }).map(drop)
    }
}

#[tokio::test]
async fn finished_runs_travel_as_summaries_for_thirty_days_and_trials_stay() {
    let (air, pro) = (Bench::new(false), Bench::new(false));
    let id = air.routine(RoutineState::Active, blueprint(1));
    carry(&air, &pro, "routine").await;
    let now = air.clock.now_ms();
    air.temp.store.write_blocking(finished("rn-a", &id, "standing", now - DAY)).expect("writes");
    air.temp.store.write_blocking(finished("rn-t", &id, "trial", now - DAY)).expect("writes");
    let items = carry(&air, &pro, "run").await;
    assert_eq!(items.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(), ["rn-a"]);
    assert_eq!((items[0].data["device"].clone(), items[0].data.get("result")), (json!("mac-1"), None));

    let (_, detail) = ask(&pro, &format!("/api/routines/{id}")).await;
    let shown = &detail["runs"][0];
    assert_eq!((shown["id"].clone(), shown["headline"].clone()), (json!("rn-a"), json!("Reviewed #12")), "{detail}");
    assert_eq!(pro.temp.count("SELECT count(*) FROM runs"), 0, "never a run of this computer's");
    assert_eq!(records(&pro, "run").list().await.expect("lists"), items, "listed again as it came");

    // Thirty days on, neither computer lists it: the vault lets it go.
    air.clock.advance(30 * DAY);
    pro.clock.advance(30 * DAY);
    assert!(records(&air, "run").list().await.expect("lists").is_empty());
    assert!(records(&pro, "run").list().await.expect("lists").is_empty());
    records(&pro, "run").remove("rn-a").await.expect("removes");
    assert_eq!(pro.temp.count("SELECT count(*) FROM synced_runs"), 0);
}

#[tokio::test]
async fn a_routine_exported_to_a_file_imports_on_any_computer_as_a_draft() {
    let (air, pro) = (Bench::new(false), Bench::new(false));
    let id = air.routine(RoutineState::Active, blueprint(1));
    let module: Arc<dyn Module> = air.module.clone();
    let runtime =
        Runtime::build(Kernel::new(KernelOptions::default()), vec![module], Arc::new(AllPluginsOn)).expect("composes");
    let response = runtime
        .router
        .handle(Request::new(Method::Get, &format!("/api/routines/{id}/export"), Caller::DASHBOARD))
        .await;
    assert_eq!(response.status, 200);
    let file: Value = serde_json::from_slice(&response.body.collect().await.expect("a body")).expect("json");
    assert_eq!((file["format"].clone(), file["routine"]["name"].clone()), (json!(1), json!("PR Review")));
    assert!(file.get("runs").is_none(), "no runs in a shared file");

    let module: Arc<dyn Module> = pro.module.clone();
    let runtime =
        Runtime::build(Kernel::new(KernelOptions::default()), vec![module], Arc::new(AllPluginsOn)).expect("composes");
    let import = Request::new(Method::Post, "/api/routines/import", Caller::DASHBOARD).body(file.to_string());
    let response = runtime.router.handle(import).await;
    assert_eq!(response.status, 201);
    let saved: Value = serde_json::from_slice(&response.body.collect().await.expect("a body")).expect("json");
    assert_eq!((saved["row"]["state"].clone(), saved["row"]["name"].clone()), (json!("draft"), json!("PR Review")));
    let origin = pro.temp.store.read_blocking(|tx| Ok(tx.routines().list()?.pop().map(|r| r.origin))).expect("reads");
    assert_eq!(origin.as_deref(), Some("import"));

    let refused = Request::new(Method::Post, "/api/routines/import", Caller::DASHBOARD).body(r#"{"format":7}"#);
    assert_eq!(runtime.router.handle(refused).await.status, 400);
}
