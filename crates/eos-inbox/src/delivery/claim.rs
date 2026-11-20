//! The claim (03 §4.8 "Engine"): one write job takes the rows that are due
//! and may go now, oldest first, at most one at a time per place a send
//! goes to (the routine, the recipient and the run's subject: its item at
//! any version), while halt is
//! off; each becomes `sending` with one more attempt. A row the
//! user approved over an hour ago and never tried (Eos was closed) is not
//! sent but told (03 G5), and an automatic one made over a day ago goes
//! back to the user as a draft. A row in its hold (`holding`) is claimed
//! like a queued one once due.

use std::collections::{HashMap, HashSet};

use eos_core::Error;
use eos_core::delivery::Channels;
use eos_core::routine::RunOutcomes;
use eos_core::store::{DeliveryRepo, Outbox, StoredDelivery, Tx};
use eos_domain::freedom::rung::APPROVED_FRESH_MS;

use super::record::{Again, Problem, hold_again_in, problem_in};
use super::{APPROVED, FAILED, HOLDING, QUEUED, SENDING, STOPPED, UNCERTAIN, WAITING_CAPABILITY, announce, automatic};
use crate::Opening;
use crate::gate::run_subject;

/// The most rows one claim takes.
const CLAIM_MAX: usize = 20;
/// An automatic send older than this is held for the user instead (03 G5).
pub(crate) const AUTO_HELD_AFTER_MS: i64 = 24 * 60 * 60 * 1000;

/// Where a send really goes: two sends to the same pull request go one at
/// a time, whichever of its versions they are about; sends to different
/// items or of different routines do not wait for each other.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct Place {
    routine_id: String,
    recipient_id: String,
    subject: Option<String>,
}

/// The place of each row, its run's subject read once per run.
struct Places<'a> {
    tx: &'a dyn Tx,
    subjects: HashMap<String, Option<String>>,
}

impl<'a> Places<'a> {
    fn new(tx: &'a dyn Tx) -> Self {
        Self { tx, subjects: HashMap::new() }
    }

    fn of(&mut self, row: &StoredDelivery) -> Result<Place, Error> {
        let subject = match self.subjects.get(&row.run_id) {
            Some(subject) => subject.clone(),
            None => {
                let subject = self.tx.runs().find(&row.run_id)?.as_ref().and_then(run_subject);
                self.subjects.insert(row.run_id.clone(), subject.clone());
                subject
            }
        };
        Ok(Place { routine_id: row.routine_id.clone(), recipient_id: row.target_ref.clone(), subject })
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

/// The rows that wait to go, queued or in their hold, oldest first.
pub(crate) fn waiting(repo: &dyn DeliveryRepo) -> Result<Vec<StoredDelivery>, Error> {
    let mut rows = repo.in_state(QUEUED)?;
    rows.extend(repo.in_state(HOLDING)?);
    rows.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
    Ok(rows)
}

pub(crate) fn claim_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    at: &Opening<'_>,
    outcomes: &dyn RunOutcomes,
) -> Result<Vec<StoredDelivery>, Error> {
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
    for mut row in waiting(repo)? {
        if due(&row, at.now) && automatic_too_old(&row, at.now) {
            row.state = STOPPED.to_owned();
            row.next_attempt_at = None;
            row.updated_at = at.now;
            let again = Again::TooOld;
            row.last_error_kind = Some(again.kind().to_owned());
            repo.update(&row)?;
            announce(out, &row);
            hold_again_in(tx, out, at, outcomes, &row, &again)?;
            continue;
        }
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
    for row in waiting(repo)? {
        let place = places.of(&row)?;
        if looked_at.insert(place.clone()) && !busy.contains(&place) {
            next = next.into_iter().chain(row.next_attempt_at).min();
        }
    }
    Ok(next)
}

/// An automatic send that has not gone out a day after it was made (Eos
/// was closed, or it waited on its capability).
pub(crate) fn automatic_too_old(row: &StoredDelivery, now: i64) -> bool {
    automatic(&row.mode) && now - row.created_at > AUTO_HELD_AFTER_MS
}

fn approval_too_old(row: &StoredDelivery, now: i64) -> bool {
    row.mode == APPROVED && row.attempts == 0 && row.approved_at.is_some_and(|at| now - at > APPROVED_FRESH_MS)
}

/// Every send that waits for its capability is queued again, due now, once
/// a channel sends it again; an automatic one a day old is then held at the
/// claim instead (03 G23, G5).
pub(crate) fn resume_in(tx: &dyn Tx, out: &mut Outbox, at: &Opening<'_>, channels: &dyn Channels) -> Result<(), Error> {
    let repo = tx.inbox_deliveries();
    for mut row in repo.in_state(WAITING_CAPABILITY)? {
        if channels.get(&row.channel).is_none() {
            continue;
        }
        row.state = QUEUED.to_owned();
        row.next_attempt_at = Some(at.now);
        row.last_error_kind = None;
        row.updated_at = at.now;
        repo.update(&row)?;
        announce(out, &row);
        tracing::info!(delivery_id = %row.id, "a send that waited for its capability goes again");
    }
    Ok(())
}
