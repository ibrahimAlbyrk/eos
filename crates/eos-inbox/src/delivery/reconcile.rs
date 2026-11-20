//! Sends whose outcome is unknown (03 G5, §4.8): at launch every row left
//! `sending` by a crash is `uncertain`; an uncertain row is looked up by
//! its key at its target. Found, it was sent. Not found, a channel that
//! makes a repeat safe (its own key, or a marker it finds) sends again; one
//! that cannot tell asks the user whether it went out.

use eos_core::Error;
use eos_core::delivery::{Idempotency, SendErrorKind};
use eos_core::store::{Outbox, StoredDelivery, Tx};

use super::record::{Attempt, Problem, problem_in};
use super::{SENDING, UNCERTAIN, announce};
use crate::Opening;
use crate::halt::queue_again_in;

/// How long a lookup that failed waits before it is tried again.
const RECHECK_MS: i64 = 60_000;

/// What a lookup found.
pub(crate) enum Found {
    Sent(Attempt),
    /// Not out: send it again.
    Retry,
    /// Not out as far as the channel can tell, and a repeat may send twice.
    Unknown,
    /// The lookup failed; it is tried again later.
    Later,
}

/// Every row a crash left `sending` becomes `uncertain`, due now.
pub(crate) fn launch_in(tx: &dyn Tx, out: &mut Outbox, now: i64) -> Result<usize, Error> {
    let rows = tx.inbox_deliveries().in_state(SENDING)?;
    for mut row in rows.iter().cloned() {
        row.state = UNCERTAIN.to_owned();
        row.next_attempt_at = Some(now);
        row.updated_at = now;
        tx.inbox_deliveries().update(&row)?;
        announce(out, &row);
    }
    if !rows.is_empty() {
        tracing::info!(uncertain = rows.len(), "sends a crash interrupted are looked up");
    }
    Ok(rows.len())
}

/// What a lookup answered, by the channel's idempotency.
pub(crate) fn found(
    looked_up: Result<Option<eos_core::delivery::Receipt>, eos_core::delivery::SendError>,
    traits: Option<eos_core::delivery::ChannelTraits>,
) -> Found {
    match looked_up {
        Ok(Some(receipt)) => Found::Sent(Attempt::Sent { receipt, traits }),
        Ok(None) => match traits.map(|traits| traits.idempotency) {
            Some(Idempotency::Native | Idempotency::Marker) => Found::Retry,
            Some(Idempotency::None) | None => Found::Unknown,
        },
        Err(error) if error.kind == SendErrorKind::DevRun => Found::Sent(Attempt::Failed(error)),
        Err(_) => Found::Later,
    }
}

/// Writes what a lookup of `id` found that is not a send's outcome.
pub(crate) fn settle_in(tx: &dyn Tx, out: &mut Outbox, at: &Opening<'_>, id: &str, found: Found) -> Result<(), Error> {
    let Some(mut row) = tx.inbox_deliveries().find(id)?.filter(|row| row.state == UNCERTAIN) else { return Ok(()) };
    row.updated_at = at.now;
    match found {
        Found::Retry => queue_again_in(tx, &mut row, at.now)?,
        Found::Unknown => {
            // Asked once; it stays unknown until the user answers.
            row.next_attempt_at = None;
            update(tx, out, &row)?;
            return problem_in(tx, out, at, &row, Problem::Unknown);
        }
        Found::Later => row.next_attempt_at = Some(at.now + RECHECK_MS),
        Found::Sent(_) => return Ok(()),
    }
    tracing::info!(delivery_id = %row.id, state = %row.state, "an uncertain delivery was looked up");
    update(tx, out, &row)
}

fn update(tx: &dyn Tx, out: &mut Outbox, row: &StoredDelivery) -> Result<(), Error> {
    tx.inbox_deliveries().update(row)?;
    announce(out, row);
    Ok(())
}
