//! A run's lead that goes quiet or whose session dies (01 G16, G39). A lead
//! that ends its turn without a result while none of its team works is
//! reminded once; the second time
//! the run fails as `no_result`. A lead whose session ends unexpectedly is
//! resumed once with a message; the second time the run fails as
//! `crashed`. Both count from the run's own timeline, so a restart forgets
//! nothing. A checker that goes quiet or dies without its verdict is the
//! check station's (`check::checker_failed`).

use std::sync::Arc;

use eos_contracts::WorkerState;
use eos_core::Error;
use eos_core::routine::RunRef;
use eos_core::store::RUN_STATE_EVENT;
use eos_domain::routine::run::{Reason, RunState, Station};
use eos_domain::run_scope::RunRole;
use eos_runtime::idle::IdleHook;

use super::{Engine, check, fail, note};

/// After the watcher's own idle hooks (report gap 30, context 40).
const IDLE_ORDER: i32 = 50;
const NUDGED: &str = "idle_nudge";
const CRASHED: &str = "lead_crashed";

pub(crate) const NUDGE: &str = "Your turn ended without a result. Call submit_result with the run's result, \
     or report_failure if the run cannot be done.";
pub(crate) const RESUMED: &str = "Your session stopped unexpectedly and was resumed. Carry on with the run where \
     you left off, then call submit_result or report_failure.";

/// The lead of a run at work, and how often `kind` was written to its
/// timeline (since its last state change when `since_move`).
async fn at_work(
    engine: &Engine,
    worker_id: &str,
    kind: &'static str,
    since_move: bool,
) -> Result<Option<(RunRef, usize)>, Error> {
    let id = worker_id.to_owned();
    engine
        .store
        .read(move |tx| {
            let Some(run_ref) = tx.routine_sessions().run_of(&id)? else { return Ok(None) };
            if !matches!(run_ref.role, RunRole::Solo | RunRole::Lead | RunRole::Script) {
                return Ok(None);
            }
            let working = tx
                .runs()
                .find(&run_ref.run_id)?
                .is_some_and(|run| (run.state, run.station) == (RunState::Running, Some(Station::Work)));
            if !working {
                return Ok(None);
            }
            let mut count = 0;
            for event in tx.runs().events(&run_ref.run_id)? {
                if event.kind == kind {
                    count += 1;
                } else if since_move && event.kind == RUN_STATE_EVENT {
                    count = 0;
                }
            }
            Ok(Some((run_ref, count)))
        })
        .await
}

async fn mark(engine: &Engine, run_id: &str, kind: &'static str) -> Result<(), Error> {
    let (id, now) = (run_id.to_owned(), engine.clock.now_ms());
    engine.store.write(move |tx, _| tx.runs().append_event(&id, now, kind, None)).await
}

/// `routine-lead-idle`: answers true when it gave the lead its reminder (the
/// lead works again).
pub(crate) fn lead_idle_hook(engine: &Arc<Engine>) -> IdleHook {
    let engine = engine.clone();
    IdleHook::new("routine-lead-idle", IDLE_ORDER, move |worker_id| {
        let (engine, worker_id) = (engine.clone(), worker_id.to_owned());
        async move {
            match idle(&engine, &worker_id).await {
                Ok(took) => took,
                Err(error) => {
                    tracing::warn!(worker_id, %error, "a run's idle lead could not be handled");
                    false
                }
            }
        }
    })
}

async fn idle(engine: &Arc<Engine>, worker_id: &str) -> Result<bool, Error> {
    let Some((run, nudged)) = at_work(engine, worker_id, NUDGED, true).await? else {
        // A checker that ends its turn without a verdict gives none.
        check::checker_failed(engine, worker_id).await?;
        return Ok(false);
    };
    // Eos runs the milestone at work itself: the lead waits.
    if super::system::at_step(engine, &run.run_id).await {
        return Ok(false);
    }
    // Its team still works: their reports come to it as messages.
    if team_at_work(engine, &run.run_id, worker_id).await? {
        return Ok(false);
    }
    if nudged > 0 {
        fail(engine, &run.run_id, Reason::NoResult, None).await?;
        return Ok(false);
    }
    mark(engine, &run.run_id, NUDGED).await?;
    note(engine, worker_id, &run.run_id, NUDGE).await?;
    tracing::info!(run_id = %run.run_id, worker_id, "a run's lead was reminded to hand in a result");
    Ok(true)
}

/// Whether another session of the run is starting or in a turn.
async fn team_at_work(engine: &Engine, run_id: &str, lead_id: &str) -> Result<bool, Error> {
    let (run_id, lead_id) = (run_id.to_owned(), lead_id.to_owned());
    engine
        .store
        .read(move |tx| {
            for session in tx.routine_sessions().by_run(&run_id)? {
                if session.worker_id == lead_id {
                    continue;
                }
                let state = tx.workers().find(&session.worker_id)?.map(|worker| worker.state);
                if matches!(state, Some(WorkerState::Spawning | WorkerState::Working)) {
                    return Ok(true);
                }
            }
            Ok(false)
        })
        .await
}

/// A session ended. A run's lead at work did not mean to: it is resumed
/// once.
pub(crate) fn session_exited(engine: &Arc<Engine>, worker_id: &str) {
    let (engine, worker_id) = (engine.clone(), worker_id.to_owned());
    tokio::spawn(async move {
        if let Err(error) = exited(&engine, &worker_id).await {
            tracing::warn!(worker_id, %error, "a run's ended lead could not be handled");
        }
    });
}

async fn exited(engine: &Arc<Engine>, worker_id: &str) -> Result<(), Error> {
    let Some((run, crashed)) = at_work(engine, worker_id, CRASHED, false).await? else {
        return check::checker_failed(engine, worker_id).await;
    };
    if crashed > 0 {
        return fail(engine, &run.run_id, Reason::Crashed, None).await;
    }
    mark(engine, &run.run_id, CRASHED).await?;
    tracing::warn!(run_id = %run.run_id, worker_id, "a run's lead stopped unexpectedly; resuming it");
    engine.sessions.revive(worker_id).await?;
    note(engine, worker_id, &run.run_id, RESUMED).await
}
