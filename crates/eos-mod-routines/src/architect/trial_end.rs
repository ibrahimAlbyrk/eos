//! A trial run that ended reports to the routine's architect with its
//! headline (01 §4.11), as Eos's own note; once none of its draft's trial
//! runs is left, the draft is ready.

use eos_contracts::{DraftStatus, RoutineChangeReason};
use eos_core::Error;

use super::{room, touch};
use crate::engine::{Engine, announce_routine, note};

/// What the architect is told, and whom; none for a run that is no trial
/// of the draft its routine's architect works on.
async fn settle(engine: &Engine, run_id: &str) -> Result<Option<(String, String)>, Error> {
    let (id, now) = (run_id.to_owned(), engine.clock.now_ms());
    engine
        .store
        .write(move |tx, out| {
            let Some(run) = tx.runs().find(&id)?.filter(|run| run.kind == "trial" && run.state.is_terminal()) else {
                return Ok(None);
            };
            let Some(mut draft) = tx.routines().draft(&run.routine_id)? else { return Ok(None) };
            let Some(architect) = draft.architect_id.clone() else { return Ok(None) };
            if draft.draft_version_id.is_none() || draft.draft_version_id != run.version_id {
                return Ok(None);
            }
            let live = tx.runs().live_of(&run.routine_id)?;
            let trying = live.iter().any(|other| other.kind == "trial" && other.version_id == run.version_id);
            if !trying && draft.status == DraftStatus::Trying {
                draft.status = DraftStatus::Ready;
                draft.updated_at = now;
                tx.routines().update_draft(&draft)?;
                announce_routine(tx, out, &run.routine_id, RoutineChangeReason::Draft, now)?;
            }
            let outcome = run.outcome.map_or(run.state.as_str(), |outcome| outcome.as_str());
            let headline = run.headline.unwrap_or_else(|| "No headline.".into());
            let text = format!("Trial run {id} ended ({outcome}): {headline}");
            Ok(Some((architect, text)))
        })
        .await
}

/// Called after any run ended.
pub(crate) async fn trial_ended(engine: &Engine, run_id: &str) {
    let told = match settle(engine, run_id).await {
        Ok(Some((architect, text))) => tell(engine, &architect, run_id, &text).await,
        Ok(None) => return,
        Err(error) => Err(error),
    };
    if let Err(error) = told {
        tracing::warn!(run_id, %error, "a trial run's end could not reach the architect");
    }
}

/// A suspended architect comes back for the report when there is room;
/// otherwise it reads the trial runs with `get_routine` when it is next
/// spoken to.
async fn tell(engine: &Engine, architect: &str, run_id: &str, text: &str) -> Result<(), Error> {
    if !engine.sessions.is_live(architect) {
        if room(engine, Some(architect)).is_err() {
            return Ok(());
        }
        engine.sessions.revive(architect).await?;
        Engine::locked(&engine.architects).insert(architect.to_owned(), engine.clock.now_ms());
    }
    touch(engine, architect);
    note(engine, architect, run_id, text).await
}
