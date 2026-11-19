//! What became of a run's result after the gate ([`RunOutcomes`]), as Needs
//! you reports it inside its own write jobs: held for the user, going out,
//! done with its outcome, failed to go out, or sent back for changes.

use std::sync::Arc;

use eos_core::Error;
use eos_core::routine::RunOutcomes;
use eos_core::store::{Outbox, RunMove, StoredRun, Tx};
use eos_domain::routine::numbers::Outcome;
use eos_domain::routine::run::{Reason, RunState, Station};
use serde_json::json;

use super::gate::done;
use super::{Engine, move_run, note};

pub(crate) struct Outcomes(pub(crate) Arc<Engine>);

impl Outcomes {
    fn run(tx: &dyn Tx, run_id: &str) -> Result<StoredRun, Error> {
        tx.runs().find(run_id)?.ok_or_else(|| Error::not_found("run", run_id))
    }

    fn now(&self) -> i64 {
        self.0.clock.now_ms()
    }
}

impl RunOutcomes for Outcomes {
    fn held(&self, tx: &dyn Tx, out: &mut Outbox, run_id: &str, inbox_id: &str) -> Result<(), Error> {
        let (run, now) = (Self::run(tx, run_id)?, self.now());
        tx.runs().append_event(run_id, now, "held", Some(&json!({"itemId": inbox_id}).to_string()))?;
        let held = RunMove { state: RunState::WaitingForUser, station: Some(Station::Gate), reason: None, at: now };
        move_run(tx, out, &run, held).map(drop)
    }

    fn delivering(&self, tx: &dyn Tx, out: &mut Outbox, run_id: &str) -> Result<(), Error> {
        let run = Self::run(tx, run_id)?;
        let going =
            RunMove { state: RunState::Delivering, station: Some(Station::Deliver), reason: None, at: self.now() };
        move_run(tx, out, &run, going).map(drop)
    }

    fn finished(&self, tx: &dyn Tx, out: &mut Outbox, run_id: &str, outcome: Outcome) -> Result<(), Error> {
        let run = Self::run(tx, run_id)?;
        done(tx, out, &run, outcome, self.now())
    }

    fn delivery_failed(&self, tx: &dyn Tx, out: &mut Outbox, run_id: &str, reason: &str) -> Result<(), Error> {
        let (run, now) = (Self::run(tx, run_id)?, self.now());
        tx.runs().append_event(run_id, now, "delivery_failed", Some(&json!({"kind": reason}).to_string()))?;
        let failed = RunMove {
            state: RunState::Failed,
            station: Some(Station::Deliver),
            reason: Some(Reason::Delivery),
            at: now,
        };
        move_run(tx, out, &run, failed).map(drop)
    }

    fn revise(&self, tx: &dyn Tx, out: &mut Outbox, run_id: &str, text: &str) -> Result<(), Error> {
        let run = Self::run(tx, run_id)?;
        let work = RunMove { state: RunState::Running, station: Some(Station::Work), reason: None, at: self.now() };
        move_run(tx, out, &run, work)?;
        // The lead hears it once this job has committed: the next write job
        // runs after it.
        let (engine, run_id, text) = (self.0.clone(), run_id.to_owned(), text.to_owned());
        let Some(tasks) = engine.tasks.clone() else {
            tracing::warn!(run_id, "a revised run's lead could not be told: no runtime");
            return Ok(());
        };
        let lead = run.lead_id;
        tasks.spawn(async move {
            if engine.store.write(|_, _| Ok(())).await.is_err() {
                return;
            }
            if let Some(lead) = lead {
                Engine::locked(&engine.held).remove(&lead);
                if let Err(error) = note(&engine, &lead, &run_id, &text).await {
                    tracing::warn!(run_id, %error, "a revised run's lead could not be told");
                }
            }
        });
        Ok(())
    }
}
