//! The scheduler: each slot once, after sleep, a closed app or a clock that
//! jumped; nothing before a schedule is armed, nothing while paused, and
//! nothing started outside the installed app.

use std::sync::Arc;

use eos_contracts::{RoutineKind, RoutineState};
use eos_core::routine::RoutineTriggers;
use eos_core::store::StoredSignalSchedule;
use eos_mod_signals::SignalsModule;
use eos_runtime::module::Module;
use serde_json::{Value, json};

use crate::rig::{Bench, SavedIntake};

/// Monday 2026-01-05 14:00 UTC; the tests start five minutes later.
const MONDAY_14: i64 = 1_767_621_600_000;
const MINUTE: i64 = 60_000;
const HOUR: i64 = 60 * MINUTE;
const DAY: i64 = 24 * HOUR;

fn scheduled(id: &str, state: RoutineState, schedule: Value) -> RoutineTriggers {
    RoutineTriggers {
        id: id.into(),
        version: format!("rv-{id}"),
        state,
        kind: RoutineKind::Standing,
        when: serde_json::from_value(json!({ "on": [{ "schedule": schedule }] })).expect("a When"),
        which: Default::default(),
    }
}

fn daily_at_five(id: &str) -> RoutineTriggers {
    scheduled(id, RoutineState::Active, json!({ "daily": "05:00", "days": "all", "zone": "UTC" }))
}

fn hourly(id: &str, state: RoutineState) -> RoutineTriggers {
    scheduled(id, state, json!({ "every": 60, "days": "all", "zone": "UTC" }))
}

fn bench(routines: Vec<RoutineTriggers>) -> Bench {
    let bench = Bench::new(routines);
    bench.clock.set(MONDAY_14 + 5 * MINUTE);
    bench
}

/// Starts the module and waits for its first pass.
async fn started(bench: &Bench, autostart: bool) -> SignalsModule {
    let module = bench.module(bench.temp.port(), Arc::new(SavedIntake::new(None)), autostart);
    module.after_ready().await.expect("ready");
    bench.until(|| bench.sleeper.pending().len() == 1).await;
    module
}

/// Ends the scheduler's sleep and waits for its pass.
async fn pass(bench: &Bench) {
    assert!(bench.sleeper.wake(), "the scheduler sleeps");
    bench.until(|| bench.sleeper.pending().len() == 1).await;
}

fn schedule(bench: &Bench, routine: &str) -> Option<StoredSignalSchedule> {
    let id = routine.to_owned();
    let rows = bench.temp.store.read_blocking(move |tx| tx.signal_schedules().of_routine(&id)).expect("reads");
    rows.into_iter().next()
}

