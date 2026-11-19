//! Stopping a run: any run that has not ended is cancelled, except one that
//! is delivering, whose send cannot be stopped halfway. Its sessions are
//! interrupted and suspended.

use std::sync::Arc;

use eos_core::Error;
use eos_core::store::RunMove;
use eos_domain::routine::run::{Reason, RunState};

use super::{Engine, move_run};

pub(crate) async fn stop(engine: &Arc<Engine>, run_id: &str, why: Reason) -> Result<(), Error> {
    let (id, now) = (run_id.to_owned(), engine.clock.now_ms());
    engine
        .store
        .write(move |tx, out| {
            let run = tx.runs().find(&id)?.ok_or_else(|| Error::not_found("run", id.clone()))?;
            if run.state == RunState::Delivering {
                return Err(Error::Conflict("a run that is delivering cannot be stopped".into()));
            }
            let cancelled = RunMove { state: RunState::Cancelled, station: run.station, reason: Some(why), at: now };
            move_run(tx, out, &run, cancelled).map(drop)
        })
        .await?;
    tracing::info!(run_id, reason = why.as_str(), "a run was stopped");
    super::steer::quiet(engine, run_id).await;
    // A slot may be free now.
    engine.wake.notify_one();
    Ok(())
}
