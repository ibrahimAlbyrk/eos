//! A storm: supersede by subject, the routine's limits, the one notice that
//! keeps count, back-pressure on ingest, and a paused routine's signals.

use std::sync::Arc;

use eos_contracts::RoutineState;
use eos_core::Error;
use eos_domain::routine::run::RunState;
use eos_runtime::module::Module;
use serde_json::{Value, json};

use crate::rig::{Bench, SOURCE_ID, TableIntake, page, pull, routine};

const EVENTS: [&str; 2] = ["opened", "updated"];

#[tokio::test(flavor = "multi_thread")]
async fn two_hundred_signals_in_a_minute_run_thirty_and_keep_the_rest_with_one_notice() {
    let bench = Bench::new(vec![routine("rt-a", RoutineState::Active, &EVENTS, None)]);
    let intake = Arc::new(TableIntake::new(bench.clock.clone()));
    let module = bench.module(bench.temp.store.clone(), intake, true);
    // Ten versions of twenty pull requests, newest last.
    let shas: Vec<String> = (0..10).map(|version| format!("v{version}")).collect();
    let pulls = shas.iter().flat_map(|sha| (1..=20).map(move |n| pull(n, sha, "updated", false, &[])));
    module.ingest(SOURCE_ID, page(pulls.collect(), json!({}))).await.expect("kept");
    bench.route(&module).await;

    assert_eq!(bench.decided("run"), 30, "thirty an hour");
    assert_eq!(bench.decided("over-limit"), 170, "kept, not lost");
    let runs = bench.runs("rt-a");
    let skipped = runs.iter().filter(|(state, _)| *state == RunState::Skipped).count();
    assert_eq!(skipped, 10, "a newer version of a pull request replaced its queued run");
    assert_eq!(runs.iter().filter(|(state, _)| *state == RunState::Queued).count(), 20, "one run per pull request");

    let notices =
        bench.temp.store.read_blocking(|tx| tx.inbox_items().waiting_with_subject("over-limit")).expect("reads");
    assert_eq!(notices.len(), 1, "one notice a day");
    let notice = &notices[0];
    assert_eq!(notice.summary, "A routine got 200 items in an hour and ran 30. 170 are waiting.");
    assert_eq!(notice.rev, 170, "each later over-limit brought its count up to date");
    let payload: Value = serde_json::from_str(&notice.payload).expect("json");
    assert_eq!(payload["waiting"], 170);
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_newer_signal_that_gets_no_run_leaves_the_waiting_run_of_its_subject() {
    let bench = Bench::new(vec![routine("rt-a", RoutineState::Active, &EVENTS, None)]);
    let intake = Arc::new(TableIntake::new(bench.clock.clone()));
    let module = bench.module(bench.temp.store.clone(), intake.clone(), true);
    module.ingest(SOURCE_ID, page(vec![pull(1, "v0", "updated", false, &[])], json!({}))).await.expect("kept");
    bench.route(&module).await;
    assert_eq!(bench.runs("rt-a"), [(RunState::Queued, 0)]);

    intake.refusing.store(true, std::sync::atomic::Ordering::SeqCst);
    module.ingest(SOURCE_ID, page(vec![pull(1, "v1", "updated", false, &[])], json!({}))).await.expect("kept");
    bench.route(&module).await;
    assert_eq!(bench.decided("refused"), 1);
    assert_eq!(bench.runs("rt-a"), [(RunState::Queued, 0)], "the waiting run still runs");
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn ingest_waits_while_too_many_signals_wait_to_be_routed_and_takes_pages_again_after() {
    let bench = Bench::new(vec![]);
    let module = bench.module(bench.temp.store.clone(), Arc::new(TableIntake::new(bench.clock.clone())), true);
    let many = (1..=5_001).map(|n| pull(n, "a", "opened", false, &[])).collect();
    module.ingest(SOURCE_ID, page(many, json!({}))).await.expect("kept");
    let refused = module.ingest(SOURCE_ID, page(vec![pull(9_999, "a", "opened", false, &[])], json!({}))).await;
    assert!(matches!(refused, Err(Error::LimitExceeded(_))), "{refused:?}");
    assert_eq!(bench.received(), 5_001, "nothing dropped");

    bench.route(&module).await;
    let taken = module.ingest(SOURCE_ID, page(vec![pull(9_999, "a", "opened", false, &[])], json!({}))).await;
    assert_eq!(taken.expect("taken again"), 1);
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_paused_routines_signals_are_kept_as_paused() {
    let bench = Bench::new(vec![routine("rt-a", RoutineState::Paused, &EVENTS, None)]);
    let module = bench.module(bench.temp.store.clone(), Arc::new(TableIntake::new(bench.clock.clone())), true);
    let pulls = (1..=3).map(|n| pull(n, "a", "opened", false, &[])).collect();
    module.ingest(SOURCE_ID, page(pulls, json!({}))).await.expect("kept");
    bench.route(&module).await;
    assert_eq!(bench.decided("paused"), 3);
    assert!(bench.runs("rt-a").is_empty());
    module.stop().await;
}
