//! Signal to run, exactly once: through crashes, duplicate keys, rules,
//! a development run and runs started by hand.

use std::sync::Arc;

use eos_contracts::RoutineState;
use eos_core::store::{ManualSignal, Store};
use eos_mod_signals::SignalsModule;
use eos_runtime::module::Module;
use serde_json::json;

use crate::rig::{Bench, Flaky, SOURCE_ID, SavedIntake, page, pull, routine};

const EVENTS: [&str; 2] = ["opened", "updated"];

fn two_routines() -> Bench {
    Bench::new(vec![
        routine("rt-a", RoutineState::Active, &EVENTS, None),
        routine("rt-b", RoutineState::Active, &EVENTS, None),
    ])
}

fn two_pulls() -> eos_core::signals::PollPage {
    page(
        vec![pull(1, "aaa", "opened", false, &["src/a.rs"]), pull(2, "bbb", "updated", false, &["src/b.rs"])],
        json!({"etag": "e1"}),
    )
}

async fn stop(module: &SignalsModule) {
    module.stop().await;
}

/// One decision and one saved run per signal and routine.
fn assert_once(bench: &Bench) {
    let routes = bench.routes();
    let pairs: Vec<(i64, &str)> = routes.iter().map(|(signal, routine, ..)| (*signal, routine.as_str())).collect();
    assert_eq!(pairs, [(1, "rt-a"), (1, "rt-b"), (2, "rt-a"), (2, "rt-b")]);
    assert!(routes.iter().all(|(.., decision, _, run)| decision == "run" && run.is_some()));
    let mut admitted = bench.admitted();
    admitted.sort();
    assert_eq!(
        admitted,
        [("rt-a".to_owned(), 1), ("rt-a".to_owned(), 2), ("rt-b".to_owned(), 1), ("rt-b".to_owned(), 2)],
        "each run admitted once, in the write that kept its decision"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_signal_starts_one_run_of_each_routine_whichever_write_fails_before_a_restart() {
    // The writes of a clean pass: the page, then one per signal.
    for fail_at in 0..3 {
        let bench = two_routines();
        let flaky = Arc::new(Flaky::new(bench.temp.port(), Some(fail_at)));
        let crashed = bench.module(flaky.clone() as Arc<dyn Store>, Arc::new(SavedIntake::new(None)), true);
        if crashed.ingest(SOURCE_ID, two_pulls()).await.is_err() {
            // The source is read again from the cursor it had: the same keys come back.
            crashed.ingest(SOURCE_ID, two_pulls()).await.expect("kept");
        }
        crashed.after_ready().await.expect("ready");
        flaky.crashed().await;
        stop(&crashed).await;

        let restarted = bench.module(bench.temp.port(), Arc::new(SavedIntake::new(None)), true);
        bench.route(&restarted).await;
        stop(&restarted).await;
        assert_once(&bench);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_signal_that_cannot_be_routed_holds_up_none_after_it_and_is_tried_again_a_minute_later() {
    let bench = two_routines();
    // The second admission is the first signal's second routine: the whole signal is undone.
    let failing = bench.module(bench.temp.port(), Arc::new(SavedIntake::new(Some(1))), true);
    failing.ingest(SOURCE_ID, two_pulls()).await.expect("kept");
    failing.after_ready().await.expect("ready");
    bench.until(|| bench.received() == 1).await;
    let decided: Vec<(i64, String)> =
        bench.routes().into_iter().map(|(signal, routine, ..)| (signal, routine)).collect();
    assert_eq!(decided, [(2, "rt-a".to_owned()), (2, "rt-b".to_owned())], "the second is routed without the first");

    bench.clock.advance(60_000);
    failing.ingest(SOURCE_ID, page(Vec::new(), json!({}))).await.expect("kept");
    bench.until(|| bench.received() == 0).await;
    stop(&failing).await;
    assert_once(&bench);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_key_seen_before_costs_nothing_and_the_cursor_moves_with_the_page() {
    let bench = two_routines();
    let module = bench.module(bench.temp.port(), Arc::new(SavedIntake::new(None)), true);
    assert_eq!(module.ingest(SOURCE_ID, two_pulls()).await.expect("kept"), 2);
    let again = page(vec![pull(2, "bbb", "updated", false, &["src/b.rs"])], json!({"etag": "e2", "since": 7}));
    assert_eq!(module.ingest(SOURCE_ID, again).await.expect("kept"), 0, "the same key is the same signal");
    let cursor = bench
        .temp
        .store
        .read_blocking(|tx| Ok(tx.signal_sources().find(SOURCE_ID)?.and_then(|source| source.cursor_json)))
        .expect("reads");
    assert_eq!(cursor.as_deref(), Some(r#"{"etag":"e2","since":7}"#), "handed back as the source gave it");
    bench.route(&module).await;
    stop(&module).await;
    assert_once(&bench);
    let changes = bench.temp.announced.list();
    let routed = changes.iter().filter(|(topic, payload)| *topic == "signals:change" && payload.contains("routed"));
    assert_eq!(routed.count(), 4, "each decision is announced");
}

#[tokio::test(flavor = "multi_thread")]
async fn each_routine_decides_by_its_own_state_events_and_rules() {
    let rule = json!({ "all": [{ "fact": "draft", "is": false }, { "fact": "paths", "glob": "Assets/**" }] });
    let missing = json!({ "fact": "labels", "has": "net" });
    let mut asks = routine("rt-ask", RoutineState::Active, &EVENTS, None);
    asks.which.ask = Some("Is it about networking?".into());
    let mut elsewhere = routine("rt-other", RoutineState::Active, &EVENTS, None);
    elsewhere.when = serde_json::from_value(
        json!({ "on": [{ "source": "github.pulls", "scope": { "repo": "acme/other" }, "events": EVENTS }] }),
    )
    .expect("a When");
    let bench = Bench::new(vec![
        routine("rt-rule", RoutineState::Active, &EVENTS, Some(rule)),
        routine("rt-paused", RoutineState::Paused, &EVENTS, None),
        routine("rt-closed", RoutineState::Active, &["closed"], None),
        routine("rt-facts", RoutineState::Active, &EVENTS, Some(missing)),
        asks,
        elsewhere,
    ]);

    let module = bench.module(bench.temp.port(), Arc::new(SavedIntake::new(None)), true);
    let items =
        vec![pull(1, "aaa", "opened", false, &["src/a.rs"]), pull(2, "bbb", "opened", false, &["Assets/x.png"])];
    module.ingest(SOURCE_ID, page(items, json!({}))).await.expect("kept");
    bench.route(&module).await;
    stop(&module).await;

    let decided: Vec<(i64, String, String, Option<String>)> = bench
        .routes()
        .into_iter()
        .map(|(signal, routine, decision, reason, _)| (signal, routine, decision, reason))
        .collect();
    let row = |signal, routine: &str, decision: &str, reason: Option<&str>| {
        (signal, routine.to_owned(), decision.to_owned(), reason.map(str::to_owned))
    };
    assert_eq!(
        decided,
        [
            row(1, "rt-ask", "undecided", Some("ask")),
            row(1, "rt-facts", "undecided", Some("missing")),
            row(1, "rt-paused", "paused", None),
            row(1, "rt-rule", "unmatched", Some("1")),
            row(2, "rt-ask", "undecided", Some("ask")),
            row(2, "rt-facts", "undecided", Some("missing")),
            row(2, "rt-paused", "paused", None),
            row(2, "rt-rule", "run", None),
        ],
        "the second rule fails for the first; another scope and other events take nothing"
    );
    assert_eq!(bench.admitted(), [("rt-rule".to_owned(), 2)]);
}

#[tokio::test(flavor = "multi_thread")]
async fn outside_the_installed_app_a_match_is_held_and_starts_nothing() {
    let bench = two_routines();
    let module = bench.module(bench.temp.port(), Arc::new(SavedIntake::new(None)), false);
    module.ingest(SOURCE_ID, two_pulls()).await.expect("kept");
    bench.route(&module).await;
    stop(&module).await;
    let routes = bench.routes();
    assert_eq!(routes.len(), 4);
    assert!(routes.iter().all(|(.., decision, _, run)| decision == "held-dev" && run.is_none()));
    assert!(bench.admitted().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_started_by_hand_keeps_its_one_decision() {
    let bench = two_routines();
    let manual = ManualSignal {
        source_id: SOURCE_ID.into(),
        run_id: "rn-hand".into(),
        routine_id: "rt-a".into(),
        routine_version: "rv-rt-a".into(),
        subject: "github:pr:acme/game#1".into(),
        version: Some("aaa".into()),
        item_json: "{}".into(),
        at: 10,
    };
    bench.temp.store.write_blocking(move |tx, _| tx.signals().insert_manual(&manual).map(drop)).expect("kept");
    let module = bench.module(bench.temp.port(), Arc::new(SavedIntake::new(None)), true);
    bench.route(&module).await;
    module.ingest(SOURCE_ID, page(Vec::new(), json!({}))).await.expect("kept");
    bench.route(&module).await;
    stop(&module).await;
    let routes = bench.routes();
    assert_eq!(routes, [(1, "rt-a".to_owned(), "run".to_owned(), None, Some("rn-hand".to_owned()))]);
    assert!(bench.admitted().is_empty(), "the start that wrote it queued its run");
}
