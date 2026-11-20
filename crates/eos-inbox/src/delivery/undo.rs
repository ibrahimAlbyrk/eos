//! What the user does with a send after it went out or failed (03 G3, G5,
//! G6): take it back inside its channel's window, say it was wrong, or try
//! a failed one again (Edit and retry with a changed result). An undo calls
//! its channel off the writer thread and records what it answered in a job
//! of its own. An undo or "that was wrong" of a send no user approved
//! drops its routine back to drafts (D9).

use eos_contracts::ResultDoc;
use eos_core::Error;
use eos_core::delivery::{Receipt, UndoOutcome};
use eos_core::store::{ItemAnswer, StoredDelivery};
use eos_domain::inbox::ItemKind;
use eos_domain::routine::numbers::Outcome;
use serde_json::Value;

use super::{FAILED, SENT, UNDONE, announce, automatic};
use crate::answer::answer_in;
use crate::outcomes::after_sent_in;
use crate::problems::requeue_in;
use crate::{Items, consume_in};

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

    /// A send no user approved drops its routine back to drafts.
    async fn step_down(&self, row: &StoredDelivery, reason: &str) -> Result<(), Error> {
        if automatic(&row.mode) {
            tracing::info!(routine_id = %row.routine_id, reason, "a routine holds its results as drafts again");
            self.control.step_down(&row.routine_id, reason).await?;
        }
        Ok(())
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
                after_sent_in(tx, out, outcomes.as_ref(), &row, Outcome::Undone, now)
            })
            .await?;
        tracing::info!(delivery_id = %row.id, partial, "a send was taken back");
        self.step_down(&row, STEP_DOWN_UNDO).await?;
        Ok(partial)
    }

    /// The user says the send `id` was wrong: one outcome row; the send
    /// stays as it is. Saying it again changes nothing and answers the same.
    pub async fn wrong(&self, id: &str) -> Result<StoredDelivery, crate::Error> {
        let (id, now, outcomes) = (id.to_owned(), self.clock.now_ms(), self.outcomes.clone());
        let (row, first) = self
            .store
            .write(move |tx, out| {
                let row = tx.inbox_deliveries().find(&id)?.ok_or_else(|| Error::not_found("delivery", &id))?;
                if row.state != SENT && row.state != UNDONE {
                    return Err(Error::Conflict("Only a send that went out can be wrong.".into()));
                }
                if tx.inbox_outcomes().judged(&row.routine_id, &row.id, Outcome::Wrong.as_str())? {
                    return Ok((row, false));
                }
                after_sent_in(tx, out, outcomes.as_ref(), &row, Outcome::Wrong, now)?;
                Ok((row, true))
            })
            .await?;
        if first {
            self.step_down(&row, STEP_DOWN_WRONG).await?;
        }
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
