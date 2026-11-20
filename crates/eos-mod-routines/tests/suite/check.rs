//! The check station: the rules, the checker's verdict, a fail sent back to
//! the lead once, a checker that breaks, and the lead held meanwhile.

use eos_contracts::{CheckOutcome, CheckVerdict, RoutineState};
use eos_core::routine::{RunOrigin, SubmittedResult};
use eos_domain::routine::run::{Reason, RunState, Station};
use eos_runtime::module::Module;
use serde_json::{Value, json};

use crate::bench::{Bench, blueprint, new_run, pull_request};

/// PR Review with one check of its own.
fn checked() -> Value {
    let mut blueprint = blueprint(1);
    blueprint["how"]["checks"] = json!([{"key": "tests", "text": "Every finding names a test."}]);
    blueprint
}

fn review(headline: &str) -> SubmittedResult {
    SubmittedResult {
        kind: "github.review".into(),
        headline: headline.into(),
        body: json!({"summary": "SUMMARY-TEXT"}),
        files: vec![],
    }
}

fn verdict(pass: bool, must_fix: &[&str]) -> CheckVerdict {
    CheckVerdict {
        pass,
        checks: vec![CheckOutcome { key: "tests".into(), ok: pass, note: "n".into() }],
        must_fix: must_fix.iter().map(|point| (*point).to_owned()).collect(),
    }
}

/// A run whose lead works, and the lead.
async fn working(bench: &Bench, blueprint: Value) -> (String, String) {
    let routine = bench.routine(RoutineState::Active, blueprint);
    let id = bench.start(new_run(&routine, RunOrigin::Hand, Some(pull_request(3)))).await.expect("starts").remove(0).id;
    bench.supervise().await;
    bench.eventually(|| bench.run(&id).station == Some(Station::Work)).await;
    let lead = bench.run(&id).lead_id.expect("a lead");
    (id, lead)
}

/// The checker of the `n`th check (from 1) once it started.
async fn checker(bench: &Bench, n: usize) -> String {
    bench.eventually(|| bench.agents.started().iter().filter(|s| is_checker(s)).count() >= n).await;
    let started = bench.agents.started();
    started.iter().filter(|s| is_checker(s)).nth(n - 1).map(|s| s.worker_id.clone()).expect("a checker")
}

fn is_checker(spec: &eos_core::agent::LaunchSpec) -> bool {
    spec.worker_definition.as_deref() == Some("eos-run-checker")
}

