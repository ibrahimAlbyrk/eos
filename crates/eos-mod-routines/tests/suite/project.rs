//! A project run: milestone by milestone through the check and the gate,
//! each with its own check rounds, back to work after each until the last.

use eos_contracts::{CheckVerdict, RoutineState};
use eos_core::routine::{MilestoneDone, RunOrigin, SubmittedResult};
use eos_domain::routine::numbers::Outcome;
use eos_domain::routine::run::{RunState, Station};
use serde_json::{Value, json};

use crate::bench::{Bench, blueprint, new_run};

/// A solo project in two milestones, its result checked by a checker.
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

fn checkers(bench: &Bench) -> Vec<String> {
    let started = bench.agents.started();
    started
        .iter()
        .filter(|s| s.worker_definition.as_deref() == Some("eos-run-checker"))
        .map(|s| s.worker_id.clone())
        .collect()
}

fn done(key: &str) -> MilestoneDone {
    MilestoneDone { key: key.into(), summary: format!("{key} works."), files: vec![] }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_project_goes_milestone_by_milestone_through_check_and_gate_until_the_last() {
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

    let pass = CheckVerdict { pass: true, checks: vec![], must_fix: vec![] };
    let fail = CheckVerdict { pass: false, checks: vec![], must_fix: vec!["Add a test.".into()] };
    tools.complete_milestone(&lead, done("login")).await.expect("handed in");
    bench.eventually(|| checkers(&bench).len() == 1).await;
    tools.submit_verdict(&checkers(&bench)[0], pass.clone()).await.expect("judged");
    bench.eventually(|| bench.run(&run).progress_done == Some(1)).await;
    let back = bench.run(&run);
    assert_eq!((back.state, back.station, back.attempt), (RunState::Running, Some(Station::Work), 2));
    bench.eventually(|| bench.agents.sent(&lead).iter().any(|text| text.contains("next milestone, `shop`"))).await;

    // The second milestone has two check rounds of its own.
    tools.complete_milestone(&lead, done("shop")).await.expect("handed in");
    bench.eventually(|| checkers(&bench).len() == 2).await;
    tools.submit_verdict(&checkers(&bench)[1], fail).await.expect("judged");
    bench.eventually(|| bench.state(&run) == RunState::Running).await;
    tools.complete_milestone(&lead, done("shop")).await.expect("handed in again");
    bench.eventually(|| checkers(&bench).len() == 3).await;
    tools.submit_verdict(&checkers(&bench)[2], pass).await.expect("judged");
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
    assert_eq!(headlines, ["The login screen", "The shop", "The shop"]);
}
