//! The work holds: one `Run` hold however many runs work, `Armed` while a
//! schedule waits, `Run` for schedules only with the setting on and mains
//! power, `Run` while a pass after a wake writes its admissions; and the
//! keep-awake offer, once, after the first schedule that ran over half an
//! hour late.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use eos_contracts::{RoutineKind, RoutineState, SettingValue};
use eos_core::{Clock, Error};
use eos_core::os::{HoldReason, PowerStatus};
use eos_core::routine::{Admission, AdmitOutcome, RoutineLoad, RoutineTriggers, RunIntake};
use eos_core::store::{Outbox, Tx};
use eos_mod_signals::SignalsModule;
use eos_runtime::module::Module;
use eos_testkit::FakeWorkHold;
use serde_json::json;

use crate::rig::{Bench, SavedIntake};

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

fn bench(routines: Vec<RoutineTriggers>) -> Bench {
    let bench = Bench::new(routines);
    bench.clock.set(MONDAY_14 + 5 * MINUTE);
    bench
}

async fn started(bench: &Bench, intake: Arc<dyn RunIntake>) -> SignalsModule {
    let module = bench.module(bench.temp.port(), intake, true);
    module.after_ready().await.expect("ready");
    bench.until(|| bench.sleeper.pending().len() == 1).await;
    module
}

/// Ends the scheduler's sleep, once a pass a poll started is over, and
/// waits for its pass.
async fn pass(bench: &Bench) {
    bench.until(|| bench.sleeper.wake()).await;
    bench.until(|| bench.sleeper.pending().len() == 1).await;
}

fn live(bench: &Bench) -> (usize, usize) {
    (bench.holds.live(HoldReason::Run), bench.holds.live(HoldReason::Armed))
}

