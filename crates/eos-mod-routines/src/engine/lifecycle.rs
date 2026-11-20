//! A routine's life by hand (01 §4.8): active, paused or archived; deleted
//! to Recently deleted and back; a one-off kept as a standing routine. Each
//! change is one write that also settles the routine's runs and announces
//! `routine:change` with the row; the routine's surface follows it.

use std::sync::Arc;

use eos_contracts::{RoutineChangeReason, RoutineHandState, RoutineKind, RoutineState, RoutineSummary};
use eos_core::Error;
use eos_core::routine::ResumeRefusal;
use eos_core::store::{Outbox, RunMove, StoredRoutine, Tx};
use eos_domain::routine::run::{Reason, RunState};

use super::control::{announce, refusal_in};
use super::supervisor::skip_queued_in;
use super::surfaces::{self, Move as SurfaceMove};
use super::{Engine, move_run};
use crate::patterns::ItemPatterns;
use crate::routes::{gone, summary};

/// Why a routine paused by hand is paused.
const BY_USER: &str = "user";

pub(crate) fn live(tx: &dyn Tx, routine_id: &str) -> Result<StoredRoutine, Error> {
    let routine = tx.routines().find(routine_id)?.filter(|routine| routine.state != RoutineState::Deleted);
    routine.ok_or_else(|| Error::not_found("routine", routine_id))
}

pub(crate) fn row(
    tx: &dyn Tx,
    routine_id: &str,
    now: i64,
    patterns: &ItemPatterns,
) -> Result<Option<RoutineSummary>, Error> {
    let routine = tx.routines().find(routine_id)?.ok_or_else(|| Error::not_found("routine", routine_id))?;
    summary(tx, &routine, now, patterns)
}

/// One write on the routine, then the supervisor looks at the queue again.
async fn change(
    engine: &Arc<Engine>,
    routine_id: &str,
    write: impl FnOnce(&dyn Tx, &mut Outbox, &str, i64, &ItemPatterns) -> Result<(), Error> + Send + 'static,
) -> Result<Option<RoutineSummary>, Error> {
    let (id, now, patterns) = (routine_id.to_owned(), engine.clock.now_ms(), engine.patterns.clone());
    let row = engine
        .store
        .write(move |tx, out| {
            write(tx, out, &id, now, &patterns)?;
            row(tx, &id, now, &patterns)
        })
        .await?;
    engine.wake.notify_one();
    Ok(row)
}

/// `PUT …/state`. A draft becomes active only by its start; a paused or
/// archived routine's queued runs that may no longer start are skipped in
/// the same write. Its runs at work finish. A routine paused because a
/// target was refused becomes active only once the user confirmed every
/// recipient its head names (D53); the refusal writes nothing.
pub(crate) async fn set_state(
    engine: &Arc<Engine>,
    routine_id: &str,
    state: RoutineHandState,
) -> Result<Result<Option<RoutineSummary>, ResumeRefusal>, Error> {
    let (id, now, patterns) = (routine_id.to_owned(), engine.clock.now_ms(), engine.patterns.clone());
    let (answer, before) = engine
        .store
        .write(move |tx, out| {
            let routine = live(tx, &id)?;
            let before = routine.state;
            if routine.state == RoutineState::Draft {
                return Err(Error::Conflict("a draft routine is started from its draft".into()));
            }
            let (next, reason) = match state {
                RoutineHandState::Active => (RoutineState::Active, None),
                RoutineHandState::Paused => (RoutineState::Paused, Some(BY_USER)),
                RoutineHandState::Archived => (RoutineState::Archived, None),
            };
            if next == RoutineState::Active
                && let Some(refusal) = refusal_in(tx, &routine)?
            {
                return Ok((Err(refusal), before));
            }
            if routine.state != next {
                tx.routines().set_state(&id, next, reason, now)?;
                skip_queued_in(tx, out, &id, next, now)?;
                tracing::info!(routine_id = %id, state = ?next, "a routine's state was set");
                announce(tx, out, &id, RoutineChangeReason::State, now, &patterns)?;
            }
            Ok((row(tx, &id, now, &patterns).map(Ok)?, before))
        })
        .await?;
    engine.wake.notify_one();
    let archived = state == RoutineHandState::Archived;
    if answer.is_ok() && archived != (before == RoutineState::Archived) {
        let to = if archived { SurfaceMove::Archive } else { SurfaceMove::Restore };
        surfaces::moved(engine, routine_id, to).await;
    }
    Ok(answer)
}

