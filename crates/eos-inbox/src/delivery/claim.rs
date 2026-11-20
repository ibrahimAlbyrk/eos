//! The claim (03 §4.8 "Engine"): one write job takes the rows that are due
//! and may go now, oldest first, at most one at a time per target, while
//! halt is off; each becomes `sending` with one more attempt. A row the
//! user approved over an hour ago and never tried (Eos was closed) is not
//! sent but told (03 G5).

use std::collections::HashSet;

use eos_core::Error;
use eos_core::store::{DeliveryRepo, Outbox, StoredDelivery, Tx};
use eos_domain::freedom::rung::APPROVED_FRESH_MS;

use super::record::{Problem, problem_in};
use super::{APPROVED, FAILED, QUEUED, SENDING, UNCERTAIN, announce};
use crate::Opening;

/// The most rows one claim takes.
const CLAIM_MAX: usize = 20;

/// The targets that wait while a send to them is out or unknown.
fn busy(repo: &dyn DeliveryRepo) -> Result<HashSet<String>, Error> {
    let mut busy = HashSet::new();
    for state in [SENDING, UNCERTAIN] {
        busy.extend(repo.in_state(state)?.into_iter().map(|row| row.target_ref));
    }
    Ok(busy)
}

fn due(row: &StoredDelivery, now: i64) -> bool {
    row.next_attempt_at.is_some_and(|at| at <= now)
}

pub(crate) fn claim_in(tx: &dyn Tx, out: &mut Outbox, at: &Opening<'_>) -> Result<Vec<StoredDelivery>, Error> {
    if tx.inbox_halt().get()?.on {
        return Ok(Vec::new());
    }
    let repo = tx.inbox_deliveries();
    let mut busy = busy(repo)?;
    // Each target's sends go in the order they were made: only its oldest
    // queued row may go.
    let mut looked_at: HashSet<String> = HashSet::new();
    let mut claimed = Vec::new();
    for mut row in repo.in_state(QUEUED)? {
        if due(&row, at.now) && approval_too_old(&row, at.now) {
            row.state = FAILED.to_owned();
            row.last_error_kind = Some("approval_stale".to_owned());
            row.next_attempt_at = None;
            row.updated_at = at.now;
            repo.update(&row)?;
            announce(out, &row);
            let approved_at = row.approved_at.unwrap_or_default();
            problem_in(tx, out, at, &row, Problem::ApprovedBeforeQuit { approved_at })?;
            continue;
        }
        let oldest = looked_at.insert(row.target_ref.clone());
        if !oldest || !due(&row, at.now) || busy.contains(&row.target_ref) || claimed.len() >= CLAIM_MAX {
            continue;
        }
        busy.insert(row.target_ref.clone());
        row.state = SENDING.to_owned();
        row.attempts += 1;
        row.updated_at = at.now;
        repo.update(&row)?;
        announce(out, &row);
        claimed.push(row);
    }
    if !claimed.is_empty() {
        tracing::debug!(claimed = claimed.len(), "deliveries were claimed");
    }
    Ok(claimed)
}

/// When a claim or lookup next has something to do: the earliest due time
/// of an uncertain row, or of a queued row that may go once due. A row that
/// waits behind an older or unknown send to its target is not counted, so
/// the loop does not wake for it again and again. None while halt holds
/// every send.
pub(crate) fn next_due_in(tx: &dyn Tx) -> Result<Option<i64>, Error> {
    if tx.inbox_halt().get()?.on {
        return Ok(None);
    }
    let repo = tx.inbox_deliveries();
    let busy = busy(repo)?;
    let mut looked_at: HashSet<String> = HashSet::new();
    let mut next = repo.next_due(UNCERTAIN)?;
    for row in repo.in_state(QUEUED)? {
        if looked_at.insert(row.target_ref.clone()) && !busy.contains(&row.target_ref) {
            next = next.into_iter().chain(row.next_attempt_at).min();
        }
    }
    Ok(next)
}

fn approval_too_old(row: &StoredDelivery, now: i64) -> bool {
    row.mode == APPROVED && row.attempts == 0 && row.approved_at.is_some_and(|at| now - at > APPROVED_FRESH_MS)
}
