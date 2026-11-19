//! Deliveries: one row of `inbox_deliveries` per result and target, the
//! key every attempt sends under. A row is queued in the job that decides
//! the send, and announced on `inbox:delivery` from every job that moves
//! it. Its target is stored from the recipient the gate checked, and every
//! send reads it back from the row.

use eos_contracts::{DeliveryChange, ResultDoc};
use eos_core::delivery::{ChannelTraits, Place, Target, Undo};
use eos_core::routine::GateInput;
use eos_core::store::{Outbox, StoredDelivery};
use eos_core::{Error, Ids};
use eos_domain::routine::blueprint::hash;
use serde_json::json;

use crate::INBOX_DELIVERY;

/// The states a row moves through (03 §4.8).
pub const QUEUED: &str = "queued";
pub const SENDING: &str = "sending";
pub const SENT: &str = "sent";
pub const FAILED: &str = "failed";
pub const UNCERTAIN: &str = "uncertain";
pub const FROZEN: &str = "frozen";
pub const WAITING_CAPABILITY: &str = "waiting_capability";
pub const STOPPED: &str = "stopped";

/// How a send the user approved is stored in `mode`; one Freedom sent is `auto`.
pub const APPROVED: &str = "approved";
pub const AUTO: &str = "auto";

/// How long a send waits before it goes, so it can still be stopped where
/// the channel cannot take it back (03 G6): after the user's Send, or on
/// its own.
pub fn hold_ms(traits: &ChannelTraits, approved: bool) -> i64 {
    match (traits.undo, approved) {
        (Undo::None, true) => 10_000,
        (Undo::None, false) => 120_000,
        (Undo::Full | Undo::Partial, _) => 0,
    }
}

/// The target as its row stores it.
pub(crate) fn target_json(target: &Target) -> String {
    let place = match &target.place {
        Place::Me => json!({"me": true}),
        Place::Address(address) => json!({"address": address}),
        Place::Item(key) => json!({"item": key}),
    };
    json!({"recipientId": target.recipient_id, "place": place}).to_string()
}

/// Announces a row as it is now.
pub(crate) fn announce(out: &mut Outbox, row: &StoredDelivery) {
    let change = DeliveryChange {
        id: row.id.clone(),
        item_id: row.item_id.clone(),
        run_id: row.run_id.clone(),
        state: row.state.clone(),
        send_at: row.send_at,
    };
    out.push(INBOX_DELIVERY, &change);
}

/// A send to queue.
pub(crate) struct NewDelivery<'a> {
    pub(crate) input: &'a GateInput,
    pub(crate) doc: &'a ResultDoc,
    pub(crate) target: &'a Target,
    pub(crate) traits: &'a ChannelTraits,
    /// The item it was approved from; none for one Freedom sends.
    pub(crate) item_id: Option<String>,
}

/// Queues one send inside the deciding job; its id.
pub(crate) fn queue_in(
    tx: &dyn eos_core::store::Tx,
    out: &mut Outbox,
    now: i64,
    ids: &dyn Ids,
    new: NewDelivery<'_>,
) -> Result<String, Error> {
    let approved = new.item_id.is_some();
    let body = serde_json::to_string(new.doc).map_err(|e| Error::storage(e.to_string()))?;
    let send_at = now + hold_ms(new.traits, approved);
    let row = StoredDelivery {
        id: ids.delivery_id(),
        item_id: new.item_id,
        run_id: new.input.run_id.clone(),
        routine_id: new.input.routine_id.clone(),
        channel: new.doc.channel.clone(),
        action: new.doc.action.clone(),
        target_ref: new.target.recipient_id.clone(),
        target: target_json(new.target),
        body_hash: hash(&body),
        body,
        class: new.traits.class,
        mode: if approved { APPROVED } else { AUTO }.to_owned(),
        state: QUEUED.to_owned(),
        send_at: Some(send_at),
        attempts: 0,
        next_attempt_at: Some(send_at),
        last_error_kind: None,
        partial: None,
        receipt: None,
        sent_at: None,
        undo_until: None,
        undone_at: None,
        approved_at: approved.then_some(now),
        created_at: now,
        updated_at: now,
    };
    tx.inbox_deliveries().insert(&row)?;
    announce(out, &row);
    Ok(row.id)
}
