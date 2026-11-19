//! The run engine: starting runs (`start`), the supervisor that takes them
//! out of the queue (`supervisor`) and stopping them (`cancel`). Every move
//! of a run is one write job that adds the move to the run's timeline and
//! announces it on `run:change` from the job's outbox.

mod cancel;
mod start;
mod supervisor;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use eos_contracts::RunChange;
use eos_core::routine::RunCreated;
use eos_core::store::{Outbox, RunMove, Store, StoredRun, Tx};
use eos_core::{Clock, Error, Ids, Sleeper};
use tokio::sync::Notify;
use tokio::task::AbortHandle;

use crate::RUN_CHANGE;

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
    pub(crate) supervisor: Mutex<Option<AbortHandle>>,
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
    let event = tx.runs().move_to(&run.id, &change)?;
    announce(out, &run.id, &run.routine_id, &change);
    Ok(event)
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

pub(crate) fn stop_supervisor(engine: &Engine) {
    if let Some(task) = Engine::locked(&engine.supervisor).take() {
        task.abort();
    }
}
