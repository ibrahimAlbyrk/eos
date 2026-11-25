//! The ports the other areas reach runs through: the signals' router admits
//! and counts runs inside its own write job (`Intake`), reads what starts
//! each routine (`Directory`), and any area asks which run a worker works
//! for (`Lookup`).

use std::sync::Arc;

use eos_contracts::RoutineState;
use eos_core::routine::{
    Admission, AdmitOutcome, AdmitRefusal, FinishedRun, RoutineDirectory, RoutineLoad, RoutineTriggers, RunIntake,
    RunLookup, RunRef,
};
use eos_core::store::{Outbox, RunMove, Tx};
use eos_core::{BoxFuture, Error};
use eos_domain::routine::item;
use eos_domain::routine::run::{Reason, RunState};

use super::start::kind_word;
use super::{Engine, Queued, move_run, queue_run};
use crate::routes::readable;

/// The queue holds at most this many runs; past it a triggered run is
/// refused.
pub(crate) const QUEUE_MAX: i64 = 200;
/// Triggered runs leave the queue after every other kind.
const TRIGGER_PRIORITY: i64 = 2;

pub(crate) struct Intake(pub(crate) Arc<Engine>);

impl RunIntake for Intake {
    fn admit(&self, tx: &dyn Tx, out: &mut Outbox, admission: &Admission) -> Result<AdmitOutcome, Error> {
        let refused = |reason| Ok(AdmitOutcome::Refused { reason });
        let routine = tx.routines().find(&admission.routine_id)?;
        let Some(routine) = routine.filter(|routine| routine.state == RoutineState::Active) else {
            return refused(AdmitRefusal::NotActive);
        };
        if tx.runs().queued_count()? >= QUEUE_MAX {
            tracing::warn!(routine_id = %routine.id, "a triggered run was refused: the queue is full");
            return refused(AdmitRefusal::QueueFull);
        }
        let run_id = self.0.ids.run_id();
        let input = &admission.input;
        // The signal is the run's origin: the store keeps one run of a routine per signal.
        queue_run(
            tx,
            out,
            Queued {
                version_id: None,
                id: run_id.clone(),
                routine_id: &routine.id,
                kind: kind_word(routine.kind),
                origin: "trigger",
                origin_ref: Some(admission.signal_id.to_string()),
                door: None,
                input,
                item_key: input.item.as_ref().and_then(item::key),
                priority: TRIGGER_PRIORITY,
                device: &self.0.device,
                now: self.0.clock.now_ms(),
            },
        )?;
        self.0.wake.notify_one();
        Ok(AdmitOutcome::Queued { run_id })
    }

    fn supersede(&self, tx: &dyn Tx, out: &mut Outbox, run_id: &str) -> Result<bool, Error> {
        let Some(run) = tx.runs().find(run_id)?.filter(|run| run.state == RunState::Queued) else {
            return Ok(false);
        };
        let skipped = RunMove {
            state: RunState::Skipped,
            station: None,
            reason: Some(Reason::Superseded),
            at: self.0.clock.now_ms(),
        };
        move_run(tx, out, &run, skipped)?;
        Ok(true)
    }

    fn load(&self, tx: &dyn Tx, routine_id: &str, since: i64) -> Result<RoutineLoad, Error> {
        tx.runs().load(routine_id, since)
    }

    fn finished_after(
        &self,
        tx: &dyn Tx,
        routine_id: &str,
        after_seq: i64,
        limit: i64,
    ) -> Result<Vec<FinishedRun>, Error> {
        tx.runs().finished_after(routine_id, after_seq, limit)
    }

    fn moved_away(&self, tx: &dyn Tx, out: &mut Outbox, routine_ids: &[String]) -> Result<usize, Error> {
        let now = self.0.clock.now_ms();
        let mut moved = 0;
        for run in tx.runs().queued()? {
            if !routine_ids.contains(&run.routine_id) || run.origin != "trigger" {
                continue;
            }
            let cancelled = RunMove { state: RunState::Cancelled, station: None, reason: Some(Reason::Moved), at: now };
            move_run(tx, out, &run, cancelled)?;
            moved += 1;
        }
        Ok(moved)
    }
}

pub(crate) struct Directory(pub(crate) Arc<Engine>);

impl RoutineDirectory for Directory {
    fn triggers(&self) -> BoxFuture<'_, Result<Vec<RoutineTriggers>, Error>> {
        Box::pin(self.0.store.read(|tx| {
            let mut triggers = Vec::new();
            for routine in tx.routines().list()? {
                // A built-in routine has no trigger and is no Mac's to hold (01 G49).
                if routine.state == RoutineState::Deleted || routine.origin == crate::routes::BUILTIN {
                    continue;
                }
                let Some(head) = tx.routine_versions().head(&routine.id)? else { continue };
                let Some(blueprint) = readable(&head)? else { continue };
                triggers.push(RoutineTriggers {
                    id: routine.id,
                    version: head.id,
                    state: routine.state,
                    kind: routine.kind,
                    when: blueprint.when,
                    which: blueprint.which,
                });
            }
            Ok(triggers)
        }))
    }
}

pub(crate) struct Lookup(pub(crate) Arc<Engine>);

impl RunLookup for Lookup {
    fn run_of<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, Option<RunRef>> {
        let worker = worker_id.to_owned();
        Box::pin(async move {
            match self.0.store.read(move |tx| tx.routine_sessions().run_of(&worker)).await {
                Ok(run) => run,
                Err(error) => {
                    tracing::warn!(worker_id, %error, "the run of a worker could not be read");
                    None
                }
            }
        })
    }
}
