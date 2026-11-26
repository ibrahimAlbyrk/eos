//! A spend cap a routine or the settings leave out is no cap. Routines made
//! before that had their dollar caps filled in by default, and the overall
//! day budget read as $20; `routine_limit_resets` names them. Once, at
//! start, Eos keeps a new version of each such routine without `perRunUsd`
//! and `perDayUsd` (author `eos`, with a note; Undo is a restore) and clears
//! a stored overall day budget. A routine in Recently deleted, or a draft
//! with no version it runs from yet, waits for a later start.

use std::sync::Arc;

use eos_contracts::{Num, RoutineState, SettingValue, UserSettings, VersionAuthor};
use eos_core::Error;
use eos_core::store::{Outbox, Tx};

use super::Engine;
use super::versions::{Added, Prepared, add_in};
use crate::routes::{BUILTIN, DAY_BUDGET, readable};

/// The row that stands for the overall day budget.
const DAY_BUDGET_ROW: &str = "";
const NOTE: &str = "Took off the dollar limits that were set by default: this routine spends without a cap.";

/// Takes off the caps still listed; what fails is logged and tried again
/// at the next start.
pub(crate) async fn uncap(engine: &Arc<Engine>) {
    let rows = match engine.store.read(|tx| tx.routines().limit_resets()).await {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!(%error, "the routines whose caps to take off could not be read");
            return;
        }
    };
    for routine_id in rows {
        let done = match routine_id.as_str() {
            DAY_BUDGET_ROW => clear_day_budget(engine).await,
            _ => {
                let (job, id) = (engine.clone(), routine_id.clone());
                engine.store.write(move |tx, out| uncap_in(&job, tx, out, &id)).await
            }
        };
        if let Err(error) = done {
            tracing::warn!(routine_id, %error, "a routine's dollar caps could not be taken off");
        }
    }
}

async fn clear_day_budget(engine: &Engine) -> Result<(), Error> {
    let store = engine.settings.clone();
    let stored = matches!(store.read().get(DAY_BUDGET), Some(SettingValue::Number(Num(usd))) if *usd > 0.0);
    if stored {
        let partial: UserSettings = [(DAY_BUDGET.to_owned(), SettingValue::Number(Num(0.0)))].into_iter().collect();
        tokio::task::spawn_blocking(move || store.patch(partial))
            .await
            .map_err(|error| Error::storage(error.to_string()))??;
        tracing::info!("the routines' day budget was taken off");
    }
    engine.store.write(|tx, _| tx.routines().drop_limit_reset(DAY_BUDGET_ROW)).await
}

fn uncap_in(engine: &Engine, tx: &dyn Tx, out: &mut Outbox, routine_id: &str) -> Result<(), Error> {
    let routine = tx.routines().find(routine_id)?;
    let routine = routine.filter(|routine| routine.origin != BUILTIN && routine.state != RoutineState::Transient);
    let Some(routine) = routine else { return tx.routines().drop_limit_reset(routine_id) };
    let head = tx.routine_versions().head(routine_id)?;
    let Some(head) = head.filter(|_| routine.state != RoutineState::Deleted) else { return Ok(()) };
    if let Some(mut blueprint) = readable(&head)?
        && (blueprint.limits.per_run_usd.is_some() || blueprint.limits.per_day_usd.is_some())
    {
        blueprint.limits.per_run_usd = None;
        blueprint.limits.per_day_usd = None;
        let prepared = Prepared { blueprint, trust: head.trust };
        let added = Added {
            routine_id,
            version_id: &engine.ids.routine_version_id(),
            author: VersionAuthor::Eos,
            note: Some(NOTE.into()),
            prepared: &prepared,
            device: &engine.device,
            now: engine.clock.now_ms(),
            patterns: &engine.patterns,
        };
        add_in(tx, out, added)?;
        tracing::info!(routine_id, "a routine's default dollar caps were taken off");
    }
    tx.routines().drop_limit_reset(routine_id)
}
