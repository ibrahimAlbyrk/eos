//! After Eos restarts: a working run picks up once and fails the second
//! time, a run found at its check goes on to the gate, a queued run more
//! than a day late is skipped; a run whose routine was switched off before
//! it started never starts; an ended run's sessions are suspended.

use eos_contracts::{RoutineState, WorkerState};
use eos_core::Clock;
use eos_core::routine::RunOrigin;
use eos_domain::routine::run::{Reason, RunState, Station};
use eos_runtime::module::Module;
use serde_json::json;

use crate::bench::{Bench, HOUR, blueprint, new_run, pull_request};

async fn working(bench: &Bench) -> (String, String) {
    let routine = bench.routine(RoutineState::Active, blueprint(1));
    let run = bench.hand(&routine, Some(pull_request(1))).await;
    bench.supervise().await;
    bench.eventually(|| bench.run(&run).station == Some(Station::Work)).await;
    let lead = bench.run(&run).lead_id.expect("a lead");
    bench.agents.settled().await;
    (run, lead)
}

fn kinds(bench: &Bench, run: &str) -> Vec<String> {
    let id = run.to_owned();
    let events = bench.temp.store.read_blocking(move |tx| tx.runs().events(&id)).expect("reads");
    events.into_iter().map(|e| e.kind).collect()
}

fn state_of(bench: &Bench, worker: &str) -> WorkerState {
    let id = worker.to_owned();
    bench.temp.store.read_blocking(move |tx| tx.workers().find(&id)).expect("reads").expect("a row").state
}

#[tokio::test(flavor = "multi_thread")]
async fn a_working_run_picks_up_once_after_a_restart_and_fails_the_second_time() {
    let bench = Bench::new(true);
    let (run, lead) = working(&bench).await;
    bench.module.stop().await;

    let restarted = bench.another_module();
    restarted.after_ready().await.expect("starts");
    bench.eventually(|| bench.agents.sent(&lead).iter().any(|t| t.contains("Eos restarted"))).await;
    let picked = bench.run(&run);
    assert_eq!((picked.state, picked.resumed), (RunState::Running, 1));
    let events = kinds(&bench, &run);
    assert!(events.ends_with(&["interrupted".to_owned(), "resumed".to_owned()]), "{events:?}");
    restarted.stop().await;

    let again = bench.another_module();
    again.after_ready().await.expect("starts");
    bench.eventually(|| bench.state(&run) == RunState::Failed).await;
    assert_eq!(bench.run(&run).reason, Some(Reason::Interrupted));
    again.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_found_at_its_check_goes_on_to_the_gate_and_its_lead_is_let_go() {
    let bench = Bench::new(true);
    let (run, lead) = working(&bench).await;
    let id = run.clone();
    bench
        .temp
        .store
        .write_blocking(move |tx, _| {
            tx.run_results().insert(&eos_core::store::StoredRunResult {
                run_id: id,
                attempt: 1,
                kind: "github.review".into(),
                headline: "R".into(),
                body: json!("b").to_string(),
                files: None,
                verdict: None,
                created_at: 0,
            })
        })
        .expect("writes");
    bench.temp.exec(&format!("UPDATE runs SET state = 'checking', station = 'check' WHERE id = '{run}'"));
    bench.module.stop().await;

    let restarted = bench.another_module();
    restarted.after_ready().await.expect("starts");
    bench.eventually(|| bench.state(&run) == RunState::Done).await;
    assert_eq!(bench.gate.inputs().len(), 1, "the gate took it");
    bench.eventually(|| !restarted.holds_worker(&lead)).await;
    let is_checker = |s: &eos_core::agent::LaunchSpec| s.worker_definition.as_deref() == Some("eos-run-checker");
    assert!(!bench.agents.started().iter().any(is_checker), "no checker starts");
    restarted.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_queued_run_more_than_a_day_late_is_skipped_at_start() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, blueprint(1));
    let mut late = new_run(&routine, RunOrigin::Hand, Some(pull_request(1)));
    late.input.at = Some(bench.clock.now_ms() - 25 * HOUR);
    let late = bench.start(late).await.expect("queued").remove(0).id;
    bench.supervise().await;
    bench.eventually(|| bench.state(&late) == RunState::Skipped).await;
    assert_eq!(bench.run(&late).reason, Some(Reason::TooLate));
    let notices =
        bench.temp.store.read_blocking(|tx| tx.inbox_items().waiting_with_subject("too_late")).expect("reads");
    let titles: Vec<_> = notices.iter().map(|item| item.title.as_str()).collect();
    assert_eq!(titles, ["A run set for later was skipped"], "one notice");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_whose_routine_is_switched_off_before_it_starts_never_starts() {
    let bench = Bench::new(true);
    let routine = bench.routine_with(RoutineState::Active, blueprint(1), true);
    let mut later = new_run(&routine, RunOrigin::Hand, Some(pull_request(1)));
    later.input.at = Some(bench.clock.now_ms() + HOUR);
    let hand = bench.start(later).await.expect("queued").remove(0).id;
    let mut agents = new_run(&routine, RunOrigin::Agent { worker_id: "w-chat".into() }, Some(pull_request(2)));
    agents.input.at = Some(bench.clock.now_ms() + HOUR);
    let agent = bench.start(agents).await.expect("queued").remove(0).id;

    // Paused: what the user started still runs; the rest is skipped in the pause's own write.
    bench.module.control().pause(&routine, "user").await.expect("paused");
    assert_eq!((bench.state(&agent), bench.run(&agent).reason), (RunState::Skipped, Some(Reason::User)));
    assert_eq!(bench.state(&hand), RunState::Queued);

    // Archived: nothing starts, the user's own run neither.
    let id = routine.clone();
    bench
        .temp
        .store
        .write_blocking(move |tx, _| tx.routines().set_state(&id, RoutineState::Archived, None, 2))
        .expect("archived");
    bench.clock.advance(2 * HOUR);
    bench.supervise().await;
    bench.eventually(|| bench.state(&hand) == RunState::Skipped).await;
    assert!(bench.agents.started().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn an_ended_runs_sessions_are_suspended() {
    let bench = Bench::new(true);
    let (run, lead) = working(&bench).await;
    bench.module.tools().report_failure(&lead, "The pull request was closed.").await.expect("failed");
    assert_eq!(bench.state(&run), RunState::Failed);
    bench.eventually(|| state_of(&bench, &lead) == WorkerState::Suspended).await;
}