fn runs_of(bench: &Bench, routine: &str) -> usize {
    bench.admitted().iter().filter(|(id, _)| id == routine).count()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_closed_app_or_a_sleep_fires_each_schedule_once_and_counts_what_it_missed() {
    let bench = bench(vec![daily_at_five("rt-day"), hourly("rt-hour", RoutineState::Active)]);
    let module = started(&bench, true).await;
    assert!(bench.admitted().is_empty(), "nothing is due when a schedule is armed");

    bench.clock.advance(8 * HOUR + 10 * MINUTE);
    pass(&bench).await;
    assert_eq!((runs_of(&bench, "rt-day"), runs_of(&bench, "rt-hour")), (0, 1));
    let hour = schedule(&bench, "rt-hour").expect("a row");
    assert_eq!((hour.last_slot_at, hour.missed), (Some(MONDAY_14 + 8 * HOUR), 7), "22:00 ran for 15:00 to 21:00");
    assert_eq!((hour.late_by_ms, hour.next_at), (15 * MINUTE, Some(MONDAY_14 + 9 * HOUR)));

    bench.clock.advance(7 * DAY);
    pass(&bench).await;
    assert_eq!((runs_of(&bench, "rt-day"), runs_of(&bench, "rt-hour")), (1, 2), "one run each");
    let day = schedule(&bench, "rt-day").expect("a row");
    assert_eq!((day.last_slot_at, day.missed), (Some(MONDAY_14 + 7 * DAY - 9 * HOUR), 6));
    assert_eq!(schedule(&bench, "rt-hour").expect("a row").missed, 7 * 24 - 1);

    let tally = |routine: &'static str| {
        let slots = bench.temp.store.read_blocking(move |tx| tx.signal_routes().slots(routine, 0, 5 * MINUTE));
        let slots = slots.expect("reads");
        (slots.missed, slots.late)
    };
    assert_eq!(tally("rt-hour"), (7 + 7 * 24 - 1, 2), "what the routine's counts show");
    assert_eq!(tally("rt-day"), (6, 1));

    pass(&bench).await;
    assert_eq!(bench.admitted().len(), 3, "a slot fires once");
    let routes = bench.routes();
    assert!(routes.iter().all(|(.., decision, _, run)| decision == "run" && run.is_some()), "{routes:?}");
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_clock_set_back_fires_nothing_twice() {
    let bench = bench(vec![hourly("rt-hour", RoutineState::Active)]);
    let module = started(&bench, true).await;
    bench.clock.advance(HOUR);
    pass(&bench).await;
    assert_eq!(bench.admitted().len(), 1);

    bench.clock.advance(-2 * HOUR);
    pass(&bench).await;
    bench.clock.advance(HOUR + 30 * MINUTE);
    pass(&bench).await;
    assert_eq!(bench.admitted().len(), 1, "15:00 ran already");
    bench.clock.advance(HOUR + 30 * MINUTE);
    pass(&bench).await;
    assert_eq!(bench.admitted().len(), 2, "16:00 is new");
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_slot_fired_years_ahead_is_reset_once_when_the_clock_comes_back() {
    let bench = bench(vec![hourly("rt-hour", RoutineState::Active)]);
    let module = started(&bench, true).await;
    bench.clock.advance(3 * 365 * DAY);
    pass(&bench).await;
    assert_eq!(bench.admitted().len(), 1);

    bench.clock.set(MONDAY_14 + 30 * MINUTE);
    pass(&bench).await;
    let row = schedule(&bench, "rt-hour").expect("a row");
    assert_eq!(row.last_slot_at, Some(MONDAY_14 + 30 * MINUTE), "reset to now");
    bench.clock.advance(15 * MINUTE);
    pass(&bench).await;
    assert_eq!(schedule(&bench, "rt-hour").expect("a row").last_slot_at, Some(MONDAY_14 + 30 * MINUTE), "once");
    bench.clock.advance(15 * MINUTE);
    pass(&bench).await;
    assert_eq!(bench.admitted().len(), 2, "the next slot fires as usual");
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_schedule_switched_on_at_two_does_not_run_its_five_oclock_slot_until_tomorrow() {
    let bench = bench(vec![daily_at_five("rt-day")]);
    let module = started(&bench, true).await;
    bench.clock.advance(HOUR);
    pass(&bench).await;
    assert!(bench.admitted().is_empty());
    assert_eq!(schedule(&bench, "rt-day").expect("a row").next_at, Some(MONDAY_14 + 15 * HOUR));

    bench.clock.set(MONDAY_14 + 15 * HOUR);
    pass(&bench).await;
    assert_eq!(bench.admitted().len(), 1);
    assert_eq!(schedule(&bench, "rt-day").expect("a row").missed, 0);
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_paused_routine_fires_nothing_and_its_resume_does_not_backfill() {
    let bench = bench(vec![hourly("rt-hour", RoutineState::Active), hourly("rt-off", RoutineState::Paused)]);
    let module = started(&bench, true).await;
    bench.directory.set(vec![hourly("rt-hour", RoutineState::Paused), hourly("rt-off", RoutineState::Paused)]);
    pass(&bench).await;
    bench.clock.advance(5 * HOUR + 30 * MINUTE);
    pass(&bench).await;
    assert!(bench.admitted().is_empty(), "no schedule fires while paused");
    assert!(schedule(&bench, "rt-off").is_none());

    bench.directory.set(vec![hourly("rt-hour", RoutineState::Active), hourly("rt-off", RoutineState::Paused)]);
    pass(&bench).await;
    assert!(bench.admitted().is_empty(), "the slots while paused stay unrun");
    bench.clock.advance(30 * MINUTE);
    pass(&bench).await;
    assert_eq!(bench.admitted().len(), 1);
    assert_eq!(schedule(&bench, "rt-hour").expect("a row").missed, 0);
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn outside_the_installed_app_a_due_slot_is_held_and_starts_nothing() {
    let bench = bench(vec![hourly("rt-hour", RoutineState::Active)]);
    let module = started(&bench, false).await;
    bench.clock.advance(HOUR);
    pass(&bench).await;
    let routes = bench.routes();
    assert_eq!(routes.len(), 1);
    assert_eq!((routes[0].2.as_str(), routes[0].4.as_ref()), ("held-dev", None));
    assert!(bench.admitted().is_empty());
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wake_fires_a_due_slot_without_waiting_for_the_sleep_to_end() {
    let bench = bench(vec![hourly("rt-hour", RoutineState::Active)]);
    let module = started(&bench, true).await;
    bench.clock.advance(HOUR);
    bench.bus.publish_raw("system:wake", None, br#"{"awayMs":3600000}"#.as_slice().into());
    bench.until(|| bench.admitted().len() == 1).await;
    module.stop().await;
}
