//! The claim (03 §4.8 "Engine"): one write job takes the rows that are due
//! and may go now, oldest first, at most one at a time per place a send
//! goes to (the routine, the recipient and the run's item), while halt is
//! off; each becomes `sending` with one more attempt. A row the
//! user approved over an hour ago and never tried (Eos was closed) is not
//! sent but told (03 G5).

use std::collections::{HashMap, HashSet};

use eos_core::Error;
use eos_core::store::{DeliveryRepo, Outbox, StoredDelivery, Tx};
use eos_domain::freedom::rung::APPROVED_FRESH_MS;

use super::record::{Problem, problem_in};
use super::{APPROVED, FAILED, QUEUED, SENDING, UNCERTAIN, announce};
use crate::Opening;

/// The most rows one claim takes.
const CLAIM_MAX: usize = 20;

/// Where a send really goes: two sends to the same pull request go one at
/// a time, sends to different items or of different routines do not wait
/// for each other.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct Place {
    routine_id: String,
    recipient_id: String,
    item_key: Option<String>,
}

/// The place of each row, its run's item key read once per run.
struct Places<'a> {
    tx: &'a dyn Tx,
    item_keys: HashMap<String, Option<String>>,
}

impl<'a> Places<'a> {
    fn new(tx: &'a dyn Tx) -> Self {
        Self { tx, item_keys: HashMap::new() }
    }

    fn of(&mut self, row: &StoredDelivery) -> Result<Place, Error> {
        let item_key = match self.item_keys.get(&row.run_id) {
            Some(key) => key.clone(),
            None => {
                let key = self.tx.runs().find(&row.run_id)?.and_then(|run| run.item_key);
                self.item_keys.insert(row.run_id.clone(), key.clone());
                key
            }
        };
        Ok(Place { routine_id: row.routine_id.clone(), recipient_id: row.target_ref.clone(), item_key })
    }
}

/// The places that wait while a send to them is out or unknown.
fn busy(repo: &dyn DeliveryRepo, places: &mut Places<'_>) -> Result<HashSet<Place>, Error> {
    let mut busy = HashSet::new();
    for state in [SENDING, UNCERTAIN] {
        for row in repo.in_state(state)? {
            busy.insert(places.of(&row)?);
        }
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
    let mut places = Places::new(tx);
    let mut busy = busy(repo, &mut places)?;
    // Each place's sends go in the order they were made: only its oldest
    // queued row may go.
    let mut looked_at: HashSet<Place> = HashSet::new();
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
        let place = places.of(&row)?;
        let oldest = looked_at.insert(place.clone());
        if !oldest || !due(&row, at.now) || busy.contains(&place) || claimed.len() >= CLAIM_MAX {
            continue;
        }
        busy.insert(place);
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
/// waits behind an older or unknown send to its place is not counted, so
/// the loop does not wake for it again and again. None while halt holds
/// every send.
pub(crate) fn next_due_in(tx: &dyn Tx) -> Result<Option<i64>, Error> {
    if tx.inbox_halt().get()?.on {
        return Ok(None);
    }
    let repo = tx.inbox_deliveries();
    let mut places = Places::new(tx);
    let busy = busy(repo, &mut places)?;
    let mut looked_at: HashSet<Place> = HashSet::new();
    let mut next = repo.next_due(UNCERTAIN)?;
    for row in repo.in_state(QUEUED)? {
        let place = places.of(&row)?;
        if looked_at.insert(place.clone()) && !busy.contains(&place) {
            next = next.into_iter().chain(row.next_attempt_at).min();
        }
    }
    Ok(next)
}

fn approval_too_old(row: &StoredDelivery, now: i64) -> bool {
    row.mode == APPROVED && row.attempts == 0 && row.approved_at.is_some_and(|at| now - at > APPROVED_FRESH_MS)
}
