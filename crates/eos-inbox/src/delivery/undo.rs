//! What the user does with a send after it went out or failed (03 G3, G5,
//! G6): take it back inside its channel's window, say it was wrong, or try
//! a failed one again (Edit and retry with a changed result). An undo calls
//! its channel off the writer thread and records what it answered in a job
//! of its own. An undo or "that was wrong" of a send no user approved
//! drops its routine back to drafts in the job that records it (D9), and
//! every automatic send of the routine that has not gone out yet goes back
//! to the user as a draft there too: a gate or a claim after that job reads
//! the routine held.

use eos_contracts::ResultDoc;
use eos_core::Error;
use eos_core::delivery::{Receipt, UndoOutcome};
use eos_core::routine::RunOutcomes;
use eos_core::store::{ItemAnswer, Outbox, StoredDelivery, Tx};
use eos_domain::inbox::ItemKind;
use eos_domain::routine::numbers::Outcome;
use serde_json::Value;

use super::record::{Again, hold_again_in};
use super::{FAILED, HOLDING, QUEUED, SENT, STOPPED, UNDONE, WAITING_CAPABILITY, announce, automatic};
use crate::answer::answer_in;
use crate::outcomes::after_sent_in;
use crate::problems::requeue_in;
use crate::{Items, Opening, consume_in};

/// Why a routine whose send was taken back or called wrong holds its
/// results as drafts again.
const STEP_DOWN_UNDO: &str = "undo";
const STEP_DOWN_WRONG: &str = "wrong";

/// What the answer to a delivery problem a retry closes stores.
const RETRIED: &str = r#"{"kind":"delivery_problem","choice":"retry"}"#;

/// What a send left at its service, as its row keeps it.
fn receipt_of(row: &StoredDelivery) -> Option<Receipt> {
    let receipt: Value = serde_json::from_str(row.receipt.as_deref()?).ok()?;
    let id = receipt["id"].as_str()?.to_owned();
    Some(Receipt { id, url: receipt["url"].as_str().map(str::to_owned) })
}

impl Items {
    async fn delivery(&self, id: &str) -> Result<StoredDelivery, Error> {
        let lookup = id.to_owned();
        let row = self.store.read(move |tx| tx.inbox_deliveries().find(&lookup)).await?;
        row.ok_or_else(|| Error::not_found("delivery", id))
    }

    /// Takes the send `id` back inside its channel's window; whether some of
    /// it stays (a review's text). The run ends `undone`.
    pub async fn undo(&self, id: &str) -> Result<bool, crate::Error> {
        let row = self.delivery(id).await?;
        let open = row.state == SENT && row.undo_until.is_some_and(|until| self.clock.now_ms() <= until);
        let (Some(receipt), Some(channel), true) = (receipt_of(&row), self.channels.get(&row.channel), open) else {
            return Err(crate::Error::CannotUndo);
        };
        let partial = match channel.undo(&receipt).await {
            Ok(UndoOutcome::Undone) => false,
            Ok(UndoOutcome::Partial) => true,
            Ok(UndoOutcome::TooLate) => return Err(crate::Error::CannotUndo),
            Err(error) => {
                return Err(
                    Error::Unreachable(format!("the send could not be taken back: {}", error.detail_kind)).into()
                );
            }
        };
        let (id, now, outcomes) = (row.id.clone(), self.clock.now_ms(), self.outcomes.clone());
        let (ids, zone, control) = (self.ids.clone(), self.zone.clone(), self.control.clone());
        self.store
            .write(move |tx, out| {
                let Some(mut row) = tx.inbox_deliveries().find(&id)?.filter(|row| row.state == SENT) else {
                    return Ok(());
                };
                row.state = UNDONE.to_owned();
                row.undone_at = Some(now);
                row.updated_at = now;
                tx.inbox_deliveries().update(&row)?;
                announce(out, &row);
                after_sent_in(tx, out, outcomes.as_ref(), &row, Outcome::Undone, now)?;
                let at = Opening { now, ids: ids.as_ref(), zone: zone.as_ref(), control: control.as_ref() };
                step_down_in(tx, out, &at, outcomes.as_ref(), &row, STEP_DOWN_UNDO)
            })
            .await?;
        tracing::info!(delivery_id = %row.id, partial, "a send was taken back");
        Ok(partial)
    }