fn add_run(bench: &Bench, id: &str, state: &str) {
    bench.temp.exec(&format!(
        "INSERT INTO runs (id, routine_id, kind, origin, input, state, priority, device, created_at, updated_at) \
         VALUES ('{id}', 'rt-pr', 'standing', 'trigger', '{{}}', '{state}', 0, 'dev-1', 1, 1)"
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn two_working_runs_take_one_run_hold_dropped_once_both_ended() {
    // No routine reads a source here: a poll's end would start a pass of its own.
    let bench = bench(vec![]);
    let module = started(&bench, Arc::new(SavedIntake::new(None))).await;
    assert_eq!(live(&bench), (0, 0), "nothing works and no schedule waits");

    add_run(&bench, "rn-1", "running");
    add_run(&bench, "rn-2", "delivering");
    add_run(&bench, "rn-3", "waiting_for_user");
    pass(&bench).await;
    assert_eq!(live(&bench), (1, 0));
    bench.temp.exec("UPDATE runs SET state = 'done' WHERE id = 'rn-1'");
    pass(&bench).await;
    assert_eq!(live(&bench), (1, 0), "one still works");
    bench.temp.exec("UPDATE runs SET state = 'done' WHERE id = 'rn-2'");
    pass(&bench).await;
    assert_eq!(live(&bench), (0, 0), "waiting for the user is not work");
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_armed_schedule_keeps_the_app_working_and_the_computer_awake_only_on_mains_with_the_setting() {
    let bench = bench(vec![hourly("rt-hour")]);
    let module = started(&bench, Arc::new(SavedIntake::new(None))).await;
    assert_eq!(live(&bench), (0, 1), "armed, the setting off");

    bench.settings.0.lock().expect("settings").insert("signals.keepAwakeForSchedules".into(), SettingValue::Flag(true));
    pass(&bench).await;
    assert_eq!(live(&bench), (1, 1), "on mains power");
    bench.power.set(PowerStatus { on_battery: true, battery_percent: Some(80), low_power: false });
    pass(&bench).await;
    assert_eq!(live(&bench), (0, 1), "not on battery");

    bench.directory.set(vec![]);
    pass(&bench).await;
    assert_eq!(live(&bench), (0, 0));
    module.stop().await;
}

/// Records how many `Run` holds lived while each admission was written.
struct Watching {
    holds: Arc<FakeWorkHold>,
    inner: SavedIntake,
    held: AtomicUsize,
}

impl RunIntake for Watching {
    fn admit(&self, tx: &dyn Tx, out: &mut Outbox, admission: &Admission) -> Result<AdmitOutcome, Error> {
        self.held.store(self.holds.live(HoldReason::Run), Ordering::SeqCst);
        self.inner.admit(tx, out, admission)
    }

    fn supersede(&self, tx: &dyn Tx, out: &mut Outbox, run_id: &str) -> Result<bool, Error> {
        self.inner.supersede(tx, out, run_id)
    }

    fn load(&self, tx: &dyn Tx, routine_id: &str, since: i64) -> Result<RoutineLoad, Error> {
        self.inner.load(tx, routine_id, since)
    }

    fn finished_after(
        &self,
        tx: &dyn Tx,
        routine_id: &str,
        after_seq: i64,
        limit: i64,
    ) -> Result<Vec<eos_core::routine::FinishedRun>, Error> {
        self.inner.finished_after(tx, routine_id, after_seq, limit)
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pass_after_a_wake_holds_the_computer_awake_while_it_writes_its_admissions() {
    let bench = bench(vec![hourly("rt-hour")]);
    let intake =
        Arc::new(Watching { holds: bench.holds.clone(), inner: SavedIntake::new(None), held: AtomicUsize::new(9) });
    let module = started(&bench, intake.clone()).await;
    bench.clock.advance(HOUR);
    bench.bus.publish_raw("system:wake", None, br#"{"awayMs":3600000}"#.as_slice().into());
    bench.until(|| bench.admitted().len() == 1).await;
    assert_eq!(intake.held.load(Ordering::SeqCst), 1, "held while catching up");
    bench.until(|| bench.sleeper.pending().len() == 1).await;
    assert_eq!(live(&bench), (0, 1), "and let go after");

    bench.clock.advance(HOUR);
    pass(&bench).await;
    assert_eq!(intake.held.load(Ordering::SeqCst), 0, "a usual pass holds nothing");
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_first_schedule_over_half_an_hour_late_offers_to_keep_the_mac_awake_once() {
    let bench = bench(vec![hourly("rt-hour")]);
    let module = started(&bench, Arc::new(SavedIntake::new(None))).await;
    bench.clock.set(MONDAY_14 + HOUR + 25 * MINUTE);
    pass(&bench).await;
    assert_eq!(bench.admitted().len(), 1, "15:00 fired 25 min late");
    let offers = || bench.temp.count("SELECT count(*) FROM inbox_items WHERE subject_key = 'keep-awake'");
    assert_eq!(offers(), 0, "not late enough to offer");

    bench.clock.set(MONDAY_14 + 2 * HOUR + 40 * MINUTE);
    pass(&bench).await;
    assert_eq!(offers(), 1);
    let waiting = bench.temp.store.read_blocking(|tx| tx.inbox_items().waiting(10)).expect("reads");
    assert_eq!(waiting[0].title, "A routine ran 40 min late because the Mac was asleep");
    let offered = bench.settings.0.lock().expect("settings").get("signals.keepAwakeOffered").cloned();
    assert_eq!(offered, Some(SettingValue::Flag(true)));

    bench.temp.exec("UPDATE inbox_items SET state = 'expired' WHERE subject_key = 'keep-awake'");
    bench.clock.set(MONDAY_14 + 4 * HOUR + 50 * MINUTE);
    pass(&bench).await;
    assert_eq!(bench.admitted().len(), 3);
    assert_eq!(offers(), 1, "once on this Mac");
    module.stop().await;
}

/// The offer, opened by a schedule that fired 40 min late.
async fn offered(bench: &Bench) -> (SignalsModule, eos_core::store::StoredItem) {
    let module = started(bench, Arc::new(SavedIntake::new(None))).await;
    bench.clock.set(MONDAY_14 + 2 * HOUR + 40 * MINUTE);
    pass(bench).await;
    let waiting = bench.temp.store.read_blocking(|tx| tx.inbox_items().waiting(10)).expect("reads");
    (module, waiting.into_iter().next().expect("the offer"))
}

/// Answers the notice as Needs you does, and announces it.
fn answer(bench: &Bench, item: &eos_core::store::StoredItem, choice: &str) {
    let (id, rev) = (item.id.clone(), item.rev);
    let answer = eos_core::store::ItemAnswer {
        by: "dashboard".into(),
        answer: Some(json!({"kind": "notice", "choice": choice}).to_string()),
        at: bench.clock.now_ms(),
    };
    let done = bench.temp.store.write_blocking(move |tx, _| tx.inbox_items().answer(&id, rev, &answer));
    assert!(done.expect("answers"));
    let change = eos_contracts::InboxChange {
        id: item.id.clone(),
        kind: "notice".into(),
        state: "answered".into(),
        routine_id: item.routine_id.clone(),
        rev: rev + 1,
        open: 0,
    };
    bench.bus.publish(&eos_runtime::bus::Topic::new("inbox:change"), &change);
}

fn consumed(bench: &Bench, id: &str) -> bool {
    let id = id.to_owned();
    let item = bench.temp.store.read_blocking(move |tx| tx.inbox_items().find(&id)).expect("reads");
    item.expect("the item").consumed_at.is_some()
}

fn keep_awake(bench: &Bench) -> Option<SettingValue> {
    bench.settings.0.lock().expect("settings").get("signals.keepAwakeForSchedules").cloned()
}

#[tokio::test(flavor = "multi_thread")]
async fn taking_the_offer_turns_keeping_awake_on_and_dismissing_it_changes_nothing() {
    let bench = bench(vec![hourly("rt-hour")]);
    let (module, offer) = offered(&bench).await;
    answer(&bench, &offer, "act");
    bench.until(|| consumed(&bench, &offer.id)).await;
    assert_eq!(keep_awake(&bench), Some(SettingValue::Flag(true)));
    module.stop().await;

    let bench = self::bench(vec![hourly("rt-hour")]);
    let (module, offer) = offered(&bench).await;
    answer(&bench, &offer, "dismiss");
    bench.until(|| consumed(&bench, &offer.id)).await;
    assert_eq!(keep_awake(&bench), None);
    module.stop().await;
}
