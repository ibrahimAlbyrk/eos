//! A checked result at the gate: what the gate is given, each of its
//! decisions, a result with nothing to send, the show-only gate, and what
//! Needs you reports afterwards.

use eos_contracts::{CheckVerdict, RoutineState};
use eos_core::routine::{GateDecision, GateMode, RunOrigin, SubmittedResult};
use eos_domain::routine::numbers::Outcome;
use eos_domain::routine::run::{Reason, RunState, Station};
use eos_domain::run_scope::Trust;
use eos_runtime::module::Module;
use serde_json::{Value, json};

use crate::bench::{Bench, blueprint, new_run, pull_request};

fn unchecked() -> Value {
    let mut blueprint = blueprint(1);
    blueprint["how"]["checkAgent"] = json!(false);
    blueprint
}

fn review() -> SubmittedResult {
    let doc = json!({"kind": "github.review", "channel": "github", "action": "post_review",
                     "parts": [{"key": "summary", "role": "summary", "text": "Fine."}]});
    SubmittedResult { kind: "github.review".into(), headline: "Fine".into(), body: doc, files: vec![] }
}

async fn working(bench: &Bench, blueprint: Value) -> (String, String) {
    let routine = bench.routine(RoutineState::Active, blueprint);
    let id = bench.start(new_run(&routine, RunOrigin::Hand, Some(pull_request(5)))).await.expect("starts").remove(0).id;
    bench.supervise().await;
    bench.eventually(|| bench.run(&id).station == Some(Station::Work)).await;
    let lead = bench.run(&id).lead_id.expect("a lead");
    (id, lead)
}

