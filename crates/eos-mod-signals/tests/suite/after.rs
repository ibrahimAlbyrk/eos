//! A routine's finished runs as a source: one signal per run that ended,
//! decided for each routine waiting on that outcome; a chain deeper than
//! three starts nothing.

use std::sync::{Arc, Mutex};

use eos_contracts::{ResultMode, RoutineKind, RoutineState, RunInput, RunTrigger};
use eos_core::Error;
use eos_core::routine::{Admission, AdmitOutcome, FinishedRun, RoutineLoad, RoutineTriggers, RunIntake};
use eos_core::store::{NewSignal, Outbox, Tx};
use eos_domain::routine::numbers::Outcome;
use eos_domain::routine::run::RunState;
use eos_runtime::module::Module;
use serde_json::json;

use crate::rig::{ADMITTED, Bench, SOURCE_ID, TableIntake};

/// Queues admissions as [`SavedIntake`](crate::rig::SavedIntake) does, and
/// answers the upstream's finished runs from a script.
struct Upstream {
    finished: Mutex<Vec<FinishedRun>>,
}

impl RunIntake for Upstream {
    fn admit(&self, _tx: &dyn Tx, out: &mut Outbox, admission: &Admission) -> Result<AdmitOutcome, Error> {
        out.push(ADMITTED, &json!({ "routine": admission.routine_id, "signal": admission.signal_id }));
        Ok(AdmitOutcome::Queued { run_id: format!("rn-{}-{}", admission.signal_id, admission.routine_id) })
    }

    fn supersede(&self, _tx: &dyn Tx, _out: &mut Outbox, _run_id: &str) -> Result<bool, Error> {
        Ok(false)
    }

    fn load(&self, _tx: &dyn Tx, _routine_id: &str, _since: i64) -> Result<RoutineLoad, Error> {
        Ok(RoutineLoad { queued: 0, started_since: 0, active: 0 })
    }

    fn finished_after(
        &self,
        _tx: &dyn Tx,
        routine_id: &str,
        after_seq: i64,
        limit: i64,
    ) -> Result<Vec<FinishedRun>, Error> {
        assert_eq!(routine_id, "rt-up");
        let finished = self.finished.lock().expect("unpoisoned");
        let later = finished.iter().filter(|run| run.seq > after_seq).take(usize::try_from(limit).unwrap_or(0));
        Ok(later.cloned().collect())
    }
}

fn finished(seq: i64, run_id: &str, state: RunState, outcome: Option<Outcome>) -> FinishedRun {
    FinishedRun { seq, run_id: run_id.into(), state, reason: None, outcome, ended_at: 1_000 + seq }
}

fn waiting_on(id: &str, outcome: &str) -> RoutineTriggers {
    RoutineTriggers {
        id: id.into(),
        version: format!("rv-{id}"),
        state: RoutineState::Active,
        kind: RoutineKind::Standing,
        when: serde_json::from_value(json!({ "on": [{ "after": { "routine": "rt-up", "outcome": outcome } }] }))
            .expect("a When"),
        which: Default::default(),
    }
}

fn run_changed(bench: &Bench) {
    bench.bus.publish_raw("run:change", None, b"{}".as_slice().into());
}

/// `(signal, routine, decision, reason)` of every route.
fn decided(bench: &Bench) -> Vec<(i64, String, String, Option<String>)> {
    bench
        .routes()
        .into_iter()
        .map(|(signal, routine, decision, reason, _)| (signal, routine, decision, reason))
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn each_finished_upstream_run_is_one_signal_for_the_routines_waiting_on_its_outcome() {
    let bench = Bench::new(vec![
        waiting_on("rt-done", "done"),
        waiting_on("rt-sent", "delivered"),
        waiting_on("rt-any", "any"),
    ]);
    // A run that ended before anything waited on it is not news.
    let upstream = Arc::new(Upstream { finished: Mutex::new(vec![finished(5, "rn-old", RunState::Done, None)]) });
    let module = bench.module(bench.temp.port(), upstream.clone(), true);
    module.after_ready().await.expect("ready");
    bench
        .until(|| {
            bench.temp.count("SELECT count(*) FROM signal_sources WHERE kind = 'after' AND cursor_json = '5'") == 1
        })
        .await;

    upstream.finished.lock().expect("unpoisoned").extend([
        finished(10, "rn-shown", RunState::Done, Some(Outcome::Shown)),
        finished(11, "rn-sent", RunState::Done, Some(Outcome::SentEdited)),
        finished(12, "rn-failed", RunState::Failed, None),
    ]);
    run_changed(&bench);
    bench.until(|| bench.admitted().len() == 6).await;
    run_changed(&bench);
    bench.until(|| bench.received() == 0).await;

    let row = |signal, routine: &str| (signal, routine.to_owned(), "run".to_owned(), None);
    assert_eq!(
        decided(&bench),
        [row(1, "rt-any"), row(1, "rt-done"), row(2, "rt-any"), row(2, "rt-done"), row(2, "rt-sent"), row(3, "rt-any")],
        "done takes what was shown or sent, delivered only what was sent, any every end"
    );
    let kinds =
        bench.temp.count("SELECT count(*) FROM signals WHERE kind IN ('done', 'delivered', 'failed') AND depth = 1");
    assert_eq!(kinds, 3, "one signal per run, a link deeper than a run started by hand");
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_chain_four_routines_deep_starts_nothing() {
    let bench = Bench::new(vec![waiting_on("rt-any", "any")]);
    // The upstream run was started by a signal three links deep.
    let deep = NewSignal {
        source_id: SOURCE_ID.into(),
        key: "routine:rt-x:run:rn-x".into(),
        subject: "routine:rt-x:run:rn-x".into(),
        version: None,
        kind: "done".into(),
        occurred_at: 1,
        received_at: 1,
        facts_json: None,
        item_json: "null".into(),
        depth: 3,
    };
    let table = TableIntake::new(bench.clock.clone());
    let run_id = bench
        .temp
        .store
        .write_blocking(move |tx, out| {
            let id = tx.signals().ingest(&deep)?.expect("kept");
            tx.signals().mark_routed(id)?;
            let input = RunInput {
                item: None,
                items: None,
                trigger: Some(RunTrigger { signal_id: id.to_string(), slot_at: None, late_by_ms: None }),
                options: Default::default(),
                note: None,
                result: ResultMode::Usual,
                at: None,
                surface: None,
                chat: None,
            };
            let admission = Admission { routine_id: "rt-up".into(), signal_id: id, input };
            match table.admit(tx, out, &admission)? {
                AdmitOutcome::Queued { run_id } => Ok(run_id),
                AdmitOutcome::Refused { .. } => Err(Error::Conflict("refused".into())),
            }
        })
        .expect("the upstream run");
    let upstream = Arc::new(Upstream { finished: Mutex::new(Vec::new()) });
    let module = bench.module(bench.temp.port(), upstream.clone(), true);
    module.after_ready().await.expect("ready");
    bench.until(|| bench.temp.count("SELECT count(*) FROM signal_sources WHERE kind = 'after'") == 1).await;

    upstream.finished.lock().expect("unpoisoned").push(finished(3, &run_id, RunState::Done, None));
    run_changed(&bench);
    bench.until(|| bench.decided("refused") == 1).await;
    assert_eq!(decided(&bench), [(2, "rt-any".to_owned(), "refused".to_owned(), Some("depth".to_owned()))]);
    assert!(bench.admitted().is_empty());
    module.stop().await;
}
