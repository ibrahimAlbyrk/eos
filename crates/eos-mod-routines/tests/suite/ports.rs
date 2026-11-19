//! The ports the other areas call: admitting triggered runs inside their
//! own writes, the routines' triggers, a worker's run, routine control and
//! `runs:active`.

use eos_contracts::{ResultMode, RoutineState, RunInput};
use eos_core::{Clock, Error};
use eos_core::routine::{Admission, AdmitOutcome, AdmitRefusal, RoutineLoad};
use eos_core::store::StoredRoutineSession;
use eos_domain::routine::run::{Reason, RunState};
use eos_domain::run_scope::{RunRole, Trust};
use serde_json::{Value, json};

use crate::bench::{Bench, HOUR, blueprint, pull_request};

fn admission(routine: &str, signal_id: i64, number: u32) -> Admission {
    Admission {
        routine_id: routine.into(),
        signal_id,
        input: RunInput {
            item: Some(pull_request(number)),
            items: None,
            trigger: None,
            options: Default::default(),
            note: None,
            result: ResultMode::Usual,
            at: None,
        },
    }
}

impl Bench {
    fn admit(&self, admission: Admission) -> Result<AdmitOutcome, Error> {
        let intake = self.module.intake();
        self.temp.store.write_blocking(move |tx, out| intake.admit(tx, out, &admission))
    }

    fn topic(&self, name: &str) -> Vec<Value> {
        let announced = self.temp.announced.list().into_iter().filter(|(topic, _)| *topic == name);
        announced.map(|(_, payload)| serde_json::from_str(&payload).expect("json")).collect()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_signal_is_admitted_inside_the_callers_job_once() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, blueprint(1));

    let Ok(AdmitOutcome::Queued { run_id }) = bench.admit(admission(&routine, 41, 1)) else { panic!("admitted") };
    let run = bench.run(&run_id);
    assert_eq!((run.origin.as_str(), run.origin_ref.as_deref(), run.priority), ("trigger", Some("41"), 2));
    assert_eq!((run.state, run.item_key.as_deref()), (RunState::Queued, Some("github:pr:acme/game#1")));
    assert_eq!(bench.changes().len(), 1, "announced once its caller's job committed");

    // The same signal again: the store's index refuses it, and the caller's job is undone.
    assert!(bench.admit(admission(&routine, 41, 2)).is_err());
    assert_eq!(bench.changes().len(), 1);
    // A caller's job that fails takes the admission with it.
    let intake = bench.module.intake();
    let undone = bench.temp.store.write_blocking(move |tx, out| {
        intake.admit(tx, out, &admission(&routine, 42, 3))?;
        Err::<(), _>(Error::Conflict("the router changed its mind".into()))
    });
    assert!(undone.is_err());
    let queued = bench.temp.store.read_blocking(|tx| tx.runs().queued()).expect("reads");
    assert_eq!(queued.len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_full_queue_or_a_routine_that_is_not_active_refuses_a_triggered_run() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, blueprint(1));
    let paused = bench.routine(RoutineState::Paused, blueprint(1));
    assert_eq!(bench.admit(admission(&paused, 1, 1)), Ok(AdmitOutcome::Refused { reason: AdmitRefusal::NotActive }));
    assert_eq!(bench.admit(admission("rt-none", 1, 1)), Ok(AdmitOutcome::Refused { reason: AdmitRefusal::NotActive }));

    let intake = bench.module.intake();
    let routine_id = routine.clone();
    bench
        .temp
        .store
        .write_blocking(move |tx, out| {
            for signal in 0..200 {
                intake.admit(tx, out, &admission(&routine_id, signal, 1))?;
            }
            Ok(())
        })
        .expect("admits");
    assert_eq!(bench.admit(admission(&routine, 200, 1)), Ok(AdmitOutcome::Refused { reason: AdmitRefusal::QueueFull }));
}