fn verdicts(bench: &Bench, run: &str) -> Vec<Option<Value>> {
    let id = run.to_owned();
    let results = bench.temp.store.read_blocking(move |tx| tx.run_results().by_run(&id)).expect("reads");
    results.iter().map(|r| r.verdict.as_deref().map(|v| serde_json::from_str(v).expect("json"))).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_checker_reads_the_result_a_fail_goes_back_to_the_lead_once_and_the_lead_is_held_meanwhile() {
    let bench = Bench::new(true);
    let (run, lead) = working(&bench, checked()).await;
    let tools = bench.module.tools();
    tools.submit_result(&lead, review("First")).await.expect("handed in");
    assert!(bench.module.holds_worker(&lead), "held while its result is checked");

    let first = checker(&bench, 1).await;
    let spec = bench.agents.started().into_iter().find(|s| s.worker_id == first).expect("started");
    let brief = spec.prompt.expect("a brief");
    assert!(brief.contains("tests: Every finding names a test.") && brief.contains("SUMMARY-TEXT"), "{brief}");
    assert!(brief.contains("<untrusted source=\"github:pr:acme/game#3\">"), "{brief}");
    assert_eq!(spec.model, "sonnet");
    let id = first.clone();
    let session = bench.temp.store.read_blocking(move |tx| tx.routine_sessions().find(&id)).expect("reads");
    assert_eq!(session.map(|s| s.role).as_deref(), Some("checker"));
    let id = first.clone();
    let row = bench.temp.store.read_blocking(move |tx| tx.workers().find(&id)).expect("reads").expect("a row");
    let scope: eos_contracts::ToolScope =
        serde_json::from_str(row.tool_scope.as_deref().expect("a scope")).expect("json");
    assert!(scope.deny.iter().any(|tool| tool == "Edit") && scope.deny.iter().any(|tool| tool == "Write"), "{scope:?}");

    assert!(tools.submit_verdict(&lead, verdict(true, &[])).await.is_err(), "only the checker judges");
    tools.submit_verdict(&first, verdict(false, &["Add a test for the login."])).await.expect("judged");
    let back = bench.run(&run);
    assert_eq!((back.state, back.station, back.attempt), (RunState::Running, Some(Station::Work), 2));
    assert!(!bench.module.holds_worker(&lead), "let go with the state change");
    bench.eventually(|| bench.agents.sent(&lead).iter().any(|text| text.contains("Add a test for the login."))).await;
    assert_eq!(
        verdicts(&bench, &run),
        [Some(
            json!({"pass": false, "checks": [{"key": "tests", "ok": false, "note": "n"}], "mustFix": ["Add a test for the login."]})
        )]
    );

    tools.submit_result(&lead, review("Second")).await.expect("handed in again");
    let second = checker(&bench, 2).await;
    assert_ne!(first, second, "a new checker for the new round");
    assert!(tools.submit_verdict(&first, verdict(true, &[])).await.is_err(), "the old round's checker is done");
    tools.submit_verdict(&second, verdict(true, &[])).await.expect("judged");
    let verdicts = verdicts(&bench, &run);
    assert_eq!((verdicts.len(), verdicts[1].as_ref().map(|v| v["pass"].clone())), (2, Some(json!(true))));
}

#[tokio::test(flavor = "multi_thread")]
async fn two_failed_checks_fail_the_run_and_its_result_stays() {
    let bench = Bench::new(true);
    let (run, lead) = working(&bench, checked()).await;
    let tools = bench.module.tools();
    for round in 1..=2 {
        tools.submit_result(&lead, review("R")).await.expect("handed in");
        let checker = checker(&bench, round).await;
        tools.submit_verdict(&checker, verdict(false, &["No."])).await.expect("judged");
    }
    let failed = bench.run(&run);
    assert_eq!((failed.state, failed.reason), (RunState::Failed, Some(Reason::CheckFailed)));
    assert_eq!(verdicts(&bench, &run).len(), 2, "both results stay readable");
    assert!(!bench.module.holds_worker(&lead));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_checker_that_dies_is_started_again_once_then_the_run_fails() {
    let bench = Bench::new(true);
    let (run, lead) = working(&bench, checked()).await;
    bench.module.tools().submit_result(&lead, review("R")).await.expect("handed in");
    let first = checker(&bench, 1).await;
    bench.agents.settled().await;
    bench.agents.crash(&first).await;
    let second = checker(&bench, 2).await;
    assert_eq!(bench.state(&run), RunState::Checking);
    bench.agents.settled().await;
    bench.agents.crash(&second).await;
    bench.eventually(|| bench.state(&run) == RunState::Failed).await;
    assert_eq!(bench.run(&run).reason, Some(Reason::CheckError));
    assert!(!bench.module.holds_worker(&lead));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_result_the_rules_refuse_goes_back_without_a_checker() {
    let bench = Bench::new(true);
    let (run, lead) = working(&bench, checked()).await;
    let wrong = SubmittedResult { kind: "mail".into(), ..review("R") };
    bench.module.tools().submit_result(&lead, wrong).await.expect("handed in");
    bench.eventually(|| bench.state(&run) == RunState::Running).await;
    assert_eq!(bench.run(&run).attempt, 2);
    bench
        .eventually(|| {
            bench
                .agents
                .sent(&lead)
                .iter()
                .any(|t| t.contains("kind `mail`: this routine makes `github.review`; hand in kind `github.review`."))
        })
        .await;
    assert!(!bench.agents.started().iter().any(is_checker));
}

#[tokio::test(flavor = "multi_thread")]
async fn without_a_checker_the_rules_alone_pass_a_result() {
    let bench = Bench::new(true);
    let mut unchecked = checked();
    unchecked["how"]["checkAgent"] = json!(false);
    let (run, lead) = working(&bench, unchecked).await;
    bench.module.tools().submit_result(&lead, review("R")).await.expect("handed in");
    bench.eventually(|| verdicts(&bench, &run).first().is_some_and(Option::is_some)).await;
    assert_eq!(verdicts(&bench, &run)[0].as_ref().map(|v| v["pass"].clone()), Some(json!(true)));
    assert!(!bench.agents.started().iter().any(is_checker));
}
