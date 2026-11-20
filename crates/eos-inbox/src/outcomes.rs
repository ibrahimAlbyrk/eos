//! What became of a held result (03 §4.8 "Run outcomes"): a row of
//! `inbox_outcomes`, and the run told it is done, in the job that decided
//! it. A sent draft went out unedited when what was sent equals what was
//! held, by its kind's rule of sameness (03 §4.3). A draft a newer run's
//! draft replaced ends its run as `replaced`.

use eos_contracts::ResultDoc;
use eos_core::Error;
use eos_core::routine::RunOutcomes;
use eos_core::store::{NewOutcome, Outbox, StoredItem, Tx};
use eos_domain::inbox::ItemKind;
use eos_domain::result_doc::equal;
use eos_domain::routine::numbers::Outcome;
use eos_domain::routine::run::RunState;
use serde_json::Value;

/// The rung a held result waited at when its draft does not say.
const HELD_RUNG: &str = "draft";

/// A held result's end.
pub(crate) struct Ended<'a> {
    /// The draft it was held as.
    pub(crate) item: &'a StoredItem,
    pub(crate) delivery_id: Option<String>,
    pub(crate) outcome: Outcome,
    pub(crate) at: i64,
}

/// The result as the gate held it, from its draft's payload.
pub(crate) fn held_doc(payload: &Value) -> Option<ResultDoc> {
    serde_json::from_value(payload.get("doc")?.clone()).ok()
}

/// Whether `sent` went out as `item` held it. A draft whose held result
/// cannot be read counts as edited.
pub(crate) fn sent_outcome(item: &StoredItem, sent: &ResultDoc) -> Outcome {
    let payload: Value = serde_json::from_str(&item.payload).unwrap_or(Value::Null);
    match held_doc(&payload) {
        Some(held) if equal(&held, sent) => Outcome::SentUnedited,
        _ => Outcome::SentEdited,
    }
}

/// Records the end and tells the run, if the run still waits on its result.
pub(crate) fn ended_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    outcomes: &dyn RunOutcomes,
    ended: Ended<'_>,
) -> Result<(), Error> {
    let item = ended.item;
    let (Some(routine_id), Some(run_id)) = (item.routine_id.clone(), item.run_id.clone()) else { return Ok(()) };
    let payload: Value = serde_json::from_str(&item.payload).unwrap_or(Value::Null);
    let rung = payload["rung"].as_str().unwrap_or(HELD_RUNG).to_owned();
    let row = NewOutcome {
        routine_id,
        run_id: run_id.clone(),
        item_id: Some(item.id.clone()),
        delivery_id: ended.delivery_id,
        outcome: ended.outcome.as_str().to_owned(),
        rung,
        at: ended.at,
    };
    tx.inbox_outcomes().insert(&row)?;
    tracing::info!(item_id = %item.id, run_id = %run_id, outcome = ended.outcome.as_str(), "a held result ended");
    let waiting = tx
        .runs()
        .find(&run_id)?
        .is_some_and(|run| matches!(run.state, RunState::WaitingForUser | RunState::Delivering));
    if waiting {
        outcomes.finished(tx, out, &run_id, ended.outcome)?;
    }
    Ok(())
}

/// Ends the runs of the drafts `by` replaced, each `replaced`. A draft its
/// own run held again is not an end: the run goes on with `by`.
pub(crate) fn replaced_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    outcomes: &dyn RunOutcomes,
    replaced: &[StoredItem],
    by: &StoredItem,
) -> Result<(), Error> {
    let ended = replaced.iter().filter(|old| old.kind == ItemKind::Draft && old.run_id != by.run_id);
    for item in ended {
        ended_in(tx, out, outcomes, Ended { item, delivery_id: None, outcome: Outcome::Replaced, at: by.created_at })?;
    }
    Ok(())
}