#[tokio::test(flavor = "multi_thread")]
async fn supersede_load_and_the_runs_that_ended_in_order() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, blueprint(1));
    let first = bench.hand(&routine, Some(pull_request(1))).await;
    let second = bench.hand(&routine, Some(pull_request(2))).await;
    bench.clock.advance(HOUR);
    let third = bench.hand(&routine, Some(pull_request(3))).await;
    let intake = bench.module.intake();

    let since = bench.clock.now_ms() - 1;
    let load = {
        let (intake, routine) = (intake.clone(), routine.clone());
        bench.temp.store.read_blocking(move |tx| intake.load(tx, &routine, since)).expect("reads")
    };
    assert_eq!(load, RoutineLoad { queued: 3, started_since: 1, active: 0 });

    let superseded = {
        let (intake, id) = (intake.clone(), second.clone());
        bench.temp.store.write_blocking(move |tx, out| intake.supersede(tx, out, &id)).expect("writes")
    };
    assert!(superseded);
    let run = bench.run(&second);
    assert_eq!((run.state, run.reason), (RunState::Skipped, Some(Reason::Superseded)));

    // Ended later, listed later; a run that ended is not superseded again.
    bench.runs.stop(&third, Reason::User).await.expect("stops");
    bench.runs.stop(&first, Reason::User).await.expect("stops");
    let again = {
        let (intake, id) = (intake.clone(), second.clone());
        bench.temp.store.write_blocking(move |tx, out| intake.supersede(tx, out, &id)).expect("writes")
    };
    assert!(!again);
    let ended = |after: i64, limit: i64| {
        let (intake, routine) = (intake.clone(), routine.clone());
        bench.temp.store.read_blocking(move |tx| intake.finished_after(tx, &routine, after, limit)).expect("reads")
    };
    let all = ended(0, 10);
    let ids: Vec<&str> = all.iter().map(|run| run.run_id.as_str()).collect();
    assert_eq!(ids, [second.as_str(), third.as_str(), first.as_str()]);
    assert_eq!((all[0].state, all[0].reason), (RunState::Skipped, Some(Reason::Superseded)));
    assert!(all.windows(2).all(|pair| pair[0].seq < pair[1].seq));
    let after_first = ended(all[0].seq, 1);
    assert_eq!(after_first.iter().map(|run| run.run_id.as_str()).collect::<Vec<_>>(), [third.as_str()]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_workers_run_reads_the_same_async_and_inside_a_job() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, blueprint(1));
    let run = bench.hand(&routine, Some(pull_request(1))).await;
    bench.supervise().await;
    bench.eventually(|| bench.state(&run) == RunState::Running).await;
    let rows = [("w-lead", Some(run.clone()), "solo", Some("editor")), ("w-arch", None, "architect", None)];
    let routine_id = routine.clone();
    bench
        .temp
        .store
        .write_blocking(move |tx, _| {
            for (worker, run, role, agent) in rows {
                tx.routine_sessions().insert(&StoredRoutineSession {
                    worker_id: worker.into(),
                    routine_id: routine_id.clone(),
                    run_id: run,
                    role: role.into(),
                    agent_key: agent.map(str::to_owned),
                    created_at: 1,
                })?;
            }
            Ok(())
        })
        .expect("writes");

    let lookup = bench.module.lookup();
    let found = lookup.run_of("w-lead").await.expect("a run");
    assert_eq!(
        (found.run_id.as_str(), found.routine_id.as_str(), found.kind.as_str()),
        (run.as_str(), routine.as_str(), "standing")
    );
    assert_eq!(
        (found.role, found.agent_key.as_deref(), found.origin.as_str()),
        (RunRole::Solo, Some("editor"), "hand")
    );
    assert_eq!(Some(found.version_id.clone()), bench.run(&run).version_id);
    assert_eq!(found.trust, Trust::Untrusted, "its pull request is outside text");
    assert_eq!(found.output_dir, std::path::PathBuf::from(format!("routines/{routine}/runs/{run}")));
    assert_eq!(lookup.run_of("w-arch").await, None, "the architect works for no run");
    assert_eq!(lookup.run_of("w-chat").await, None);
    let in_job = bench.temp.store.read_blocking(|tx| tx.routine_sessions().run_of("w-lead")).expect("reads");
    assert_eq!(in_job, Some(found));
}

#[tokio::test(flavor = "multi_thread")]
async fn runs_active_is_announced_only_when_its_counts_change() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, blueprint(3));
    let queued = bench.hand(&routine, Some(pull_request(1))).await;
    bench.runs.stop(&queued, Reason::User).await.expect("stops");
    assert!(bench.topic("runs:active").is_empty(), "a queued run never worked");

    let working = bench.hand(&routine, Some(pull_request(2))).await;
    bench.supervise().await;
    bench.eventually(|| bench.state(&working) == RunState::Running).await;
    assert_eq!(bench.topic("runs:active"), [json!({"count": 1, "needsUser": 0})]);
    bench.temp.exec(&format!("UPDATE runs SET state = 'checking' WHERE id = '{working}'"));
    bench.runs.stop(&working, Reason::User).await.expect("stops");
    assert_eq!(bench.topic("runs:active"), [json!({"count": 1, "needsUser": 0}), json!({"count": 0, "needsUser": 0})]);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_directory_lists_what_starts_each_routine() {
    let bench = Bench::new(true);
    let active = bench.routine(RoutineState::Active, blueprint(1));
    let paused = bench.routine(RoutineState::Paused, blueprint(1));
    bench.routine(RoutineState::Deleted, blueprint(1));
    bench.routine(RoutineState::Draft, blueprint(1));
    let triggers = bench.module.directory().triggers().await.expect("reads");
    let listed: Vec<(&str, RoutineState)> = triggers.iter().map(|t| (t.id.as_str(), t.state)).collect();
    assert_eq!(listed, [(active.as_str(), RoutineState::Active), (paused.as_str(), RoutineState::Paused)]);
    assert_eq!(triggers[0].when.on.len(), 1);
    let head = bench.temp.store.read_blocking(move |tx| tx.routines().find(&active)).expect("reads");
    assert_eq!(head.and_then(|r| r.head_version_id), Some(triggers[0].version.clone()));
}
