//! "Stop everything" and the battery in the run engine: halt ends the runs
//! at work as `halted`, keeps the queue and refuses starts; resume lets the
//! queue go on. Runs from triggers wait on a low battery; hand runs start.

use eos_contracts::{HaltState, RoutineState};
use eos_core::os::PowerStatus;
use eos_core::routine::{RunOrigin, StartError};
use eos_core::store::StoredHalt;
use eos_domain::routine::run::{Reason, RunState, Station};
use serde_json::json;

use crate::bench::{Bench, blueprint, new_run, pull_request};
use crate::run_routes::Routes;

impl Bench {
    /// Switches halt as Needs you does: the row and `inbox:halt` in one job.
    fn switch_halt(&self, on: bool) {
        let since = on.then_some(1);
        self.temp
            .store
            .write_blocking(move |tx, out| {
                tx.inbox_halt().put(&StoredHalt { on, since, by: Some("dashboard".into()), updated_at: 1 })?;
                out.push("inbox:halt", &HaltState { on, since });
                Ok(())
            })
            .expect("switched");
    }

    /// One more turn of the supervisor's loop.
    async fn turn(&self) {
        self.eventually(|| !self.sleeper.pending().is_empty()).await;
        assert!(self.sleeper.wake());
        self.eventually(|| !self.sleeper.pending().is_empty()).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn halt_cancels_the_runs_at_work_keeps_the_queue_and_refuses_starts_until_resumed() {
    let routes = Routes::new();
    let bench = &routes.bench;
    let roomy = bench.routine(RoutineState::Active, blueprint(3));
    let narrow = bench.routine(RoutineState::Active, blueprint(1));
    let running = bench.hand(&roomy, Some(pull_request(1))).await;
    let checking = bench.hand(&roomy, Some(pull_request(2))).await;
    let narrow_first = bench.hand(&narrow, Some(pull_request(3))).await;
    let queued = bench.hand(&narrow, Some(pull_request(4))).await;
    bench.supervise().await;
    for id in [&running, &checking, &narrow_first] {
        bench.eventually(|| bench.run(id).station == Some(Station::Work)).await;
    }
    bench.temp.exec(&format!("UPDATE runs SET state = 'checking' WHERE id = '{checking}'"));

    bench.switch_halt(true);
    for id in [&running, &checking, &narrow_first] {
        bench.eventually(|| bench.state(id) == RunState::Cancelled).await;
        assert_eq!(bench.run(id).reason, Some(Reason::Halted), "{id}");
    }
    bench.turn().await;
    assert_eq!(bench.state(&queued), RunState::Queued, "nothing leaves the queue while Eos is stopped");
    let refused = bench.start(new_run(&roomy, RunOrigin::Hand, Some(pull_request(5)))).await;
    assert_eq!(refused.map(drop), Err(StartError::Halted));
    let body = json!({"routineId": roomy, "input": {"result": "usual"}, "door": "routine_page",
                      "items": [pull_request(6)]});
    let (status, answer) = routes.post("/api/runs", body).await;
    assert_eq!((status, answer), (409, json!({"error": "Eos is stopped", "code": "halted"})));

    bench.switch_halt(false);
    bench.eventually(|| bench.state(&queued) == RunState::Running).await;
    assert_eq!(bench.state(&running), RunState::Cancelled, "nothing that ended starts again");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_halt_switched_on_before_eos_quit_ends_the_runs_it_finds_at_work() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, blueprint(3));
    let working = bench.hand(&routine, Some(pull_request(1))).await;
    let queued = bench.hand(&routine, Some(pull_request(2))).await;
    bench.temp.exec(&format!("UPDATE runs SET state = 'running', station = 'work' WHERE id = '{working}'"));
    bench.temp.exec("INSERT INTO inbox_halt (id, \"on\", since, by, updated_at) VALUES (1, 1, 1, 'dashboard', 1)");

    bench.supervise().await;
    let run = bench.run(&working);
    assert_eq!((run.state, run.reason), (RunState::Cancelled, Some(Reason::Halted)));
    bench.turn().await;
    assert_eq!(bench.state(&queued), RunState::Queued);
}

#[tokio::test(flavor = "multi_thread")]
async fn on_a_low_battery_runs_from_triggers_wait_and_runs_by_hand_start() {
    let bench = Bench::new(true);
    let routine = bench.routine_with(RoutineState::Active, blueprint(3), true);
    bench.power.set(PowerStatus { on_battery: true, battery_percent: Some(15), low_power: false });
    let agent = new_run(&routine, RunOrigin::Agent { worker_id: "w-chat".into() }, Some(pull_request(1)));
    let waiting = bench.start(agent).await.expect("queued").remove(0).id;
    let hand = bench.hand(&routine, Some(pull_request(2))).await;
    bench.supervise().await;
    bench.eventually(|| bench.state(&hand) == RunState::Running).await;
    bench.turn().await;
    assert_eq!(bench.state(&waiting), RunState::Queued, "it waits for the charger");

    bench.power.set(PowerStatus { on_battery: false, battery_percent: Some(15), low_power: true });
    bench.turn().await;
    assert_eq!(bench.state(&waiting), RunState::Queued, "Low Power Mode holds it too");

    bench.power.set(PowerStatus { on_battery: true, battery_percent: Some(20), low_power: false });
    bench.turn().await;
    bench.eventually(|| bench.state(&waiting) == RunState::Running).await;
}
