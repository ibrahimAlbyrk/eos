//! A project run: milestone by milestone through the gate, back to work
//! after each until the last;
//! a hand start under way is a message; sessions idle while it waits are suspended; a copy
//! takes a brief of its own.

use eos_contracts::{RoutineState, WorkerState};
use eos_core::routine::{GateDecision, MilestoneDone, RunOrigin, SubmittedResult};
use eos_domain::routine::numbers::Outcome;
use eos_domain::routine::run::{RunState, Station};
use serde_json::{Value, json};

use eos_runtime::module::Module;

use crate::bench::{Bench, blueprint, new_run};

/// A solo project in two milestones.
pub(crate) fn project() -> Value {
    let mut project = blueprint(1);
    project["name"] = json!("Game app");
    project["kind"] = json!("project");
    project["takes"] = json!({"kind": "none", "label": "nothing", "placeholder": "", "empty": "none", "many": false});
    project["when"] = json!({"on": []});
    project["makes"] = json!({"kind": "report", "description": "What was built."});
    project["project"] = json!({"repo": "/tmp/game", "baseBranch": "main", "brief": "Build the game's app.",
    "milestones": [
        {"key": "login", "title": "The login screen", "doneWhen": "a user can sign in"},
        {"key": "shop", "title": "The shop", "doneWhen": "a user can buy a skin"},
    ]});
    project
}

fn done(key: &str) -> MilestoneDone {
    MilestoneDone { key: key.into(), summary: format!("{key} works."), files: vec![] }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_project_goes_milestone_by_milestone_through_the_gate_until_the_last() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, project());
    let run = bench.start(new_run(&routine, RunOrigin::Hand, None)).await.expect("starts").remove(0).id;
    bench.supervise().await;
    bench.eventually(|| bench.run(&run).station == Some(Station::Work)).await;
    let lead = bench.run(&run).lead_id.expect("a lead");
    let brief = bench.agents.started()[0].prompt.clone().expect("the brief");
    assert!(brief.contains("`login`: The login screen. Done when: a user can sign in"), "{brief}");
    assert!(brief.contains("No cap per run"), "{brief}");
    assert_eq!((bench.run(&run).progress_done, bench.run(&run).progress_total), (Some(0), Some(2)));

    let tools = bench.module.tools();
    let result = SubmittedResult { kind: "report".into(), headline: "h".into(), body: json!("b"), files: vec![] };
    assert!(tools.submit_result(&lead, result).await.is_err(), "a project hands in milestones");
    assert!(tools.complete_milestone(&lead, done("shop")).await.is_err(), "only the milestone at work");

    tools.complete_milestone(&lead, done("login")).await.expect("handed in");
    bench.eventually(|| bench.run(&run).progress_done == Some(1)).await;
    let back = bench.run(&run);
    assert_eq!((back.state, back.station, back.attempt), (RunState::Running, Some(Station::Work), 2));
    bench.eventually(|| bench.agents.sent(&lead).iter().any(|text| text.contains("next milestone, `shop`"))).await;
    assert!(!bench.module.holds_worker(&lead), "let go once told");

    tools.complete_milestone(&lead, done("shop")).await.expect("handed in");
    bench.eventually(|| bench.state(&run) == RunState::Done).await;
    let ended = bench.run(&run);
    assert_eq!((ended.outcome, ended.progress_done, ended.progress_total), (Some(Outcome::Shown), Some(2), Some(2)));
    let headlines: Vec<String> = bench
        .temp
        .store
        .read_blocking(move |tx| tx.run_results().by_run(&run))
        .expect("reads")
        .into_iter()
        .map(|r| r.headline)
        .collect();
    assert_eq!(headlines, ["The login screen", "The shop"]);
}

fn worker_state(bench: &Bench, worker: &str) -> WorkerState {
    let id = worker.to_owned();
    bench.temp.store.read_blocking(move |tx| tx.workers().find(&id)).expect("reads").expect("a row").state
}

