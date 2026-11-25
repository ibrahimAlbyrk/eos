//! Acting only as a routine's holder: a routine another computer holds gets
//! `elsewhere`, one whose holder is not known yet keeps its signals
//! waiting, and nothing acts after a launch until the leases were read or
//! two minutes passed. The computer a routine moved from stops its
//! sources and schedules and lets its queued runs go as moved.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use eos_contracts::RoutineState;
use eos_core::routine::{Admission, AdmitOutcome, FinishedRun, RoutineLoad, RunIntake};
use eos_core::signals::{DeviceReport, DeviceSeen, Handoff, Holder, Runner, RunnerError};
use eos_core::store::{Outbox, Tx};
use eos_core::{BoxFuture, Clock, Error};
use eos_mod_signals::FIRST_READ_WAIT_MS;
use eos_runtime::module::Module;
use serde_json::json;

use crate::rig::{Bench, SOURCE_ID, SavedIntake, page, pull, routine};

/// Leases as a test sets them; adopting takes a first lease.
#[derive(Default)]
pub(crate) struct Leases {
    holders: Mutex<HashMap<String, Holder>>,
    pub(crate) confirmed_at: Mutex<Option<i64>>,
    adopted: Mutex<Vec<String>>,
    /// What a claim hands over; without one a claim is lost to `dev-2`.
    pub(crate) handoff: Mutex<Option<Handoff>>,
    pub(crate) devices: Mutex<Vec<DeviceSeen>>,
    /// Another computer's heartbeat counts, by routine.
    pub(crate) hourly: Mutex<HashMap<String, (i64, Vec<i64>)>>,
}

impl Leases {
    pub(crate) fn hold(&self, routine: &str, holder: Holder) {
        self.holders.lock().expect("not poisoned").insert(routine.into(), holder);
    }
}

impl Runner for Leases {
    fn device_id(&self) -> &str {
        "dev-1"
    }
    fn holder(&self, routine_id: &str) -> Holder {
        self.holders.lock().expect("not poisoned").get(routine_id).cloned().unwrap_or(Holder::Unknown)
    }
    fn adopt<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<(), RunnerError>> {
        self.adopted.lock().expect("not poisoned").push(routine_id.into());
        self.hold(routine_id, Holder::Here { epoch: 1 });
        Box::pin(std::future::ready(Ok(())))
    }
    fn claim<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<Handoff, RunnerError>> {
        let claimed = match self.handoff.lock().expect("not poisoned").clone() {
            Some(handoff) => {
                self.hold(routine_id, Holder::Here { epoch: handoff.epoch });
                Ok(handoff)
            }
            None => Err(RunnerError::Lost { holder: "dev-2".into(), epoch: 2 }),
        };
        Box::pin(std::future::ready(claimed))
    }
    fn report<'a>(&'a self, _report: &'a DeviceReport) -> BoxFuture<'a, Result<(), RunnerError>> {
        Box::pin(std::future::ready(Ok(())))
    }
    fn devices(&self) -> Vec<DeviceSeen> {
        self.devices.lock().expect("not poisoned").clone()
    }
    fn confirmed_at(&self) -> Option<i64> {
        *self.confirmed_at.lock().expect("not poisoned")
    }
    fn shared(&self) -> bool {
        true
    }
    fn hourly_elsewhere(&self, routine_id: &str) -> Option<(i64, Vec<i64>)> {
        self.hourly.lock().expect("not poisoned").get(routine_id).cloned()
    }
}

fn bench(leases: &Arc<Leases>) -> Bench {
    let mut bench = Bench::new(vec![
        routine("rt-here", RoutineState::Active, &["opened"], None),
        routine("rt-away", RoutineState::Active, &["opened"], None),
    ]);
    bench.runner = leases.clone();
    bench
}

fn one_pull() -> eos_core::signals::PollPage {
    page(vec![pull(1, "aaa", "opened", false, &["a.rs"])], json!({"etag": "e1"}))
}

/// Ends the scheduler's sleep: a pass, which kicks the router.
async fn pass(bench: &Bench) {
    bench.until(|| bench.sleeper.pending().len() == 1).await;
    assert!(bench.sleeper.wake(), "the scheduler sleeps");
}

