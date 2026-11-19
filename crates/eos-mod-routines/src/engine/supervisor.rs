//! The supervisor: one task that takes queued runs out of the queue, the
//! user's own first, then by age, while the global slots and the routine's
//! `limits.parallel` allow. Each pass is one write job, so what it counts
//! and what it starts cannot drift apart. Leaving the queue binds the
//! version the run runs from (01 G5), unless its start bound one (a trial
//! runs the draft it was started for), and moves it to `running` at the brief;
//! the brief station then starts its lead, one run after the other, before
//! the next pass. A run from a trigger is skipped while its routine's or
//! everything's day budget is spent, and waits while the plan has no
//! headroom; each turn of the loop also holds working runs to their time
//! and suspends the architects that went idle.

use std::collections::HashMap;
use std::sync::Arc;

use eos_contracts::RoutineState;
use eos_core::Error;
use eos_core::store::{Outbox, RunMove, StoredRun, Tx};
use eos_domain::routine::run::{Reason, RunState, Station};

use super::{Engine, brief, budget, move_run};
use crate::routes::{readable, showing_version};

/// The longest the supervisor sleeps without being woken.
const IDLE_WAIT_MS: i64 = 60_000;
/// How long it sleeps at most while runs work: their time is checked and
/// their spend written each turn.
const WORKING_WAIT_MS: i64 = 30_000;

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
        let now = engine.clock.now_ms();
        let (job, day) = (engine.clone(), budget::day(&engine));
        let wait = match engine.store.write(move |tx, out| pass(tx, out, &job, &day, now)).await {
            Ok(Pass { next_due, left }) => {
                for run_id in left {
                    brief::start_lead(&engine, &run_id).await;
                }
                next_due.map_or(IDLE_WAIT_MS, |at| (at - now).clamp(1, IDLE_WAIT_MS))
            }
            Err(error) => {
                tracing::warn!(%error, "the run queue could not be read");
                IDLE_WAIT_MS
            }
        };
        let wait = if budget::tick(&engine).await { wait.min(WORKING_WAIT_MS) } else { wait };
        crate::architect::sweep(&engine).await;
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
    /// What its runs may spend a day.
    per_day_usd: f64,
    version_id: Option<String>,
}

/// What one pass did: when the next run that waits for its time is due, and
/// the runs that left the queue with a version to run from.
struct Pass {
    next_due: Option<i64>,
    left: Vec<String>,
}

/// One pass over the queue.
fn pass(tx: &dyn Tx, out: &mut Outbox, engine: &Arc<Engine>, day: &budget::Day, now: i64) -> Result<Pass, Error> {
    let autostart = engine.autostart;
    let spent = budget::spent_in(tx, &day.day)?;
    let mut busy: HashMap<String, i64> = tx.runs().working()?.into_iter().collect();
    let mut total: i64 = busy.values().sum();
    let mut routines: HashMap<String, Allowed> = HashMap::new();
    let mut next_due: Option<i64> = None;
    let mut left = Vec::new();
    for run in tx.runs().queued()? {
        let user = by_the_user(&run.origin);
        if !routines.contains_key(&run.routine_id) {
            routines.insert(run.routine_id.clone(), allowed(tx, &run.routine_id)?);
        }
        let Some(routine) = routines.get(&run.routine_id) else { continue };
        // 01 §4.4: a run whose routine was switched off before it started never starts.
        if never_starts(routine.state, user) {
            skip(tx, out, &run, now)?;
            continue;
        }
        if total >= day.slots {
            continue;
        }
        if let Some(at) = run.not_before.filter(|at| *at > now) {
            next_due = Some(next_due.map_or(at, |due| due.min(at)));
            continue;
        }
        if !autostart && !user {
            continue;
        }
        if routine.state != RoutineState::Active && !user {
            continue;
        }
        if !user {
            let routine_spent = spent.of_routine(&run.routine_id) >= routine.per_day_usd;
            if routine_spent || spent.total >= day.cap_usd {
                skip_for(tx, out, &run, Reason::DayCap, now)?;
                let whose = routine_spent.then_some(run.routine_id.as_str());
                budget::day_cap_notice_in(tx, out, engine, whose, now)?;
                continue;
            }
            if day.plan_busy {
                continue;
            }
        }
        let working = busy.entry(run.routine_id.clone()).or_default();
        if *working >= routine.parallel {
            continue;
        }
        *working += 1;
        total += 1;
        let version_id = run.version_id.as_deref().or(routine.version_id.as_deref());
        if leave_queue(tx, out, &run, version_id, now)? {
            left.push(run.id);
        }
    }
    Ok(Pass { next_due, left })
}

/// Archived and deleted routines start nothing; a paused one only what the
/// user starts (01 §4.8).
fn never_starts(state: RoutineState, user: bool) -> bool {
    match state {
        RoutineState::Archived | RoutineState::Deleted => true,
        RoutineState::Paused => !user,
        _ => false,
    }
}

fn skip(tx: &dyn Tx, out: &mut Outbox, run: &StoredRun, now: i64) -> Result<(), Error> {
    skip_for(tx, out, run, Reason::User, now)
}

fn skip_for(tx: &dyn Tx, out: &mut Outbox, run: &StoredRun, reason: Reason, now: i64) -> Result<(), Error> {
    let skipped = RunMove { state: RunState::Skipped, station: None, reason: Some(reason), at: now };
    move_run(tx, out, run, skipped)?;
    let reason = reason.as_str();
    tracing::info!(run_id = %run.id, routine_id = %run.routine_id, reason, "a run was skipped");
    Ok(())
}

/// Skips the queued runs of a routine that was just switched off, in the
/// job that switched it: those the user started stay while it is only
/// paused.
pub(crate) fn skip_queued_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    routine_id: &str,
    state: RoutineState,
    now: i64,
) -> Result<(), Error> {
    for run in tx.runs().queued()?.iter().filter(|run| run.routine_id == routine_id) {
        if never_starts(state, by_the_user(&run.origin)) {
            skip(tx, out, run, now)?;
        }
    }
    Ok(())
}

fn allowed(tx: &dyn Tx, routine_id: &str) -> Result<Allowed, Error> {
    let state = tx.routines().find(routine_id)?.map_or(RoutineState::Deleted, |routine| routine.state);
    let version = showing_version(tx, routine_id)?;
    // A stored version that is no blueprint fails this routine's runs; it
    // must not stop the queue for every other routine.
    let blueprint = match version.as_ref().map(readable).transpose() {
        Ok(blueprint) => blueprint.flatten(),
        Err(error) => {
            tracing::warn!(routine_id, %error, "a routine's version could not be read");
            None
        }
    };
    Ok(Allowed {
        state,
        parallel: blueprint.as_ref().map_or(1, |blueprint| blueprint.limits.parallel.max(1)),
        per_day_usd: blueprint.as_ref().map_or(f64::INFINITY, |blueprint| blueprint.limits.per_day_usd.0),
        // A version this app cannot run is no version to bind.
        version_id: version.filter(|_| blueprint.is_some()).map(|version| version.id),
    })
}

/// Binds the version and moves the run to the brief; a run with nothing to
/// run from fails there. True when the run is at the brief.
fn leave_queue(
    tx: &dyn Tx,
    out: &mut Outbox,
    run: &StoredRun,
    version_id: Option<&str>,
    now: i64,
) -> Result<bool, Error> {
    if let Some(version_id) = version_id.filter(|id| run.version_id.as_deref() != Some(*id)) {
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
    Ok(version_id.is_some())
}