/// `DELETE /api/routines/:id`: to Recently deleted. Its runs that have not
/// ended are cancelled and its waiting items withdrawn, in the same write;
/// a run that is delivering finishes its send first (G34).
pub(crate) async fn delete(engine: &Arc<Engine>, routine_id: &str) -> Result<Option<RoutineSummary>, Error> {
    let row = change(engine, routine_id, |tx, out, id, now, patterns| {
        live(tx, id)?;
        tx.routines().set_state(id, RoutineState::Deleted, None, now)?;
        tx.routines().set_deleted_at(id, Some(now), now)?;
        let mut cancelled = 0;
        for run in tx.runs().live_of(id)? {
            if run.state == RunState::Delivering {
                continue;
            }
            let stop =
                RunMove { state: RunState::Cancelled, station: run.station, reason: Some(Reason::User), at: now };
            move_run(tx, out, &run, stop)?;
            cancelled += 1;
        }
        let withdrawn = eos_inbox::withdraw_routine_in(tx, out, now, id)?;
        tracing::info!(routine_id = id, cancelled, withdrawn, "a routine was deleted");
        announce(tx, out, id, RoutineChangeReason::Deleted, now, patterns)
    })
    .await?;
    surfaces::moved(engine, routine_id, SurfaceMove::Archive).await;
    Ok(row)
}

/// `POST …/undelete`: back from Recently deleted, paused (a draft stays a
/// draft), so nothing starts until the user says so.
pub(crate) async fn undelete(engine: &Arc<Engine>, routine_id: &str) -> Result<Option<RoutineSummary>, Error> {
    let row = change(engine, routine_id, |tx, out, id, now, patterns| {
        let routine = tx.routines().find(id)?.filter(|routine| !gone(routine, now));
        let routine = routine.ok_or_else(|| Error::not_found("routine", id))?;
        if routine.state != RoutineState::Deleted {
            return Err(Error::Conflict("the routine is not deleted".into()));
        }
        let (state, reason) = match routine.head_version_id {
            Some(_) => (RoutineState::Paused, Some(BY_USER)),
            None => (RoutineState::Draft, None),
        };
        tx.routines().set_state(id, state, reason, now)?;
        tx.routines().set_deleted_at(id, None, now)?;
        tracing::info!(routine_id = id, "a routine came back from Recently deleted");
        announce(tx, out, id, RoutineChangeReason::State, now, patterns)
    })
    .await?;
    surfaces::moved(engine, routine_id, SurfaceMove::Restore).await;
    Ok(row)
}

/// `POST …/keep`: a one-off the user keeps becomes a standing routine,
/// active.
pub(crate) async fn keep(engine: &Arc<Engine>, routine_id: &str) -> Result<Option<RoutineSummary>, Error> {
    change(engine, routine_id, |tx, out, id, now, patterns| {
        let routine = live(tx, id)?;
        if routine.kind != RoutineKind::Once {
            return Err(Error::Conflict("only a one-off routine is kept".into()));
        }
        let head = tx.routine_versions().head(id)?;
        let head = head.ok_or_else(|| Error::Conflict("the one-off has no version to keep".into()))?;
        if crate::routes::readable(&head)?.is_none() {
            return Err(Error::Conflict(super::versions::NEWER_FORMAT.into()));
        }
        tx.routines().set_kind(id, RoutineKind::Standing, now)?;
        tx.routines().set_state(id, RoutineState::Active, None, now)?;
        tracing::info!(routine_id = id, "a one-off was kept");
        announce(tx, out, id, RoutineChangeReason::State, now, patterns)
    })
    .await
}