fn decisions(bench: &Bench) -> Vec<(String, String)> {
    bench.routes().into_iter().map(|(_, routine, decision, ..)| (routine, decision)).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_routine_another_computer_holds_gets_elsewhere_and_no_run() {
    let leases = Arc::new(Leases::default());
    leases.hold("rt-here", Holder::Here { epoch: 1 });
    leases.hold("rt-away", Holder::Elsewhere { device_id: "dev-2".into(), epoch: 3 });
    *leases.confirmed_at.lock().expect("not poisoned") = Some(6_000);
    let bench = bench(&leases);
    let module = bench.module(bench.temp.port(), Arc::new(SavedIntake::new(None)), true);
    module.ingest(SOURCE_ID, one_pull()).await.expect("kept");
    bench.route(&module).await;
    assert_eq!(decisions(&bench), [("rt-away".into(), "elsewhere".into()), ("rt-here".into(), "run".into())]);
    assert_eq!(bench.admitted(), [("rt-here".to_owned(), 1)]);
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn after_a_launch_nothing_acts_until_the_leases_were_read_or_two_minutes_passed() {
    let leases = Arc::new(Leases::default());
    leases.hold("rt-here", Holder::Here { epoch: 1 });
    leases.hold("rt-away", Holder::Here { epoch: 1 });
    let bench = bench(&leases);
    let module = bench.module(bench.temp.port(), Arc::new(SavedIntake::new(None)), true);
    module.ingest(SOURCE_ID, one_pull()).await.expect("kept");
    module.after_ready().await.expect("ready");
    bench.until(|| bench.sleeper.pending().len() == 1).await;
    assert_eq!(bench.received(), 1, "the signal waits for a read of the leases");
    assert!(bench.routes().is_empty());

    // No read for two minutes: the last view holds.
    bench.clock.advance(FIRST_READ_WAIT_MS);
    pass(&bench).await;
    bench.until(|| bench.received() == 0).await;
    assert_eq!(decisions(&bench).len(), 2);
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_read_of_the_leases_lets_this_computer_act_and_adopt_what_no_lease_names() {
    let leases = Arc::new(Leases::default());
    leases.hold("rt-here", Holder::Here { epoch: 1 });
    let bench = bench(&leases);
    let module = bench.module(bench.temp.port(), Arc::new(SavedIntake::new(None)), true);
    module.ingest(SOURCE_ID, one_pull()).await.expect("kept");
    module.after_ready().await.expect("ready");
    bench.until(|| bench.sleeper.pending().len() == 1).await;
    assert!(
        leases.adopted.lock().expect("not poisoned").is_empty(),
        "nothing is adopted before a read: its lease may exist"
    );

    *leases.confirmed_at.lock().expect("not poisoned") = Some(bench.clock.now_ms());
    pass(&bench).await;
    bench.until(|| bench.received() == 0).await;
    assert_eq!(*leases.adopted.lock().expect("not poisoned"), ["rt-away".to_owned()]);
    assert_eq!(decisions(&bench), [("rt-away".into(), "run".into()), ("rt-here".into(), "run".into())]);
    module.stop().await;
}

/// Notes the routines whose queued runs it was asked to cancel as moved.
struct MovingIntake {
    saved: SavedIntake,
    moved: Mutex<Vec<String>>,
}

impl RunIntake for MovingIntake {
    fn admit(&self, tx: &dyn Tx, out: &mut Outbox, admission: &Admission) -> Result<AdmitOutcome, Error> {
        self.saved.admit(tx, out, admission)
    }
    fn supersede(&self, tx: &dyn Tx, out: &mut Outbox, run_id: &str) -> Result<bool, Error> {
        self.saved.supersede(tx, out, run_id)
    }
    fn load(&self, tx: &dyn Tx, routine_id: &str, since: i64) -> Result<RoutineLoad, Error> {
        self.saved.load(tx, routine_id, since)
    }
    fn finished_after(&self, tx: &dyn Tx, routine_id: &str, after: i64, limit: i64) -> Result<Vec<FinishedRun>, Error> {
        self.saved.finished_after(tx, routine_id, after, limit)
    }
    fn moved_away(&self, _tx: &dyn Tx, _out: &mut Outbox, routine_ids: &[String]) -> Result<usize, Error> {
        self.moved.lock().expect("not poisoned").extend_from_slice(routine_ids);
        Ok(routine_ids.len())
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_computer_a_routine_moved_from_stops_its_source_and_schedule_and_cancels_its_queued_runs() {
    const HOUR: i64 = 60 * 60_000;
    let leases = Arc::new(Leases::default());
    leases.hold("rt-away", Holder::Here { epoch: 1 });
    let mut away = routine("rt-away", RoutineState::Active, &["opened"], None);
    let hourly = json!({ "schedule": { "every": 60, "days": "all", "zone": "UTC" } });
    away.when.on.push(serde_json::from_value(hourly).expect("a trigger"));
    let mut bench = Bench::new(vec![away]);
    bench.runner = leases.clone();
    *leases.confirmed_at.lock().expect("not poisoned") = Some(bench.clock.now_ms());
    let intake = Arc::new(MovingIntake { saved: SavedIntake::new(None), moved: Mutex::default() });
    let module = bench.module(bench.temp.port(), intake.clone(), true);
    module.after_ready().await.expect("ready");
    let source = || bench.temp.store.read_blocking(|tx| tx.signal_sources().find(SOURCE_ID)).expect("reads");
    bench.until(|| source().is_some_and(|row| row.last_poll_at.is_some())).await;
    assert!(intake.moved.lock().expect("not poisoned").is_empty(), "held here, nothing moves");

    // The first read after a wake shows that another computer took it over.
    leases.hold("rt-away", Holder::Elsewhere { device_id: "dev-2".into(), epoch: 2 });
    bench.clock.advance(2 * HOUR);
    // A pass; the poll that settles may end the sleep first.
    bench.until(|| bench.sleeper.wake()).await;
    bench.until(|| source().is_some_and(|row| row.state == "stopped")).await;
    assert_eq!(*intake.moved.lock().expect("not poisoned"), ["rt-away".to_owned()], "its queued runs go as moved");
    bench.until(|| bench.sleeper.wake()).await;
    assert_eq!(bench.temp.count("SELECT count(*) FROM signals WHERE kind = 'clock'"), 0, "no slot fired here");

    module.ingest(SOURCE_ID, one_pull()).await.expect("kept");
    bench.route(&module).await;
    assert_eq!(decisions(&bench), [("rt-away".into(), "elsewhere".into())]);
    assert!(bench.admitted().is_empty());
    module.stop().await;
}
