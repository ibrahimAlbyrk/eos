//! The claim (03 §4.8 "Engine"): one write job takes the rows that are due
//! and may go now, oldest first, at most one at a time per target, while
//! halt is off; each becomes `sending` with one more attempt. A row the
//! user approved over an hour ago and never tried (Eos was closed) is not
//! sent but told (03 G5).

use std::collections::{HashMap, HashSet};

use eos_core::Error;
use eos_core::store::{Outbox, StoredDelivery, Tx};
use eos_domain::freedom::rung::APPROVED_FRESH_MS;

use super::record::{Problem, problem_in};
use super::{APPROVED, FAILED, QUEUED, SENDING, UNCERTAIN, announce};
use crate::Opening;

/// The most rows one claim takes.
const CLAIM_MAX: i64 = 20;

pub(crate) fn claim_in(tx: &dyn Tx, out: &mut Outbox, at: &Opening<'_>) -> Result<Vec<StoredDelivery>, Error> {
    if tx.inbox_halt().get()?.on {
        return Ok(Vec::new());
    }
    let repo = tx.inbox_deliveries();
    // A target waits while a send to it is out or unknown.
    let mut busy: HashSet<String> = HashSet::new();
    for state in [SENDING, UNCERTAIN] {
        busy.extend(repo.in_state(state)?.into_iter().map(|row| row.target_ref));
    }
    // Each target's sends go in the order they were made.
    let mut first: HashMap<String, String> = HashMap::new();
    for row in repo.in_state(QUEUED)? {
        first.entry(row.target_ref.clone()).or_insert(row.id);
    }
    let mut claimed = Vec::new();
    for mut row in repo.due(QUEUED, at.now, CLAIM_MAX)? {
        if approval_too_old(&row, at.now) {
            row.state = FAILED.to_owned();
            row.last_error_kind = Some("approval_stale".to_owned());
            row.next_attempt_at = None;
            row.updated_at = at.now;
            repo.update(&row)?;
            announce(out, &row);
            let approved_at = row.approved_at.unwrap_or_default();
            problem_in(tx, out, at, &row, Problem::ApprovedBeforeQuit { approved_at })?;
            first.remove(&row.target_ref);
            continue;
        }
        if busy.contains(&row.target_ref) || first.get(&row.target_ref) != Some(&row.id) {
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

fn approval_too_old(row: &StoredDelivery, now: i64) -> bool {
    row.mode == APPROVED && row.attempts == 0 && row.approved_at.is_some_and(|at| now - at > APPROVED_FRESH_MS)
}
