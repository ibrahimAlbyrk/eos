//! The signal tables: one signal per thing a source saw, one decision per
//! signal and routine, one schedule row per slot, the signal of a run started
//! by hand, and sources and runners read back as written.

use eos_core::store::{
    ManualSignal, NewSignal, SignalTally, StoredSignal, StoredSignalRoute, StoredSignalRunner, StoredSignalSchedule,
    StoredSignalSource,
};
use eos_domain::routine::run::RunState;
use eos_domain::signals::decision::Decision;
use eos_testkit::TempStore;

fn source(id: &str, kind: &str, scope_hash: &str) -> StoredSignalSource {
    StoredSignalSource {
        id: id.into(),
        kind: kind.into(),
        source: None,
        scope_json: "{}".into(),
        scope_hash: scope_hash.into(),
        cursor_json: None,
        state: "active".into(),
        error_kind: None,
        failures: 0,
        interval_ms: 60_000,
        last_poll_at: None,
        next_poll_at: None,
        last_signal_at: None,
        catch_up_json: None,
        stopped_at: None,
        created_at: 10,
        updated_at: 10,
    }
}

fn seen(source_id: &str, key: &str, received_at: i64) -> NewSignal {
    NewSignal {
        source_id: source_id.into(),
        key: key.into(),
        subject: "github:pr:acme/game#482".into(),
        version: Some("9f1a4771".into()),
        kind: "opened".into(),
        occurred_at: received_at - 5,
        received_at,
        facts_json: Some(r#"{"draft":false}"#.into()),
        item_json: r#"{"kind":"github.pull_request","untrusted":true}"#.into(),
        depth: 0,
    }
}

fn decided(signal_id: i64, routine_id: &str, decision: Decision) -> StoredSignalRoute {
    StoredSignalRoute {
        signal_id,
        routine_id: routine_id.into(),
        routine_version: "rv-1".into(),
        decision,
        reason: None,
        run_id: None,
        model_asked: false,
        decided_at: 100,
    }
}

#[test]
fn a_thing_a_source_sees_twice_is_one_signal_routed_once() {
    let temp = TempStore::new();
    let (first, again, other_source, next, waiting, later, routed) = temp
        .store
        .write_blocking(|tx, _| {
            let signals = tx.signals();
            let first = signals.ingest(&seen("src-a", "github:pr:acme/game#482@9f1a4771", 20))?;
            let again = signals.ingest(&seen("src-a", "github:pr:acme/game#482@9f1a4771", 30))?;
            let other_source = signals.ingest(&seen("src-b", "github:pr:acme/game#482@9f1a4771", 40))?;
            let next = signals.ingest(&seen("src-a", "github:pr:acme/game#483@0b2c", 50))?;
            let waiting = signals.received(0, 10)?;
            let later = signals.received(first.unwrap_or_default(), 10)?;
            if let Some(id) = first {
                signals.mark_routed(id)?;
            }
            Ok((first, again, other_source, next, waiting, later, signals.received(0, 10)?))
        })
        .expect("writes");
    assert_eq!(again, None, "the same key from the same source is not kept again");
    let kept: Vec<i64> = [first, other_source, next].into_iter().map(|id| id.expect("kept")).collect();
    assert!(kept.is_sorted_by(|a, b| a < b), "numbered in arrival order: {kept:?}");
    assert_eq!(temp.count("SELECT COUNT(*) FROM signals"), 3, "another source's key is its own");
    let ids = |signals: &[StoredSignal]| signals.iter().map(|s| s.id).collect::<Vec<_>>();
    assert_eq!(ids(&waiting), kept, "oldest first");
    assert_eq!(waiting[0].signal, seen("src-a", "github:pr:acme/game#482@9f1a4771", 20), "the first stays as it came");
    assert_eq!(ids(&later), kept[1..], "only those after the one asked after");
    assert_eq!(ids(&routed), kept[1..], "a routed signal waits no more");
    let first = kept[0];
    let found = temp.store.read_blocking(move |tx| tx.signals().find(first)).expect("reads");
    assert_eq!(found.map(|s| s.routed), Some(true));
}

#[test]
fn a_signal_has_one_decision_for_each_routine() {
    let temp = TempStore::new();
    let insert = |route: StoredSignalRoute| temp.store.write_blocking(move |tx, _| tx.signal_routes().insert(&route));
    let mut unmatched = decided(1, "rt-2", Decision::Unmatched);
    unmatched.reason = Some("2".into());
    let mut run = decided(1, "rt-1", Decision::Run);
    run.run_id = Some("rn-1".into());
    run.model_asked = true;
    insert(unmatched.clone()).expect("the first routine's");
    insert(run.clone()).expect("another routine's");
    assert!(insert(decided(1, "rt-2", Decision::OverLimit)).is_err(), "a second for the same routine is refused");
    insert(decided(2, "rt-2", Decision::HeldDev)).expect("the next signal's");
    let routes = temp.store.read_blocking(|tx| tx.signal_routes().by_signal(1)).expect("reads");
    assert_eq!(routes, [run, unmatched], "by routine");
}

#[test]
fn signals_page_newest_first_by_routine_and_decision_and_tally_by_run_state() {
    let temp = TempStore::new();
    temp.exec(
        "INSERT INTO runs (id, routine_id, kind, origin, input, state, priority, device, created_at, updated_at) \
         VALUES ('rn-1', 'rt-1', 'standing', 'trigger', '{}', 'done', 2, 'mac-1', 1, 1)",
    );
    temp.store
        .write_blocking(|tx, _| {
            for n in 0..4 {
                tx.signals().ingest(&seen("src-a", &format!("k{n}"), 20 + n))?;
            }
            let routes = tx.signal_routes();
            let mut run = decided(1, "rt-1", Decision::Run);
            run.run_id = Some("rn-1".into());
            routes.insert(&run)?;
            routes.insert(&decided(2, "rt-1", Decision::OverLimit))?;
            routes.insert(&decided(3, "rt-1", Decision::OverLimit))?;
            routes.insert(&decided(3, "rt-2", Decision::Unmatched))?;
            // A replay decides the second again.
            let mut again = decided(2, "rt-1", Decision::Run);
            again.run_id = Some("rn-2".into());
            again.decided_at = 200;
            routes.put(&again)
        })
        .expect("writes");
    let page = |routine: Option<&'static str>, decision: Option<Decision>, before: Option<i64>, limit: i64| {
        let found = temp.store.read_blocking(move |tx| tx.signals().page(routine, decision, before, limit));
        found.expect("reads").into_iter().map(|signal| signal.id).collect::<Vec<_>>()
    };
    assert_eq!(page(None, None, None, 10), [4, 3, 2, 1], "newest first");
    assert_eq!(page(None, None, Some(3), 1), [2], "older than before, up to the limit");
    assert_eq!(page(Some("rt-1"), None, None, 10), [3, 2, 1], "routed to the routine");
    assert_eq!(page(Some("rt-1"), Some(Decision::OverLimit), None, 10), [3]);
    assert_eq!(page(None, Some(Decision::Unmatched), None, 10), [3], "decided so for any routine");
    let tally = temp.store.read_blocking(|tx| tx.signal_routes().tally("rt-1", 100)).expect("reads");
    let tally: Vec<SignalTally> = tally;
    assert_eq!(
        tally,
        [
            SignalTally { decision: Decision::OverLimit, run_state: None, signals: 1 },
            SignalTally { decision: Decision::Run, run_state: None, signals: 1 },
            SignalTally { decision: Decision::Run, run_state: Some(RunState::Done), signals: 1 },
        ]
    );
    assert_eq!(temp.store.read_blocking(|tx| tx.signal_routes().tally("rt-1", 150)).expect("reads").len(), 1);
}