/// A project run whose lead works on its first milestone.
async fn at_work(bench: &Bench) -> (String, String, String) {
    let routine = bench.routine(RoutineState::Active, project());
    let run = bench.start(new_run(&routine, RunOrigin::Hand, None)).await.expect("starts").remove(0).id;
    bench.supervise().await;
    bench.eventually(|| bench.run(&run).station == Some(Station::Work)).await;
    let lead = bench.run(&run).lead_id.expect("a lead");
    (routine, run, lead)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_hand_start_of_a_project_under_way_is_a_message_to_its_team() {
    let bench = Bench::new(true);
    let (routine, run, lead) = at_work(&bench).await;
    let mut again = new_run(&routine, RunOrigin::Hand, None);
    again.input.note = Some("Use the blue theme.".into());
    let told = bench.start(again).await.expect("taken");
    assert_eq!(told.iter().map(|created| created.id.as_str()).collect::<Vec<_>>(), [run.as_str()], "no second run");
    bench.eventually(|| bench.agents.sent(&lead).iter().any(|text| text.contains("Use the blue theme."))).await;
    let id = routine.clone();
    let runs = bench.temp.store.read_blocking(move |tx| tx.runs().by_routine(&id, 10)).expect("reads");
    assert_eq!(runs.len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_sessions_of_a_project_waiting_on_the_user_for_half_an_hour_are_suspended() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, project());
    let run = bench.start(new_run(&routine, RunOrigin::Hand, None)).await.expect("starts").remove(0).id;
    bench.supervise().await;
    bench.eventually(|| bench.run(&run).station == Some(Station::Work)).await;
    let lead = bench.run(&run).lead_id.expect("a lead");
    let id = lead.clone();
    bench.temp.store.write_blocking(move |tx, _| tx.workers().update_state(&id, WorkerState::Idle)).expect("writes");
    let turn = || async {
        bench.eventually(|| !bench.sleeper.pending().is_empty()).await;
        assert!(bench.sleeper.wake());
        bench.eventually(|| !bench.sleeper.pending().is_empty()).await;
    };
    bench.clock.advance(31 * 60_000);
    turn().await;
    assert_eq!(worker_state(&bench, &lead), WorkerState::Idle, "a lead at work is never suspended");

    bench.gate.decide(GateDecision::Held { item_id: "in-1".into() });
    bench.module.tools().complete_milestone(&lead, done("login")).await.expect("handed in");
    bench.eventually(|| bench.state(&run) == RunState::WaitingForUser).await;
    let id = lead.clone();
    bench.temp.store.write_blocking(move |tx, _| tx.workers().update_state(&id, WorkerState::Idle)).expect("writes");
    bench.clock.advance(29 * 60_000);
    turn().await;
    assert_eq!(worker_state(&bench, &lead), WorkerState::Idle, "not yet");
    bench.clock.advance(2 * 60_000);
    turn().await;
    bench.eventually(|| worker_state(&bench, &lead) == WorkerState::Suspended).await;
    assert_eq!(bench.state(&run), RunState::WaitingForUser, "the run itself waits on");
}

#[tokio::test(flavor = "multi_thread")]
async fn start_another_like_this_copies_a_project_with_a_brief_of_its_own() {
    let routes = crate::run_routes::Routes::new();
    let routine = routes.bench.routine(RoutineState::Active, project());
    let (status, copy) =
        routes.post(&format!("/api/routines/{routine}/copy"), json!({"brief": "Build the shop's app."})).await;
    assert_eq!(status, 201, "{copy}");
    let version = copy["versionId"].as_str().expect("a version").to_owned();
    let copied = copy["row"]["id"].as_str().expect("an id").to_owned();
    let stored = routes
        .bench
        .temp
        .store
        .read_blocking(move |tx| tx.routine_versions().find(&copied, &version))
        .expect("reads")
        .expect("the copy's version");
    let blueprint: Value = serde_json::from_str(&stored.blueprint).expect("json");
    assert_eq!(blueprint["project"]["brief"], "Build the shop's app.");
    assert_eq!(blueprint["project"]["milestones"], project()["project"]["milestones"]);
}
