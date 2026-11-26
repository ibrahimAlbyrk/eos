//! The user steering a run (01 §4.7, G18): telling its team something,
//! pausing, resuming and stopping it. A message reopens the work: a run
//! found at its check goes back to work, while it waits for the user the
//! gate takes it back; while it is delivering it cannot be stopped halfway. A
//! paused or stopped run's sessions are interrupted and suspended, their
//! conversations kept.

use std::sync::Arc;

use eos_core::Error;
use eos_core::store::RunMove;
use eos_domain::routine::run::{Reason, RunState, Station};
use eos_sessions::MessageInput;

use super::{Engine, move_run, note};

/// What the lead hears when the user resumes a paused run.
const RESUMED_BY_USER: &str = "The user resumed this run. Carry on where you left off.";

/// The user's words to the run's lead, as their own.
pub(crate) async fn message(engine: &Engine, run_id: &str, text: &str) -> Result<(), Error> {
    let (id, now, gate) = (run_id.to_owned(), engine.clock.now_ms(), engine.gate.clone());
    let lead = engine
        .store
        .write(move |tx, out| {
            let run = tx.runs().find(&id)?.ok_or_else(|| Error::not_found("run", id.clone()))?;
            let Some(lead) = run.lead_id.clone() else {
                return Err(Error::Conflict("the run's team has not started".into()));
            };
            let reopen = RunMove { state: RunState::Running, station: Some(Station::Work), reason: None, at: now };
            match run.state {
                RunState::Running => {}
                RunState::Checking => {
                    move_run(tx, out, &run, reopen)?;
                }
                RunState::WaitingForUser => {
                    gate.withdraw_in(tx, out, &id)?;
                    move_run(tx, out, &run, reopen)?;
                }
                RunState::Delivering => {
                    return Err(Error::Conflict("a run that is delivering cannot take a message".into()));
                }
                _ => return Err(Error::Conflict("the run is not at work".into())),
            }
            Ok(lead)
        })
        .await?;
    Engine::locked(&engine.held).remove(&lead);
    let words = MessageInput {
        worker_id: lead.clone(),
        text: text.to_owned(),
        queue_when_busy: true,
        origin: Some("run-message".into()),
        ..MessageInput::default()
    };
    engine.sessions.dispatch(words).await?;
    tracing::info!(run_id, worker_id = %lead, "the user told a run's team something");
    Ok(())
}

/// Pauses a run at work or at its check.
pub(crate) async fn pause(engine: &Arc<Engine>, run_id: &str) -> Result<(), Error> {
    let (id, now) = (run_id.to_owned(), engine.clock.now_ms());
    engine
        .store
        .write(move |tx, out| {
            let run = tx.runs().find(&id)?.ok_or_else(|| Error::not_found("run", id.clone()))?;
            if !matches!(run.state, RunState::Running | RunState::Checking) {
                return Err(Error::Conflict(format!("a run that is {} cannot be paused", run.state.as_str())));
            }
            let paused = RunMove { state: RunState::Paused, station: run.station, reason: Some(Reason::User), at: now };
            move_run(tx, out, &run, paused).map(drop)
        })
        .await?;
    tracing::info!(run_id, "a run was paused");
    quiet(engine, run_id).await;
    engine.wake.notify_one();
    Ok(())
}

/// Resumes a paused run: its lead comes back and is told so.
pub(crate) async fn resume(engine: &Arc<Engine>, run_id: &str) -> Result<(), Error> {
    let (id, now) = (run_id.to_owned(), engine.clock.now_ms());
    let lead = engine
        .store
        .write(move |tx, out| {
            let run = tx.runs().find(&id)?.ok_or_else(|| Error::not_found("run", id.clone()))?;
            if run.state != RunState::Paused {
                return Err(Error::Conflict(format!("a run that is {} cannot be resumed", run.state.as_str())));
            }
            let work = RunMove { state: RunState::Running, station: Some(Station::Work), reason: None, at: now };
            move_run(tx, out, &run, work)?;
            Ok(run.lead_id)
        })
        .await?;
    tracing::info!(run_id, "a run was resumed");
    if let Some(lead) = lead {
        engine.sessions.revive(&lead).await?;
        note(engine, &lead, run_id, RESUMED_BY_USER).await?;
    }
    Ok(())
}

/// Interrupts and suspends every session of a run that stopped working; a
/// session that is gone already is left as it is.
pub(crate) async fn quiet(engine: &Engine, run_id: &str) {
    quiet_where(engine, run_id, |_| true).await;
}

/// Interrupts and suspends the run's sessions whose role `which` takes.
async fn quiet_where(engine: &Engine, run_id: &str, which: impl Fn(&str) -> bool) {
    let id = run_id.to_owned();
    let sessions = match engine.store.read(move |tx| tx.routine_sessions().by_run(&id)).await {
        Ok(sessions) => sessions,
        Err(error) => {
            tracing::warn!(run_id, %error, "a run's sessions could not be read");
            return;
        }
    };
    for session in sessions.into_iter().filter(|session| which(&session.role)) {
        let worker = session.worker_id;
        Engine::locked(&engine.held).remove(&worker);
        let _ = engine.sessions.interrupt(&worker).await;
        if let Err(error) = engine.sessions.suspend(&worker, "routine_run").await {
            tracing::debug!(run_id, worker_id = %worker, %error, "a run session was not suspended");
        }
    }
}