#[test]
fn a_routine_keeps_one_schedule_row_per_slot() {
    let temp = TempStore::new();
    let schedule = |routine_id: &str, slot: i64, armed_at: i64| StoredSignalSchedule {
        routine_id: routine_id.into(),
        slot,
        spec_hash: "h1".into(),
        zone: "Europe/Istanbul".into(),
        armed_at,
        last_slot_at: None,
        next_at: Some(armed_at + 1_000),
        missed: 0,
        late_by_ms: 0,
        updated_at: armed_at,
    };
    let mut fired = schedule("rt-1", 0, 10);
    fired.last_slot_at = Some(1_010);
    fired.next_at = None;
    fired.missed = 3;
    fired.late_by_ms = 61_000;
    fired.updated_at = 2_000;
    let (one, other) = {
        let (slot_one, fired) = (schedule("rt-1", 1, 20), fired.clone());
        temp.store
            .write_blocking(move |tx, _| {
                let schedules = tx.signal_schedules();
                schedules.put(&schedule("rt-1", 0, 10))?;
                schedules.put(&slot_one)?;
                schedules.put(&schedule("rt-2", 0, 30))?;
                schedules.put(&fired)?;
                Ok((schedules.of_routine("rt-1")?, schedules.of_routine("rt-2")?))
            })
            .expect("writes")
    };
    assert_eq!(one, [fired, schedule("rt-1", 1, 20)], "the slot's row was replaced, by slot");
    assert_eq!(other.len(), 1, "another routine's slot is its own");
    assert_eq!(temp.count("SELECT COUNT(*) FROM signal_schedules"), 3);
}

