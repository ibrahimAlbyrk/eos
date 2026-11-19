//! The run engine: starting runs (`start`), the supervisor that takes them
//! out of the queue (`supervisor`) and stopping them (`cancel`). Every move
//! of a run is one write job that adds the move to the run's timeline and
//! announces it on `run:change` from the job's outbox.

mod cancel;
mod control;
mod ports;
mod start;
mod supervisor;

pub(crate) use control::Control;
pub(crate) use ports::{Directory, Intake, Lookup};

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use eos_contracts::{RunChange, RunInput, RunsActive};
use eos_core::routine::RunCreated;
use eos_core::store::{Outbox, RUN_STATE_EVENT, RunMove, Store, StoredRun, Tx};
use eos_core::{Clock, Error, Ids, Sleeper};
use eos_domain::routine::run::RunState;
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use crate::{RUN_CHANGE, RUNS_ACTIVE};

/// What the engine is built from.
pub(crate) struct Engine {
    pub(crate) store: Arc<dyn Store>,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) sleeper: Arc<dyn Sleeper>,
    pub(crate) ids: Arc<dyn Ids>,
    /// This computer's id, stored on each run it makes.
    pub(crate) device: String,
    /// Off the network only runs the user started leave the queue by
    /// themselves (`Reach::autostart`).
    pub(crate) autostart: bool,
    /// Wakes the supervisor: a run was queued or ended.
    pub(crate) wake: Notify,
    /// Client request ids of the last ten minutes, with the runs they made.
    pub(crate) requests: Mutex<HashMap<String, (i64, Vec<RunCreated>)>>,
    pub(crate) supervisor: Mutex<Option<JoinHandle<()>>>,
}

impl Engine {
    pub(crate) fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
        m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Moves `run` and announces it. The move must be one
/// `RunState::can_become` allows.
pub(crate) fn move_run(tx: &dyn Tx, out: &mut Outbox, run: &StoredRun, change: RunMove) -> Result<i64, Error> {
    if !run.state.can_become(change.state) {
        return Err(Error::Conflict(format!(
            "a run that is {} cannot become {}",
            run.state.as_str(),
            change.state.as_str()
        )));
    }
    let before = tx.runs().active()?;
    let event = tx.runs().move_to(&run.id, &change)?;
    announce(out, &run.id, &run.routine_id, &change);
    let after = tx.runs().active()?;
    if after != before {
        out.push(RUNS_ACTIVE.name(), &RunsActive { count: after.0, needs_user: after.1 });
    }
    Ok(event)
}

/// A run about to be queued.
pub(crate) struct Queued<'a> {
    pub(crate) id: String,
    pub(crate) routine_id: &'a str,
    pub(crate) kind: &'a str,
    pub(crate) origin: &'a str,
    pub(crate) origin_ref: Option<String>,
    pub(crate) door: Option<String>,
    pub(crate) input: &'a RunInput,
    pub(crate) item_key: Option<String>,
    pub(crate) priority: i64,
    pub(crate) device: &'a str,
    pub(crate) now: i64,
}

/// Writes a queued run with the first event of its timeline, and announces
/// it. A queued run changes nothing `runs:active` counts.
pub(crate) fn queue_run(tx: &dyn Tx, out: &mut Outbox, run: Queued<'_>) -> Result<(), Error> {
    let row = StoredRun {
        id: run.id.clone(),
        routine_id: run.routine_id.to_owned(),
        version_id: None,
        kind: run.kind.to_owned(),
        origin: run.origin.to_owned(),
        origin_ref: run.origin_ref,
        door: run.door,
        input: serde_json::to_string(run.input).map_err(|e| Error::storage(e.to_string()))?,
        item_key: run.item_key,
        state: RunState::Queued,
        station: None,
        reason: None,
        attempt: 1,
        resumed: 0,
        not_before: run.input.at,
        priority: run.priority,
        progress_done: None,
        progress_total: None,
        headline: None,
        outcome: None,
        cost_usd: 0.0,
        work_ms: 0,
        lead_id: None,
        device: run.device.to_owned(),
        remote: false,
        created_at: run.now,
        started_at: None,
        ended_at: None,
        updated_at: run.now,
    };
    tx.runs().insert(&row)?;
    tx.runs().append_event(&run.id, run.now, RUN_STATE_EVENT, Some(r#"{"state":"queued"}"#))?;
    let queued = RunMove { state: RunState::Queued, station: None, reason: None, at: run.now };
    announce(out, &run.id, run.routine_id, &queued);
    Ok(())
}

pub(crate) fn announce(out: &mut Outbox, run_id: &str, routine_id: &str, change: &RunMove) {
    let payload = RunChange {
        run_id: run_id.to_owned(),
        routine_id: routine_id.to_owned(),
        state: change.state.as_str().to_owned(),
        station: change.station.map(|station| station.as_str().to_owned()),
        reason: change.reason.map(|reason| reason.as_str().to_owned()),
        needs_user: None,
    };
    out.push(RUN_CHANGE.name(), &payload);
}

/// The engine as the port the other areas start runs through.
pub(crate) struct Runs(pub(crate) Arc<Engine>);

impl eos_core::routine::RunStarter for Runs {
    fn start(
        &self,
        run: eos_core::routine::NewRun,
    ) -> eos_core::BoxFuture<'_, Result<Vec<RunCreated>, eos_core::routine::StartError>> {
        Box::pin(start::start(&self.0, run))
    }

    fn stop<'a>(
        &'a self,
        run_id: &'a str,
        why: eos_domain::routine::run::Reason,
    ) -> eos_core::BoxFuture<'a, Result<(), Error>> {
        Box::pin(cancel::stop(&self.0, run_id, why))
    }
}

pub(crate) fn start_supervisor(engine: &Arc<Engine>) {
    supervisor::spawn(engine);
}

/// Ends the supervisor and waits until it let go of the engine, so the store
/// is free once the app shuts down.
pub(crate) async fn stop_supervisor(engine: &Engine) {
    let task = Engine::locked(&engine.supervisor).take();
    if let Some(task) = task {
        task.abort();
        let _ = task.await;
    }
}
