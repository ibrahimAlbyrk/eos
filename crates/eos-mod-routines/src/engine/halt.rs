//! "Stop everything" in the run engine (01 G47, 03 G10). When `inbox:halt`
//! says it is on, every running and checking run ends `cancelled` with
//! reason `halted`, in one write job of the engine's own; their sessions end
//! as every ended run's do. Queued runs stay queued: the supervisor takes
//! none while it is on, and a start is refused. The switch is read once at
//! start too, for a halt switched on before Eos quit. When it goes off, the
//! queue goes on; nothing that ended starts again.

use std::sync::Arc;

use eos_contracts::HaltState;
use eos_core::Error;
use eos_core::store::{Outbox, RunMove, Tx};
use eos_domain::routine::run::{Reason, RunState};

use super::{Engine, move_run};

/// Needs you's topic for the switch, heard by name.
const INBOX_HALT: &str = "inbox:halt";

/// From now on, the engine acts on the switch; and once now, as it is.
pub(crate) async fn hear(engine: &Arc<Engine>) -> Result<(), Error> {
    let weak = Arc::downgrade(engine);
    let subscription = engine.bus.on(INBOX_HALT, move |event| {
        let Some(engine) = weak.upgrade() else { return };
        let Ok(halt) = event.payload_as::<HaltState>() else { return };
        if !halt.on {
            // Queued runs may leave the queue again.
            engine.wake.notify_one();
            return;
        }
        let Some(tasks) = engine.tasks.clone() else { return };
        tasks.spawn(async move {
            if let Err(error) = stop_all(&engine).await {
                tracing::warn!(%error, "the runs at work could not be stopped");
            }
        });
    });
    *Engine::locked(&engine.halt) = Some(subscription);
    stop_all(engine).await
}

/// Ends every run at work while the switch is on.
async fn stop_all(engine: &Arc<Engine>) -> Result<(), Error> {
    let now = engine.clock.now_ms();
    let stopped = engine.store.write(move |tx, out| stop_all_in(tx, out, now)).await?;
    if stopped > 0 {
        tracing::info!(runs = stopped, "runs were stopped because Eos is stopped");
    }
    Ok(())
}

fn stop_all_in(tx: &dyn Tx, out: &mut Outbox, now: i64) -> Result<usize, Error> {
    if !tx.inbox_halt().get()?.on {
        return Ok(0);
    }
    let runs = tx.runs().at_work()?;
    for run in &runs {
        let cancelled =
            RunMove { state: RunState::Cancelled, station: run.station, reason: Some(Reason::Halted), at: now };
        move_run(tx, out, run, cancelled)?;
    }
    Ok(runs.len())
}