#[test]
fn a_run_started_by_hand_is_a_manual_signal_routed_to_run() {
    let temp = TempStore::new();
    let manual = ManualSignal {
        source_id: "src-manual".into(),
        run_id: "rn-1".into(),
        routine_id: "rt-1".into(),
        routine_version: "rv-1".into(),
        subject: "github:pr:acme/game#482".into(),
        version: None,
        item_json: r#"{"kind":"github.pull_request","untrusted":true}"#.into(),
        at: 500,
    };
    let (signal, routes) = {
        let manual = manual.clone();
        temp.store
            .write_blocking(move |tx, _| {
                tx.signal_sources().insert(&source("src-manual", "manual", "manual"))?;
                let id = tx.signals().insert_manual(&manual)?;
                Ok((tx.signals().find(id)?, tx.signal_routes().by_signal(id)?))
            })
            .expect("writes")
    };
    let signal = signal.expect("kept");
    assert_eq!(signal.signal.key, "manual:rn-1");
    assert_eq!((signal.signal.received_at, signal.signal.facts_json.as_deref()), (500, None));
    assert!(signal.routed, "nothing is left to decide");
    let mut run = decided(signal.id, "rt-1", Decision::Run);
    run.run_id = Some("rn-1".into());
    run.decided_at = 500;
    assert_eq!(routes, [run]);
    let again = temp.store.write_blocking(move |tx, _| tx.signals().insert_manual(&manual));
    assert!(again.is_err(), "one run has one signal");
    assert_eq!(temp.count("SELECT COUNT(*) FROM signal_routes"), 1, "the failed job left nothing");
}

#[test]
fn a_sources_cursor_and_state_and_a_routines_runner_read_back_as_written() {
    let temp = TempStore::new();
    let mut polled = source("src-a", "capability", "scope-a");
    polled.source = Some("github.pulls".into());
    polled.scope_json = r#"{"repo":"acme/game"}"#.into();
    let mut backing_off = polled.clone();
    backing_off.cursor_json = Some(r#"{"etag":"W/\"1\"","since":"2026-11-18T10:00:00Z"}"#.into());
    backing_off.state = "backing-off".into();
    backing_off.error_kind = Some("unreachable".into());
    backing_off.failures = 2;
    backing_off.last_poll_at = Some(70);
    backing_off.next_poll_at = Some(130);
    backing_off.last_signal_at = Some(60);
    backing_off.catch_up_json = Some(r#"{"at":70,"items":14,"gapMs":3600000}"#.into());
    backing_off.updated_at = 70;
    let mut written = backing_off.clone();
    written.created_at = 999;
    let runner = |epoch: i64, device: &str| StoredSignalRunner {
        routine_id: "rt-1".into(),
        holder_device: device.into(),
        epoch,
        seen_seq: epoch * 10,
        seen_at: epoch * 100,
        handoff_json: (epoch > 1).then(|| r#"{"watermarks":{}}"#.into()),
    };
    let (found, by_scope, holder) = temp
        .store
        .write_blocking(move |tx, _| {
            let sources = tx.signal_sources();
            sources.insert(&polled)?;
            sources.update(&written)?;
            tx.signal_runners().put(&runner(1, "d-1"))?;
            tx.signal_runners().put(&runner(2, "d-2"))?;
            Ok((sources.find("src-a")?, sources.by_scope("scope-a")?, tx.signal_runners().find("rt-1")?))
        })
        .expect("writes");
    assert_eq!(found.as_ref(), Some(&backing_off), "everything but when it was made");
    assert_eq!(by_scope, found);
    assert_eq!(holder, Some(runner(2, "d-2")), "the holder read last");
    let unknown =
        temp.store.read_blocking(|tx| Ok((tx.signal_sources().find("src-x")?, tx.signal_runners().find("rt-x")?)));
    assert_eq!(unknown.expect("reads"), (None, None));
    let same_scope =
        temp.store.write_blocking(|tx, _| tx.signal_sources().insert(&source("src-b", "capability", "scope-a")));
    assert!(same_scope.is_err(), "one source serves one scope");
}
