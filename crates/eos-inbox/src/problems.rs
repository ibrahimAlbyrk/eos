//! The user's answer to a `delivery_problem` item (03 G5), acted on in the
//! answering job: try again queues the send afresh, as approved now; "I sent
//! it myself" records it as sent and finishes the run once every send went
//! out; "Don't send" stops it, and the run's delivery failed for good.

use eos_contracts::{ProblemChoice, ResultDoc};
use eos_core::Error;
use eos_core::routine::RunOutcomes;
use eos_core::store::{Outbox, StoredItem, Tx};
use eos_domain::routine::blueprint::hash;
use serde_json::Value;

use crate::consume_in;
use crate::delivery::record::{all_sent, delivering, sent_in};
use crate::delivery::{FAILED, QUEUED, SENT, STOPPED, UNCERTAIN, announce};

/// Why a send the user gave up on was stopped.
const DISCARDED: &str = "discarded";

/// The answer to act on.
pub(crate) struct Answered<'a> {
    pub(crate) item: &'a StoredItem,
    pub(crate) choice: ProblemChoice,
    /// The result as the user edited it before trying again.
    pub(crate) doc: Option<&'a ResultDoc>,
    pub(crate) now: i64,
}

/// Acts on the answer; whether a send changed, so the delivery engine is
/// woken once the job committed: a send queued again goes now, and sends
/// to the same place that waited behind an unknown one may go.
pub(crate) fn answered_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    outcomes: &dyn RunOutcomes,
    answered: Answered<'_>,
) -> Result<bool, Error> {
    let Answered { item, choice, doc, now } = answered;
    consume_in(tx, &item.id, now)?;
    let payload: Value = serde_json::from_str(&item.payload).unwrap_or(Value::Null);
    let row = match payload["deliveryId"].as_str() {
        Some(id) => tx.inbox_deliveries().find(id)?,
        None => None,
    };
    // A send that moved on since the item opened is not the user's problem any more.
    let Some(mut row) = row.filter(|row| row.state == FAILED || row.state == UNCERTAIN) else { return Ok(false) };
    row.updated_at = now;
    row.next_attempt_at = None;
    let reason = row.last_error_kind.take().unwrap_or_else(|| row.state.clone());
    match choice {
        ProblemChoice::Retry => {
            if let Some(doc) = doc {
                let held: ResultDoc = serde_json::from_str(&row.body).map_err(|e| Error::storage(e.to_string()))?;
                if (&doc.kind, &doc.channel, &doc.action) != (&held.kind, &held.channel, &held.action) {
                    return Err(Error::Validation("a result is sent again as what it is, where it was to go".into()));
                }
                row.body = serde_json::to_string(doc).map_err(|e| Error::Validation(e.to_string()))?;
                row.body_hash = hash(&row.body);
            }
            row.state = QUEUED.to_owned();
            // A fresh ladder, approved now: an approval Eos quit on is not stale again.
            row.attempts = 0;
            row.approved_at = Some(now);
            row.next_attempt_at = Some(now);
        }
        ProblemChoice::MarkSent => {
            row.state = SENT.to_owned();
            row.sent_at = Some(now);
        }
        ProblemChoice::Discard => {
            row.state = STOPPED.to_owned();
            row.last_error_kind = Some(DISCARDED.to_owned());
        }
    }
    tx.inbox_deliveries().update(&row)?;
    announce(out, &row);
    tracing::info!(delivery_id = %row.id, item_id = %item.id, state = %row.state, "a delivery problem was answered");
    match choice {
        ProblemChoice::Retry => {}
        ProblemChoice::MarkSent if delivering(tx, &row.run_id)? && all_sent(tx, &row)? => {
            sent_in(tx, out, now, outcomes, &row)?;
        }
        ProblemChoice::Discard if delivering(tx, &row.run_id)? => {
            outcomes.delivery_failed(tx, out, &row.run_id, &reason)?;
        }
        _ => {}
    }
    Ok(true)
}
