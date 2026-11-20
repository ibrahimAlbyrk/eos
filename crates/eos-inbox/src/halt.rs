//! "Stop everything" on this Mac (03 G10): one switch, `inbox_halt`. On,
//! every send that has not gone out (`holding` or `queued`) is frozen; the
//! gate holds every result and the claim takes nothing while it is on (both
//! read the row in their own jobs). A send already on its way finishes and
//! is recorded; one that would go again (a passing failure, a lookup that
//! did not find it) is frozen too, and one that waits for its capability
//! keeps waiting. Resume turns each send frozen by the switch into a
//! `delivery_problem` that asks the user; nothing goes by itself. A send
//! frozen because the app is a development run is left as it is. Each
//! switch, its frozen rows and `inbox:halt` commit in one job.

use eos_contracts::HaltState;
use eos_core::Error;
use eos_core::store::{Outbox, StoredDelivery, StoredHalt, Tx};

use crate::delivery::record::{Problem, problem_in};
use crate::delivery::{FAILED, FROZEN, HOLDING, QUEUED, announce};
use crate::{INBOX_HALT, Items, Opening};

/// Why a send was frozen by the switch, kept in `last_error_kind`.
pub const HALTED: &str = "halted";

fn state(halt: &StoredHalt) -> HaltState {
    HaltState { on: halt.on, since: halt.since.filter(|_| halt.on) }
}

/// Writes the switch and announces it; `false` when it was already so.
fn switch_in(tx: &dyn Tx, out: &mut Outbox, on: bool, now: i64, by: &str) -> Result<bool, Error> {
    if tx.inbox_halt().get()?.on == on {
        return Ok(false);
    }
    let halt = StoredHalt { on, since: on.then_some(now), by: Some(by.to_owned()), updated_at: now };
    tx.inbox_halt().put(&halt)?;
    out.push(INBOX_HALT, &state(&halt));
    tracing::info!(on, by, "the halt switch changed");
    Ok(true)
}

/// `row` goes again at `next_attempt_at`; while the switch is on it is
/// frozen instead, so that resuming asks about it rather than sending it.
pub(crate) fn queue_again_in(tx: &dyn Tx, row: &mut StoredDelivery, next_attempt_at: i64) -> Result<(), Error> {
    if tx.inbox_halt().get()?.on {
        row.state = FROZEN.to_owned();
        row.last_error_kind = Some(HALTED.to_owned());
        row.next_attempt_at = None;
    } else {
        row.state = QUEUED.to_owned();
        row.next_attempt_at = Some(next_attempt_at);
    }
    Ok(())
}

/// Switches halt on, `by` who did it, and freezes every send that has not
/// gone out.
pub(crate) fn halt_in(tx: &dyn Tx, out: &mut Outbox, now: i64, by: &str) -> Result<HaltState, Error> {
    if switch_in(tx, out, true, now, by)? {
        let repo = tx.inbox_deliveries();
        let mut rows = repo.in_state(HOLDING)?;
        rows.extend(repo.in_state(QUEUED)?);
        for mut row in rows {
            row.state = FROZEN.to_owned();
            row.last_error_kind = Some(HALTED.to_owned());
            row.next_attempt_at = None;
            row.updated_at = now;
            repo.update(&row)?;
            announce(out, &row);
        }
    }
    Ok(state(&tx.inbox_halt().get()?))
}

/// Switches halt off, `by` who did it; each send the switch froze asks the
/// user whether to send it now.
pub(crate) fn resume_in(tx: &dyn Tx, out: &mut Outbox, at: &Opening<'_>, by: &str) -> Result<HaltState, Error> {
    if switch_in(tx, out, false, at.now, by)? {
        let repo = tx.inbox_deliveries();
        let frozen = repo.in_state(FROZEN)?.into_iter().filter(|row| row.last_error_kind.as_deref() == Some(HALTED));
        for mut row in frozen {
            // Failed, so the problem's answers (retry, mark sent, discard) act on it.
            row.state = FAILED.to_owned();
            row.updated_at = at.now;
            repo.update(&row)?;
            announce(out, &row);
            problem_in(tx, out, at, &row, Problem::Halted)?;
        }
    }
    Ok(state(&tx.inbox_halt().get()?))
}

impl Items {
    /// Whether everything is stopped on this Mac, and since when.
    pub async fn halt_state(&self) -> Result<HaltState, Error> {
        self.store.read(|tx| Ok(state(&tx.inbox_halt().get()?))).await
    }

    /// Stops everything on this Mac; `by` is who did it.
    pub async fn halt(&self, by: &str) -> Result<HaltState, Error> {
        let (now, by) = (self.clock.now_ms(), by.to_owned());
        self.store.write(move |tx, out| halt_in(tx, out, now, &by)).await
    }

    /// Lets everything go on; `by` is who did it.
    pub async fn resume(&self, by: &str) -> Result<HaltState, Error> {
        let (now, by) = (self.clock.now_ms(), by.to_owned());
        let (ids, zone, control) = (self.ids.clone(), self.zone.clone(), self.control.clone());
        let resumed = self
            .store
            .write(move |tx, out| {
                let at = Opening { now, ids: ids.as_ref(), zone: zone.as_ref(), control: control.as_ref() };
                resume_in(tx, out, &at, &by)
            })
            .await?;
        // Sends the user approved while it was on may go now.
        self.wake.notify_one();
        Ok(resumed)
    }
}
