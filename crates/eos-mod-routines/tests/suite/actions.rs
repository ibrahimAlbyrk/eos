//! A routine's surface acts on its routine through the direct-action
//! registry: run again, run on an item, open a run, and read how the
//! routine stands and its last runs. Nothing reaches another routine.

use eos_contracts::RoutineState;
use eos_runtime::actions::{ActionCall, ActionDecl, ActionFailure, QueryCall, QueryDecl};
use eos_runtime::module::Module;
use serde_json::{Value, json};

use crate::bench::{Bench, blueprint};

/// A routine that runs with no item too.
fn itemless() -> Value {
    let mut bp = blueprint(2);
    bp["takes"]["empty"] = json!("none");
    bp
}

fn action(bench: &Bench, id: &str) -> ActionDecl {
    bench.module.direct_actions().into_iter().find(|a| a.id == id).expect("declared")
}

fn query(bench: &Bench, id: &str) -> QueryDecl {
    bench.module.surface_queries().into_iter().find(|q| q.id == id).expect("declared")
}

fn call(id: &str, routine: Option<&str>, args: Value, record: &str) -> ActionCall {
    ActionCall {
        action_id: id.into(),
        routine_id: routine.map(str::to_owned),
        args,
        origin: "dashboard".into(),
        record_id: record.into(),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_surface_runs_its_routine_again_or_on_an_item_once_per_press() {
    let bench = Bench::new(false);
    let routine = bench.routine(RoutineState::Active, itemless());
    let again = action(&bench, "routine.run_again");
    let started =
        again.handler.run(call("routine.run_again", Some(&routine), json!({}), "da-1")).await.expect("started");
    let first = started["runIds"][0].as_str().expect("a run").to_owned();
    let run = bench.run(&first);
    assert_eq!((run.origin.as_str(), run.door.as_deref()), ("hand", Some("surface")));
    let repeat = again.handler.run(call("routine.run_again", Some(&routine), json!({}), "da-1")).await.expect("same");
    assert_eq!(repeat["runIds"][0], first, "the same press starts nothing more");

    let with = action(&bench, "routine.run_with");
    let args = json!({"item": "https://example.com/post", "note": "Short"});
    let on_item = with.handler.run(call("routine.run_with", Some(&routine), args, "da-2")).await.expect("started");
    let run = bench.run(on_item["runIds"][0].as_str().expect("a run"));
    let input: Value = serde_json::from_str(&run.input).expect("json");
    assert_eq!(
        (input["item"]["url"].as_str(), input["item"]["untrusted"].as_bool()),
        (Some("https://example.com/post"), Some(true))
    );
    assert_eq!(input["note"], "Short");

    let nowhere = again.handler.run(call("routine.run_again", None, json!({}), "da-3")).await;
    assert_eq!(nowhere.expect_err("refused").kind, "out_of_scope");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_surface_opens_and_reads_only_its_own_routines_runs() {
    let bench = Bench::new(false);
    let mine = bench.routine(RoutineState::Active, itemless());
    let theirs = bench.routine(RoutineState::Active, itemless());
    let run = bench.hand(&mine, None).await;
    let other = bench.hand(&theirs, None).await;

    let open = action(&bench, "routine.open_run");
    let opened = open.handler.run(call("routine.open_run", Some(&mine), json!({"run": run}), "da-1")).await;
    assert_eq!(opened, Ok(json!({"open": format!("eos:run/{run}")})));
    let refused = open.handler.run(call("routine.open_run", Some(&mine), json!({"run": other}), "da-2")).await;
    assert_eq!(refused, Err(ActionFailure::new("not_found", "That run is not this routine's")));

    let read =
        |id: &str, routine: &str| QueryCall { query_id: id.into(), routine_id: Some(routine.into()), args: json!({}) };
    let status = query(&bench, "routine.status").handler.read(read("routine.status", &mine)).await.expect("read");
    assert_eq!((status["state"].as_str(), status["last"]["id"].as_str()), (Some("active"), Some(run.as_str())));
    let runs = query(&bench, "routine.runs").handler.read(read("routine.runs", &mine)).await.expect("read");
    let ids: Vec<&str> = runs["runs"].as_array().expect("runs").iter().filter_map(|r| r["id"].as_str()).collect();
    assert_eq!(ids, [run.as_str()], "only its own");
}
