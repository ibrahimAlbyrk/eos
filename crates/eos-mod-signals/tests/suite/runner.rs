//! Acting only as a routine's holder: a routine another computer holds gets
//! `elsewhere`, one whose holder is not known yet keeps its signals
//! waiting, and nothing acts after a launch until the leases were read or
//! two minutes passed.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use eos_contracts::RoutineState;
use eos_core::signals::{DeviceReport, DeviceSeen, Handoff, Holder, Runner, RunnerError};
use eos_core::{BoxFuture, Clock};
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
    assert!(leases.adopted.lock().expect("not poisoned").is_empty(), "nothing is adopted before a read: its lease may exist");

    *leases.confirmed_at.lock().expect("not poisoned") = Some(bench.clock.now_ms());
    pass(&bench).await;
    bench.until(|| bench.received() == 0).await;
    assert_eq!(*leases.adopted.lock().expect("not poisoned"), ["rt-away".to_owned()]);
    assert_eq!(decisions(&bench), [("rt-away".into(), "run".into()), ("rt-here".into(), "run".into())]);
    module.stop().await;
}
