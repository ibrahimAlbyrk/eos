//! The push loop: a hint polls its source once, a forged or unknown event
//! is refused and counted, a push-only source keeps one signal per
//! delivery, events the relay dropped show as a gap, and a source whose
//! service cannot push gets no hook.

use std::sync::Arc;

use eos_contracts::RoutineState;
use eos_core::Error;
use eos_core::signals::PushOutcome;
use eos_core::store::StoredSignalSource;
use eos_mod_signals::SignalsModule;
use eos_runtime::module::Module;
use eos_testkit::FakeSource;
use eos_testkit::relay::FakeHookInbox;
use serde_json::Value;

use crate::rig::{Bench, SOURCE_ID, SavedIntake, pull, routine};

/// The first hook [`FakeHookInbox`] makes.
const HOOK: &str = "00000000000000000000000000000001";
const LATER: i64 = 1_000_000_000_000;

fn row(bench: &Bench, id: &str) -> Option<StoredSignalSource> {
    let id = id.to_owned();
    bench.temp.store.read_blocking(move |tx| tx.signal_sources().find(&id)).expect("reads")
}

fn inbox_cursor(bench: &Bench) -> Value {
    let rows = bench.temp.store.read_blocking(|tx| tx.signal_sources().all()).expect("reads");
    let inbox = rows.into_iter().find(|row| row.kind == "push-inbox").expect("the inbox's row");
    serde_json::from_str(inbox.cursor_json.as_deref().unwrap_or("{}")).expect("JSON")
}

/// A routine reading the pull requests, whose source pushes and is not due
/// to poll; the module made, its source given a hook, not yet started.
async fn hooked(pulls: FakeSource) -> (Bench, Arc<FakeSource>, Arc<FakeHookInbox>, SignalsModule) {
    let mut bench = Bench::new(vec![routine("rt-a", RoutineState::Active, &["opened"], None)]);
    let pulls = Arc::new(pulls);
    bench.sources = Arc::new(eos_testkit::FakeSignalSources::new().with("github.pulls", pulls.clone()));
    let inbox = Arc::new(FakeHookInbox::new());
    bench.inbox = Some(inbox.clone());
    bench
        .temp
        .store
        .write_blocking(|tx, _| {
            let row = tx.signal_sources().find(SOURCE_ID)?.expect("the source");
            tx.signal_sources().update(&StoredSignalSource { next_poll_at: Some(LATER), ..row })
        })
        .expect("writes");
    let module = bench.module(bench.temp.port(), Arc::new(SavedIntake::new(None)), true);
    module.add_push(SOURCE_ID).await.expect("a hook");
    assert_eq!((inbox.hooks(), pulls.added()), (vec![HOOK.to_owned()], vec![HOOK.to_owned()]));
    (bench, pulls, inbox, module)
}

#[tokio::test(flavor = "multi_thread")]
async fn hints_poll_their_source_once_and_the_inbox_is_acked_after_they_are_kept() {
    let (bench, pulls, inbox, module) = hooked(FakeSource::default().pushing()).await;
    for _ in 0..3 {
        inbox.add(HOOK, 1, &[("x-github-delivery", "d")], b"{}");
    }
    module.after_ready().await.expect("ready");
    bench.until(|| inbox.acks() == [3]).await;
    bench.until(|| row(&bench, SOURCE_ID).is_some_and(|row| row.next_poll_at != Some(LATER))).await;
    assert_eq!(pulls.pushed(), [HOOK, HOOK, HOOK], "each event is checked by its source");
    assert_eq!(pulls.requests().len(), 1, "three hints, one poll");
    assert_eq!(inbox_cursor(&bench)["seq"], 3);
    assert_eq!(inbox.ensured(), 2, "once to add the hook, once to read");
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_forged_an_unknown_and_an_unreadable_event_are_refused_counted_and_cost_no_poll() {
    let (bench, pulls, inbox, module) = hooked(FakeSource::default().pushing()).await;
    pulls.push_outcome(Ok(PushOutcome::Refused));
    inbox.add(HOOK, 1, &[("x-hub-signature-256", "sha256=00")], b"{}");
    inbox.add("ffffffffffffffffffffffffffffffff", 1, &[], b"{}");
    inbox.add_unreadable();
    module.after_ready().await.expect("ready");
    bench.until(|| inbox.acks() == [3]).await;
    let cursor = inbox_cursor(&bench);
    assert_eq!((cursor["refused"].as_u64(), cursor["unreadable"].as_u64()), (Some(2), Some(1)));
    assert_eq!(pulls.pushed(), [HOOK], "the unknown hook reaches no source");
    assert!(pulls.requests().is_empty(), "nothing was polled");
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_push_only_source_keeps_one_signal_per_delivery() {
    let (bench, pulls, inbox, module) = hooked(FakeSource::default().pushing()).await;
    let delivered = |id: &str| {
        let mut draft = pull(7, "aaa", "opened", false, &[]);
        draft.key = format!("github:delivery:{id}");
        Ok(PushOutcome::Signal(Box::new(draft)))
    };
    for id in ["d1", "d1", "d2"] {
        pulls.push_outcome(delivered(id));
        inbox.add(HOOK, 1, &[("x-github-delivery", id)], b"{}");
    }
    module.after_ready().await.expect("ready");
    bench.until(|| inbox.acks() == [3]).await;
    assert_eq!(bench.temp.count("SELECT count(*) FROM signals"), 2, "a replayed delivery is the same signal");
    assert!(pulls.requests().is_empty());
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn events_the_relay_dropped_show_as_a_gap_and_the_source_polls() {
    let (bench, pulls, inbox, module) = hooked(FakeSource::default().pushing()).await;
    inbox.set_dropped(4);
    inbox.add(HOOK, 1, &[], b"{}");
    module.after_ready().await.expect("ready");
    bench.until(|| inbox.acks() == [1]).await;
    assert_eq!(row(&bench, SOURCE_ID).and_then(|row| row.catch_up_json), None, "what was lost before is no gap");
    bench.until(|| row(&bench, SOURCE_ID).is_some_and(|row| row.next_poll_at != Some(LATER))).await;
    // The poll's slot is given back just after its row is settled.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    inbox.set_dropped(6);
    pulls.push_outcome(Ok(PushOutcome::Refused));
    inbox.add(HOOK, 1, &[], b"{}");
    bench.until(|| inbox.acks() == [1, 2]).await;
    let catch_up: Value =
        serde_json::from_str(&row(&bench, SOURCE_ID).and_then(|row| row.catch_up_json).expect("a gap")).expect("JSON");
    assert_eq!(catch_up["items"], 2, "two events were missed");
    bench.until(|| pulls.requests().len() == 2).await;
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_source_whose_service_cannot_push_gets_no_hook_and_without_an_inbox_none_is_made() {
    let mut bench = Bench::new(vec![routine("rt-a", RoutineState::Active, &["opened"], None)]);
    let inbox = Arc::new(FakeHookInbox::new());
    bench.inbox = Some(inbox.clone());
    let module = bench.module(bench.temp.port(), Arc::new(SavedIntake::new(None)), true);
    assert!(matches!(module.add_push(SOURCE_ID).await, Err(Error::Validation(_))));
    assert!(matches!(module.add_push("src-ffffffffffff").await, Err(Error::NotFound { .. })));
    assert!(inbox.hooks().is_empty() && inbox.ensured() == 0);

    bench.inbox = None;
    let module = bench.module(bench.temp.port(), Arc::new(SavedIntake::new(None)), true);
    assert!(matches!(module.add_push(SOURCE_ID).await, Err(Error::Unreachable(_))));
}
