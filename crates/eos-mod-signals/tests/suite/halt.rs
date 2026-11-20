//! While Needs you's stop switch is on nothing polls, fires or is decided;
//! switched off, each missed schedule fires once and the waiting signals are
//! routed. Each new version of a subject is announced, closed when its
//! source says so, and Needs you acts on the announcement as it is.

use std::sync::Arc;

use eos_contracts::{RoutineKind, RoutineState, SignalSubject};
use eos_core::Clock;
use eos_core::routine::RoutineTriggers;
use eos_core::store::StoredHalt;
use eos_domain::inbox::{ItemKind, ItemState};
use eos_inbox::{Items, ItemsParts, NewItem, Opening, open_in};
use eos_runtime::module::Module;
use eos_testkit::{FakeChannels, FakeRoutineControl, FakeRunOutcomes, FakeTimeZone, SeqIds};
use serde_json::json;

use crate::rig::{Bench, SOURCE_ID, SavedIntake, page, pull, routine};

/// Monday 2026-01-05 14:00 UTC; the tests start five minutes later.
const MONDAY_14: i64 = 1_767_621_600_000;
const MINUTE: i64 = 60_000;
const HOUR: i64 = 60 * MINUTE;

fn hourly(id: &str) -> RoutineTriggers {
    let when = json!({ "on": [{ "schedule": { "every": 60, "days": "all", "zone": "UTC" } }] });
    RoutineTriggers {
        id: id.into(),
        version: format!("rv-{id}"),
        state: RoutineState::Active,
        kind: RoutineKind::Standing,
        when: serde_json::from_value(when).expect("a When"),
        which: Default::default(),
    }
}

/// Switches halt as Needs you does, without its event.
fn switch(bench: &Bench, on: bool) {
    let halt = StoredHalt { on, since: on.then_some(1), by: Some("dashboard".into()), updated_at: 1 };
    bench.temp.store.write_blocking(move |tx, _| tx.inbox_halt().put(&halt)).expect("the switch");
}

/// Ends the scheduler's sleep, once a pass a poll started is over, and
/// waits for its pass.
async fn pass(bench: &Bench) {
    bench.until(|| bench.sleeper.wake()).await;
    bench.until(|| bench.sleeper.pending().len() == 1).await;
}

fn subjects(bench: &Bench) -> Vec<SignalSubject> {
    let announced = bench.temp.announced.list().into_iter().filter(|(topic, _)| *topic == "signals:subject");
    announced.map(|(_, payload)| serde_json::from_str(&payload).expect("a subject")).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn while_halted_nothing_polls_fires_or_is_decided_and_resume_catches_up_once() {
    let bench = Bench::new(vec![hourly("rt-hour"), routine("rt-pr", RoutineState::Active, &["opened"], None)]);
    bench.clock.set(MONDAY_14 + 5 * MINUTE);
    let module = bench.module(bench.temp.port(), Arc::new(SavedIntake::new(None)), true);
    module.after_ready().await.expect("ready");
    bench.until(|| bench.sleeper.pending().len() == 1).await;
    bench.until(|| bench.pulls.requests().len() == 1).await;

    switch(&bench, true);
    let fresh = module.ingest(SOURCE_ID, page(vec![pull(482, "abc", "opened", false, &[])], json!({}))).await;
    assert_eq!(fresh.expect("kept"), 1, "what comes in is kept");
    bench.clock.advance(3 * HOUR);
    pass(&bench).await;
    assert!(bench.admitted().is_empty(), "no schedule fires and nothing is admitted");
    assert_eq!(bench.pulls.requests().len(), 1, "no source polls");
    assert_eq!(bench.received(), 1, "the signal waits");

    switch(&bench, false);
    bench.bus.publish_raw("inbox:halt", None, br#"{"on":false}"#.as_slice().into());
    bench.until(|| bench.admitted().len() == 2).await;
    bench.until(|| bench.pulls.requests().len() == 2).await;
    let routines: Vec<String> = bench.admitted().into_iter().map(|(routine, _)| routine).collect();
    assert!(routines.contains(&"rt-hour".to_owned()) && routines.contains(&"rt-pr".to_owned()), "{routines:?}");
    let missed = bench.temp.count("SELECT missed FROM signal_schedules WHERE routine_id = 'rt-hour'");
    assert_eq!(missed, 2, "17:00 ran once for 15:00 and 16:00");
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn each_new_version_is_announced_matched_or_not_and_a_closed_one_closes_its_subject() {
    let bench = Bench::new(vec![routine("rt-pr", RoutineState::Active, &["opened"], None)]);
    let module = bench.module(bench.temp.port(), Arc::new(SavedIntake::new(None)), true);
    let items = vec![pull(482, "abc", "opened", false, &[]), pull(483, "def", "closed", false, &[])];
    module.ingest(SOURCE_ID, page(items.clone(), json!({}))).await.expect("kept");
    module.ingest(SOURCE_ID, page(items, json!({}))).await.expect("kept again");
    let expected = [
        SignalSubject { subject_key: "github:pr:acme/game#482".into(), version: Some("abc".into()), closed: false },
        SignalSubject { subject_key: "github:pr:acme/game#483".into(), version: Some("def".into()), closed: true },
    ];
    assert_eq!(subjects(&bench), expected, "once each");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_closed_pull_request_expires_the_draft_about_it_in_needs_you() {
    let bench = Bench::new(vec![routine("rt-pr", RoutineState::Active, &["opened"], None)]);
    let control = Arc::new(FakeRoutineControl::new());
    let (ids, zone) = (Arc::new(SeqIds::new()), Arc::new(FakeTimeZone::new("UTC", 0)));
    // The subject key the gate stores is the source's subject.
    let draft = NewItem {
        kind: ItemKind::Draft,
        producer: "routines".into(),
        routine_id: Some("rt-pr".into()),
        run_id: Some("rn-1".into()),
        subject_key: Some(pull(483, "abc", "opened", false, &[]).subject),
        title: "Review of #483".into(),
        summary: "Two comments".into(),
        payload: json!({ "doc": {} }),
        by_hand: false,
    };
    let (now, opening_ids, opening_zone, opening_control) =
        (bench.clock.now_ms(), ids.clone(), zone.clone(), control.clone());
    let draft = bench
        .temp
        .store
        .write_blocking(move |tx, out| {
            let at = Opening {
                now,
                ids: opening_ids.as_ref(),
                zone: opening_zone.as_ref(),
                control: opening_control.as_ref(),
            };
            open_in(tx, out, &at, draft)
        })
        .expect("a draft");

    let module = bench.module(bench.temp.port(), Arc::new(SavedIntake::new(None)), true);
    let closed = pull(483, "abc", "closed", false, &[]);
    module.ingest(SOURCE_ID, page(vec![closed], json!({}))).await.expect("kept");
    let items = Items::new(ItemsParts {
        store: bench.temp.port(),
        clock: bench.clock.clone(),
        ids,
        zone,
        channels: Arc::new(FakeChannels::new()),
        outcomes: Arc::new(FakeRunOutcomes::default()),
        control,
        wake: Arc::default(),
        waiters: Arc::default(),
    });
    for subject in subjects(&bench) {
        items.subject(subject).await.expect("acted");
    }
    let id = draft.id.clone();
    let item = bench.temp.store.read_blocking(move |tx| tx.inbox_items().find(&id)).expect("reads").expect("kept");
    assert_eq!(item.state, ItemState::Expired);
}
