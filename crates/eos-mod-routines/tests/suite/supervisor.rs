//! The supervisor: which queued run leaves the queue first, and when.

use eos_contracts::RoutineState;
use eos_core::Clock;
use eos_core::routine::RunOrigin;
use eos_domain::routine::run::{Reason, RunState, Station};

use crate::bench::{Bench, blueprint, new_run, pull_request};

#[tokio::test(flavor = "multi_thread")]
async fn runs_leave_by_priority_then_age_within_the_global_and_the_routines_slots() {
    let bench = Bench::new(true);
    let roomy = bench.routine_with(RoutineState::Active, blueprint(3), true);
    let narrow = bench.routine(RoutineState::Active, blueprint(1));
    let agent = RunOrigin::Agent { worker_id: "w-chat".into() };
    let by_agent = bench.start(new_run(&roomy, agent, Some(pull_request(1)))).await.expect("starts").remove(0).id;
    bench.clock.advance(1);
    let first = bench.hand(&roomy, Some(pull_request(2))).await;
    bench.clock.advance(1);
    let narrow_first = bench.hand(&narrow, Some(pull_request(3))).await;
    bench.clock.advance(1);
    let narrow_second = bench.hand(&narrow, Some(pull_request(4))).await;
    bench.clock.advance(1);
    let last = bench.hand(&roomy, Some(pull_request(5))).await;

    bench.supervise().await;
    bench.eventually(|| bench.state(&last) == RunState::Running).await;
    for id in [&first, &narrow_first, &last] {
        let run = bench.run(id);
        assert_eq!((run.state, run.station), (RunState::Running, Some(Station::Brief)), "{id}");
        assert!(run.started_at.is_some() && run.version_id.is_some(), "{id}: its version is bound");
    }
    assert_eq!(bench.state(&narrow_second), RunState::Queued, "its routine runs one at a time");
    assert_eq!(bench.state(&by_agent), RunState::Queued, "three slots, the user's runs first");

    // A slot frees: the agent's run is next, the narrow routine is still busy.
    bench.runs.stop(&first, Reason::User).await.expect("stops");
    bench.eventually(|| bench.state(&by_agent) == RunState::Running).await;
    assert_eq!(bench.state(&narrow_second), RunState::Queued);
    let run = bench.run(&first);
    assert_eq!((run.state, run.reason), (RunState::Cancelled, Some(Reason::User)));
    assert!(run.ended_at.is_some());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_set_for_later_waits_for_its_time() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, blueprint(1));
    let mut later = new_run(&routine, RunOrigin::Hand, Some(pull_request(1)));
    later.input.at = Some(bench.clock.now_ms() + 60_000);
    let id = bench.start(later).await.expect("starts").remove(0).id;
    assert_eq!(bench.run(&id).not_before, Some(bench.clock.now_ms() + 60_000));

    bench.supervise().await;
    // The pass saw it and sleeps until it is due.
    bench.eventually(|| bench.sleeper.pending() == [60_000]).await;
    assert_eq!(bench.state(&id), RunState::Queued);
    bench.clock.advance(60_000);
    assert!(bench.sleeper.wake());
    bench.eventually(|| bench.state(&id) == RunState::Running).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn off_the_network_only_the_users_own_runs_leave_the_queue() {
    let bench = Bench::new(false);
    let routine = bench.routine_with(RoutineState::Active, blueprint(3), true);
    let agent = RunOrigin::Agent { worker_id: "w-chat".into() };
    let by_agent = bench.start(new_run(&routine, agent, Some(pull_request(1)))).await.expect("starts").remove(0).id;
    let by_hand = bench.hand(&routine, Some(pull_request(2))).await;

    bench.supervise().await;
    // Both were in the one pass that started the hand run.
    bench.eventually(|| bench.state(&by_hand) == RunState::Running).await;
    assert_eq!(bench.state(&by_agent), RunState::Queued);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_stops_in_any_state_but_delivering_and_an_ended_one_never_moves() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, blueprint(3));
    let queued = bench.hand(&routine, Some(pull_request(1))).await;
    bench.runs.stop(&queued, Reason::User).await.expect("a queued run stops");
    assert_eq!(bench.state(&queued), RunState::Cancelled);
    let events = bench.temp.store.read_blocking(move |tx| tx.runs().events(&queued)).expect("reads");
    assert_eq!(events.last().and_then(|e| e.data.clone()).as_deref(), Some(r#"{"state":"cancelled","reason":"user"}"#));

    let delivering = bench.hand(&routine, Some(pull_request(2))).await;
    bench.temp.exec(&format!("UPDATE runs SET state = 'delivering' WHERE id = '{delivering}'"));
    let refused = bench.runs.stop(&delivering, Reason::User).await;
    assert_eq!(refused, Err(eos_core::Error::Conflict("a run that is delivering cannot be stopped".into())));
    let ended = bench.hand(&routine, Some(pull_request(3))).await;
    bench.runs.stop(&ended, Reason::User).await.expect("stops");
    assert!(matches!(bench.runs.stop(&ended, Reason::User).await, Err(eos_core::Error::Conflict(_))));
    assert_eq!(bench.runs.stop("rn-none", Reason::User).await, Err(eos_core::Error::not_found("run", "rn-none")));
}
