//! Batching: matched signals collect and one run takes each full batch;
//! the rest goes once its wait is over.

use std::sync::Arc;

use eos_contracts::RoutineState;
use eos_domain::routine::run::RunState;
use eos_runtime::module::Module;
use serde_json::json;

use crate::rig::{Bench, SOURCE_ID, SavedIntake, TableIntake, page, pull, routine};

#[tokio::test(flavor = "multi_thread")]
async fn a_hundred_and_twenty_signals_make_runs_of_fifty_fifty_and_twenty() {
    let mut batching = routine("rt-mail", RoutineState::Active, &["opened"], None);
    batching.when.batch = Some(serde_json::from_value(json!({"max": 50, "waitMinutes": 5})).expect("a batch"));
    let bench = Bench::new(vec![batching]);
    let module = bench.module(bench.temp.store.clone(), Arc::new(TableIntake::new(bench.clock.clone())), true);
    let pulls = (1..=120).map(|n| pull(n, "a", "opened", false, &[])).collect();
    module.ingest(SOURCE_ID, page(pulls, json!({}))).await.expect("kept");
    bench.route(&module).await;
    assert_eq!(bench.decided("batched"), 120);
    assert_eq!(bench.runs("rt-mail"), [(RunState::Queued, 50), (RunState::Queued, 50)], "full batches close at once");

    bench.clock.advance(5 * 60 * 1000);
    // The next page wakes the router, which closes the batch that came due.
    module.ingest(SOURCE_ID, page(vec![], json!({}))).await.expect("kept");
    for _ in 0..400 {
        if bench.runs("rt-mail").len() == 3 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(bench.runs("rt-mail")[2], (RunState::Queued, 20));
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_batch_that_cannot_close_leaves_the_next_routines_batch_to_close() {
    let batched = |id: &str| {
        let mut batching = routine(id, RoutineState::Active, &["opened"], None);
        batching.when.batch = Some(serde_json::from_value(json!({"max": 50, "waitMinutes": 5})).expect("a batch"));
        batching
    };
    let bench = Bench::new(vec![batched("rt-a"), batched("rt-b")]);
    // rt-a's batch, closed first, never admits its run.
    let intake = Arc::new(SavedIntake::failing("rt-a"));
    let module = bench.module(bench.temp.port(), intake.clone(), true);
    module.ingest(SOURCE_ID, page(vec![pull(1, "a", "opened", false, &[])], json!({}))).await.expect("kept");
    bench.route(&module).await;
    assert_eq!(bench.decided("batched"), 2);
    module.stop().await;

    // Both batches are due when the next router starts.
    bench.clock.advance(5 * 60 * 1000);
    let module = bench.module(bench.temp.port(), intake, true);
    module.after_ready().await.expect("ready");
    bench.until(|| !bench.admitted().is_empty()).await;
    assert_eq!(bench.admitted(), [("rt-b".to_owned(), 1)]);
    module.stop().await;
}