fn checker(bench: &Bench, n: usize) -> Option<String> {
    let started = bench.agents.started();
    let mut checkers = started.iter().filter(|s| s.worker_definition.as_deref() == Some("eos-run-checker"));
    checkers.nth(n - 1).map(|s| s.worker_id.clone())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_result_that_fails_its_check_once_then_passes_reaches_the_gate_once_and_is_held() {
    let bench = Bench::new(true);
    let (run, lead) = working(&bench, blueprint(1)).await;
    let tools = bench.module.tools();
    bench.gate.decide(GateDecision::Held { item_id: "in-1".into() });
    let fail = CheckVerdict { pass: false, checks: vec![], must_fix: vec!["Shorter.".into()] };
    let pass = CheckVerdict { pass: true, checks: vec![], must_fix: vec![] };
    for (round, verdict) in [(1, fail), (2, pass)] {
        tools.submit_result(&lead, review()).await.expect("handed in");
        bench.eventually(|| checker(&bench, round).is_some()).await;
        let checker = checker(&bench, round).expect("a checker");
        tools.submit_verdict(&checker, verdict).await.expect("judged");
    }

    let inputs = bench.gate.inputs();
    assert_eq!(inputs.len(), 1, "only the passed result reaches the gate");
    let input = &inputs[0];
    assert_eq!(
        (input.run_id.as_str(), input.result_mode, input.trust),
        (run.as_str(), GateMode::AsUsual, Trust::Untrusted)
    );
    assert_eq!((input.doc.kind.as_str(), input.doc.parts[0].text.as_str()), ("github.review", "Fine."));
    assert_eq!(input.subject_key.as_deref(), Some("github:pr:acme/game#5"));
    assert!(input.freedom_confirmed.is_some(), "the user's own version");
    let held = bench.run(&run);
    assert_eq!((held.state, held.station), (RunState::WaitingForUser, Some(Station::Gate)));
    assert!(!bench.module.holds_worker(&lead), "let go as the run left its check");
    let id = run.clone();
    let events = bench.temp.store.read_blocking(move |tx| tx.runs().events(&id)).expect("reads");
    assert!(events.iter().any(|e| e.kind == "held" && e.data.as_deref() == Some(r#"{"itemId":"in-1"}"#)));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_result_with_nothing_to_send_skips_the_check_and_the_gate() {
    let bench = Bench::new(true);
    let (run, lead) = working(&bench, blueprint(1)).await;
    let nothing =
        SubmittedResult { kind: "nothing".into(), headline: "Quiet today".into(), body: json!("-"), files: vec![] };
    bench.module.tools().submit_result(&lead, nothing).await.expect("handed in");
    bench.eventually(|| bench.state(&run) == RunState::Done).await;
    assert_eq!(bench.run(&run).outcome, Some(Outcome::Nothing));
    assert!(bench.gate.inputs().is_empty() && checker(&bench, 1).is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_shown_result_ends_the_run_and_a_sending_gate_hands_it_to_delivery() {
    let bench = Bench::new(true);
    let (run, lead) = working(&bench, unchecked()).await;
    bench.module.tools().submit_result(&lead, review()).await.expect("handed in");
    bench.eventually(|| bench.state(&run) == RunState::Done).await;
    assert_eq!(bench.run(&run).outcome, Some(Outcome::Shown));

    let bench = Bench::new(true);
    bench.gate.decide(GateDecision::Delivering { delivery_ids: vec!["dl-1".into()] });
    let (run, lead) = working(&bench, unchecked()).await;
    bench.module.tools().submit_result(&lead, review()).await.expect("handed in");
    bench.eventually(|| bench.state(&run) == RunState::Delivering).await;
    assert_eq!((bench.run(&run).station, bench.gate.deliveries()), (Some(Station::Deliver), 1));
}

#[tokio::test(flavor = "multi_thread")]
async fn needs_you_reports_what_became_of_a_result_inside_its_own_writes() {
    let bench = Bench::new(true);
    bench.gate.decide(GateDecision::Held { item_id: "in-1".into() });
    let (run, lead) = working(&bench, unchecked()).await;
    bench.module.tools().submit_result(&lead, review()).await.expect("handed in");
    bench.eventually(|| bench.state(&run) == RunState::WaitingForUser).await;
    let outcomes = bench.module.outcomes();

    let id = run.clone();
    let revise = outcomes.clone();
    bench.temp.store.write_blocking(move |tx, out| revise.revise(tx, out, &id, "Say it shorter.")).expect("writes");
    assert_eq!((bench.state(&run), bench.run(&run).station), (RunState::Running, Some(Station::Work)));
    bench.eventually(|| bench.agents.sent(&lead).iter().any(|text| text.contains("Say it shorter."))).await;

    let id = run.clone();
    let finish = outcomes.clone();
    bench
        .temp
        .store
        .write_blocking(move |tx, out| {
            let moved = tx.runs().find(&id)?.expect("a run");
            let check = eos_core::store::RunMove {
                state: RunState::Checking,
                station: Some(Station::Check),
                reason: None,
                at: 1,
            };
            tx.runs().move_to(&moved.id, &check)?;
            finish.held(tx, out, &id, "in-2")?;
            finish.delivering(tx, out, &id)?;
            finish.finished(tx, out, &id, Outcome::SentUnedited)
        })
        .expect("writes");
    let done = bench.run(&run);
    assert_eq!((done.state, done.outcome), (RunState::Done, Some(Outcome::SentUnedited)));

    let failing = Bench::new(true);
    failing.gate.decide(GateDecision::Delivering { delivery_ids: vec!["dl-1".into()] });
    let (run, lead) = working(&failing, unchecked()).await;
    failing.module.tools().submit_result(&lead, review()).await.expect("handed in");
    failing.eventually(|| failing.state(&run) == RunState::Delivering).await;
    let id = run.clone();
    let outcomes = failing.module.outcomes();
    failing.temp.store.write_blocking(move |tx, out| outcomes.delivery_failed(tx, out, &id, "auth")).expect("writes");
    assert_eq!(failing.run(&run).reason, Some(Reason::Delivery));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_send_held_again_puts_its_delivering_run_back_to_waiting_for_the_user() {
    let bench = Bench::new(true);
    bench.gate.decide(GateDecision::Delivering { delivery_ids: vec!["dl-1".into()] });
    let (run, lead) = working(&bench, unchecked()).await;
    bench.module.tools().submit_result(&lead, review()).await.expect("handed in");
    bench.eventually(|| bench.state(&run) == RunState::Delivering).await;
    let (id, outcomes) = (run.clone(), bench.module.outcomes());
    bench.temp.store.write_blocking(move |tx, out| outcomes.held(tx, out, &id, "in-2")).expect("writes");
    let held = bench.run(&run);
    assert_eq!((held.state, held.station), (RunState::WaitingForUser, Some(Station::Gate)));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_result_taken_back_after_its_run_ended_changes_the_runs_outcome() {
    let bench = Bench::new(true);
    bench.gate.decide(GateDecision::Delivering { delivery_ids: vec!["dl-1".into()] });
    let (run, lead) = working(&bench, unchecked()).await;
    bench.module.tools().submit_result(&lead, review()).await.expect("handed in");
    bench.eventually(|| bench.state(&run) == RunState::Delivering).await;
    let (id, outcomes) = (run.clone(), bench.module.outcomes());
    bench
        .temp
        .store
        .write_blocking(move |tx, out| {
            outcomes.finished(tx, out, &id, Outcome::AutoSent)?;
            outcomes.finished(tx, out, &id, Outcome::Undone)
        })
        .expect("writes");
    let undone = bench.run(&run);
    assert_eq!((undone.state, undone.outcome), (RunState::Done, Some(Outcome::Undone)));
}