    /// The user says the send `id` was wrong: one outcome row; the send
    /// stays as it is. Saying it again changes nothing and answers the same.
    pub async fn wrong(&self, id: &str) -> Result<StoredDelivery, crate::Error> {
        let (id, now, outcomes) = (id.to_owned(), self.clock.now_ms(), self.outcomes.clone());
        let (ids, zone, control) = (self.ids.clone(), self.zone.clone(), self.control.clone());
        let row = self
            .store
            .write(move |tx, out| {
                let row = tx.inbox_deliveries().find(&id)?.ok_or_else(|| Error::not_found("delivery", &id))?;
                if row.state != SENT && row.state != UNDONE {
                    return Err(Error::Conflict("Only a send that went out can be wrong.".into()));
                }
                if tx.inbox_outcomes().judged(&row.routine_id, &row.id, Outcome::Wrong.as_str())? {
                    return Ok(row);
                }
                after_sent_in(tx, out, outcomes.as_ref(), &row, Outcome::Wrong, now)?;
                let at = Opening { now, ids: ids.as_ref(), zone: zone.as_ref(), control: control.as_ref() };
                step_down_in(tx, out, &at, outcomes.as_ref(), &row, STEP_DOWN_WRONG)?;
                Ok(row)
            })
            .await?;
        Ok(row)
    }

    /// Sends the failed send `id` again with a fresh ladder, as `doc` when
    /// the user edited it; the problem item that asked about it is answered
    /// by `by`. The row as it is then.
    pub async fn retry(&self, id: &str, doc: Option<ResultDoc>, by: &str) -> Result<StoredDelivery, crate::Error> {
        let (id, now, control) = (id.to_owned(), self.clock.now_ms(), self.control.clone());
        let answer = ItemAnswer { by: by.to_owned(), answer: Some(RETRIED.to_owned()), at: now };
        let row = self
            .store
            .write(move |tx, out| {
                let mut row = tx.inbox_deliveries().find(&id)?.ok_or_else(|| Error::not_found("delivery", &id))?;
                if row.state != FAILED {
                    return Err(Error::Conflict("Only a send that failed is tried again.".into()));
                }
                requeue_in(tx, control.as_ref(), &mut row, doc.as_ref(), now)?;
                tx.inbox_deliveries().update(&row)?;
                announce(out, &row);
                let asked = tx.inbox_items().waiting_with_subject(&row.id)?;
                for problem in asked.into_iter().filter(|item| item.kind == ItemKind::DeliveryProblem) {
                    if answer_in(tx, out, &problem.id, problem.rev, &answer)?.is_ok() {
                        consume_in(tx, &problem.id, now)?;
                    }
                }
                tracing::info!(delivery_id = %row.id, edited = doc.is_some(), "a failed send goes again");
                Ok(row)
            })
            .await?;
        self.wake.notify_one();
        Ok(row)
    }
}

/// A send no user approved drops its routine back to drafts, and every
/// automatic send of the routine that waits to go (in its hold, queued, or
/// waiting for its capability) goes back to the user as a draft.
fn step_down_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    at: &Opening<'_>,
    outcomes: &dyn RunOutcomes,
    row: &StoredDelivery,
    reason: &str,
) -> Result<(), Error> {
    if !automatic(&row.mode) {
        return Ok(());
    }
    at.control.step_down_in(tx, out, &row.routine_id, reason)?;
    let again = Again::SteppedDown;
    let mut held = 0;
    for state in [QUEUED, HOLDING, WAITING_CAPABILITY] {
        for mut waiting in tx.inbox_deliveries().in_state(state)? {
            if waiting.routine_id != row.routine_id || !automatic(&waiting.mode) {
                continue;
            }
            waiting.state = STOPPED.to_owned();
            waiting.last_error_kind = Some(again.kind().to_owned());
            waiting.next_attempt_at = None;
            waiting.updated_at = at.now;
            tx.inbox_deliveries().update(&waiting)?;
            announce(out, &waiting);
            hold_again_in(tx, out, at, outcomes, &waiting, &again)?;
            held += 1;
        }
    }
    tracing::info!(routine_id = %row.routine_id, reason, held, "a routine holds its results as drafts again");
    Ok(())
}
