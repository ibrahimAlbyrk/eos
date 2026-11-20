//! A subject that moved on or closed (03 G1, §4.5), as `signals:subject`
//! tells it. A new version flags the waiting drafts made on an older one as
//! stale, with how many newer versions came in; their send then needs the
//! user's second confirm. A closed subject expires every item about it: a
//! draft ends its run as `expired`, and the run's sends that wait stop.

use eos_contracts::SignalSubject;
use eos_core::Error;
use eos_core::routine::RunOutcomes;
use eos_core::store::{Outbox, StoredItem, Tx};
use eos_domain::inbox::{ItemKind, ItemState};
use eos_domain::routine::numbers::Outcome;
use serde_json::{Value, json};

use crate::delivery::{HOLDING, QUEUED, STOPPED};
use crate::outcomes::{Ended, ended_in};
use crate::{Items, announce};

/// Why an item whose subject closed expired, and why its sends stopped.
pub const SUBJECT_CLOSED: &str = "subject_closed";

impl Items {
    /// Acts on what `signals:subject` said of a subject, in one write job;
    /// how many items it changed.
    pub async fn subject(&self, change: SignalSubject) -> Result<usize, Error> {
        let (now, outcomes) = (self.clock.now_ms(), self.outcomes.clone());
        self.store.write(move |tx, out| subject_in(tx, out, now, outcomes.as_ref(), &change)).await
    }
}

pub(crate) fn subject_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    now: i64,
    outcomes: &dyn RunOutcomes,
    change: &SignalSubject,
) -> Result<usize, Error> {
    let mut changed = 0;
    for item in tx.inbox_items().waiting_with_subject(&change.subject_key)? {
        let moved = match &change.version {
            _ if change.closed => expire_in(tx, out, now, outcomes, item, Some(SUBJECT_CLOSED))?,
            Some(version) if item.kind == ItemKind::Draft => stale_in(tx, out, now, item, version)?,
            _ => false,
        };
        changed += usize::from(moved);
    }
    if changed > 0 {
        tracing::info!(items = changed, closed = change.closed, "items whose subject moved on changed");
    }
    Ok(changed)
}

/// The item expires, `why` when its subject closed; a draft ends its run
/// and stops the run's sends that wait.
pub(crate) fn expire_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    now: i64,
    outcomes: &dyn RunOutcomes,
    mut item: StoredItem,
    why: Option<&str>,
) -> Result<bool, Error> {
    let rev = item.rev;
    item.state = ItemState::Expired;
    if let Some(why) = why {
        item.stale_reason = Some(why.to_owned());
    }
    item.rev += 1;
    item.updated_at = now;
    if !tx.inbox_items().update_waiting(&item, rev)? {
        return Ok(false);
    }
    announce(tx, out, &item)?;
    if item.kind != ItemKind::Draft {
        return Ok(true);
    }
    if let Some(run_id) = &item.run_id {
        for mut row in
            tx.inbox_deliveries().of_run(run_id)?.into_iter().filter(|row| row.state == QUEUED || row.state == HOLDING)
        {
            row.state = STOPPED.to_owned();
            row.last_error_kind = Some(why.unwrap_or("expired").to_owned());
            row.next_attempt_at = None;
            row.updated_at = now;
            tx.inbox_deliveries().update(&row)?;
            crate::delivery::announce(out, &row);
        }
    }
    ended_in(tx, out, outcomes, Ended { item: &item, delivery_id: None, outcome: Outcome::Expired, at: now })?;
    Ok(true)
}

/// A version the draft was not made on: the draft is stale, by the number
/// of newer versions seen for it. The draft's payload keeps them, so a
/// version heard twice counts once.
fn stale_in(tx: &dyn Tx, out: &mut Outbox, now: i64, mut item: StoredItem, version: &str) -> Result<bool, Error> {
    let mut payload: Value = serde_json::from_str(&item.payload).unwrap_or_else(|_| json!({}));
    let own = payload["subjectVersion"].as_str() == Some(version);
    let mut newer: Vec<String> = serde_json::from_value(payload["newerVersions"].clone()).unwrap_or_default();
    if own || newer.iter().any(|seen| seen == version) || !payload.is_object() {
        return Ok(false);
    }
    newer.push(version.to_owned());
    let count = newer.len();
    payload["newerVersions"] = json!(newer);
    item.payload = payload.to_string();
    let rev = item.rev;
    item.rev += 1;
    item.updated_at = now;
    if !tx.inbox_items().retell(&item, rev)? {
        return Ok(false);
    }
    // The flag goes on in the same rev: one write as the user sees it.
    item.stale_at = Some(item.stale_at.unwrap_or(now));
    item.stale_reason = Some(format!("{count} new commit{}", if count == 1 { "" } else { "s" }));
    tx.inbox_items().update_waiting(&item, item.rev)?;
    announce(tx, out, &item)?;
    Ok(true)
}
