//! The supervisor: one task that takes queued runs out of the queue, the
//! user's own first, then by age, while the global slots and the routine's
//! `limits.parallel` allow. Each pass is one write job, so what it counts
//! and what it starts cannot drift apart. Leaving the queue binds the
//! version the run runs from (01 G5) and moves it to `running` at the brief.

use std::collections::HashMap;
use std::sync::Arc;

use eos_contracts::RoutineState;
use eos_core::Error;
use eos_core::store::{Outbox, RunMove, StoredRun, Tx};
use eos_domain::routine::run::{Reason, RunState, Station};

use super::{Engine, move_run};
use crate::routes::{readable, showing_version};

/// Runs whose agents work at once, over every routine.
pub(crate) const GLOBAL_SLOTS: i64 = 3;
/// The longest the supervisor sleeps without being woken.
const IDLE_WAIT_MS: i64 = 60_000;

/// Started by the user: the dev guard let the act through, so such a run
/// starts even off the network.
pub(crate) fn by_the_user(origin: &str) -> bool {
    matches!(origin, "hand" | "again" | "trial")
}

pub(crate) fn spawn(engine: &Arc<Engine>) {
    let task = tokio::spawn(supervise(engine.clone()));
    if let Some(previous) = Engine::locked(&engine.supervisor).replace(task) {
        previous.abort();
    }
}

async fn supervise(engine: Arc<Engine>) {
    loop {
        let (now, autostart) = (engine.clock.now_ms(), engine.autostart);
        let wait = match engine.store.write(move |tx, out| pass(tx, out, now, autostart)).await {
            Ok(next) => next.map_or(IDLE_WAIT_MS, |at| (at - now).clamp(1, IDLE_WAIT_MS)),
            Err(error) => {
                tracing::warn!(%error, "the run queue could not be read");
                IDLE_WAIT_MS
            }
        };
        tokio::select! {
            () = engine.sleeper.sleep(wait) => {}
            () = engine.wake.notified() => {}
        }
    }
}

/// What a routine allows, read once per pass.
struct Allowed {
    state: RoutineState,
    parallel: i64,
    version_id: Option<String>,
}

/// One pass over the queue. Answers when the next run that waits for its
/// time is due.
fn pass(tx: &dyn Tx, out: &mut Outbox, now: i64, autostart: bool) -> Result<Option<i64>, Error> {
    let mut busy: HashMap<String, i64> = tx.runs().working()?.into_iter().collect();
    let mut total: i64 = busy.values().sum();
    let mut routines: HashMap<String, Allowed> = HashMap::new();
    let mut next_due: Option<i64> = None;
    for run in tx.runs().queued()? {
        if total >= GLOBAL_SLOTS {
            break;
        }
        if let Some(at) = run.not_before.filter(|at| *at > now) {
            next_due = Some(next_due.map_or(at, |due| due.min(at)));
            continue;
        }
        let user = by_the_user(&run.origin);
        if !autostart && !user {
            continue;
        }
        if !routines.contains_key(&run.routine_id) {
            routines.insert(run.routine_id.clone(), allowed(tx, &run.routine_id)?);
        }
        let Some(routine) = routines.get(&run.routine_id) else { continue };
        if routine.state != RoutineState::Active && !user {
            continue;
        }
        let working = busy.entry(run.routine_id.clone()).or_default();
        if *working >= routine.parallel {
            continue;
        }
        *working += 1;
        total += 1;
        leave_queue(tx, out, &run, routine.version_id.as_deref(), now)?;
    }
    Ok(next_due)
}

fn allowed(tx: &dyn Tx, routine_id: &str) -> Result<Allowed, Error> {
    let state = tx.routines().find(routine_id)?.map_or(RoutineState::Deleted, |routine| routine.state);
    let version = showing_version(tx, routine_id)?;
    let blueprint = match &version {
        Some(version) => readable(version)?,
        None => None,
    };
    Ok(Allowed {
        state,
        parallel: blueprint.as_ref().map_or(1, |blueprint| blueprint.limits.parallel.max(1)),
        // A version this app cannot run is no version to bind.
        version_id: version.filter(|_| blueprint.is_some()).map(|version| version.id),
    })
}

/// Binds the version and moves the run to the brief; a run with nothing to
/// run from fails there.
fn leave_queue(
    tx: &dyn Tx,
    out: &mut Outbox,
    run: &StoredRun,
    version_id: Option<&str>,
    now: i64,
) -> Result<(), Error> {
    if let Some(version_id) = version_id {
        tx.runs().bind_version(&run.id, version_id)?;
    }
    let brief = RunMove { state: RunState::Running, station: Some(Station::Brief), reason: None, at: now };
    move_run(tx, out, run, brief)?;
    tracing::info!(run_id = %run.id, routine_id = %run.routine_id, version_id = ?version_id, "a run left the queue");
    if version_id.is_none() {
        let running = StoredRun { state: RunState::Running, ..run.clone() };
        let failed =
            RunMove { state: RunState::Failed, station: Some(Station::Brief), reason: Some(Reason::Invalid), at: now };
        move_run(tx, out, &running, failed)?;
        tracing::warn!(run_id = %run.id, routine_id = %run.routine_id, "a run had no version to run from");
    }
    Ok(())
}
