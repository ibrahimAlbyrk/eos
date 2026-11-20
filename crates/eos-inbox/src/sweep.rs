//! The sweeper's pass (03 §4.5, G12, §5 retention): an item whose time ran
//! out expires by its kind (a draft ends its run `expired`; a run's start
//! is answered `expired` by the system, so the run hears it through the
//! handoff and is skipped); an item put off until a time that passed opens
//! again; items that ended over 90 days ago are deleted, a page per job.
//! Deliveries, edits and outcomes stay as long as their run.

use eos_core::Error;
use eos_core::routine::RunOutcomes;
use eos_core::store::{ItemAnswer, Outbox, StoredItem, Tx};
use eos_domain::inbox::{ItemKind, ItemState};

use crate::answer::answer_in;
use crate::stale::expire_in;
use crate::{Items, announce};

/// How long an item that ended is kept.
const RETAINED_MS: i64 = 90 * 24 * 60 * 60 * 1000;
/// The most items one retention job deletes.
const DELETE_PAGE: i64 = 1_000;
/// The most waiting items one pass looks at.
const WAITING_MAX: i64 = 10_000;
/// What a run's start that expired is answered.
const EXPIRED: &str = r#"{"expired":true}"#;

impl Items {
    /// One pass of the sweeper; when the next waiting item expires or comes
    /// back, if any does.
    pub async fn sweep(&self) -> Result<Option<i64>, Error> {
        let (now, outcomes) = (self.clock.now_ms(), self.outcomes.clone());
        let next = self.store.write(move |tx, out| sweep_in(tx, out, now, outcomes.as_ref())).await?;
        let mut deleted = 0;
        loop {
            let page = self
                .store
                .write(move |tx, _| tx.inbox_items().delete_ended_before(now - RETAINED_MS, DELETE_PAGE))
                .await?;
            deleted += page;
            if page < DELETE_PAGE as usize {
                break;
            }
        }
        if deleted > 0 {
            tracing::info!(deleted, "items that ended long ago were deleted");
        }
        Ok(next)
    }
}

fn sweep_in(tx: &dyn Tx, out: &mut Outbox, now: i64, outcomes: &dyn RunOutcomes) -> Result<Option<i64>, Error> {
    let mut next: Option<i64> = None;
    let (mut expired, mut back) = (0, 0);
    for item in tx.inbox_items().waiting(WAITING_MAX)? {
        if item.expires_at.is_some_and(|at| at <= now) {
            expired += usize::from(expire_by_kind_in(tx, out, now, outcomes, item)?);
            continue;
        }
        if item.state == ItemState::Later && item.later_until.is_some_and(|at| at <= now) {
            back += usize::from(back_in(tx, out, now, item)?);
            continue;
        }
        let later = item.later_until.filter(|_| item.state == ItemState::Later);
        next = next.into_iter().chain(item.expires_at).chain(later).min();
    }
    if expired + back > 0 {
        tracing::info!(expired, back, "the sweeper moved items");
    }
    Ok(next)
}

/// A run's start is answered `expired` for its run to be skipped; any other
/// kind expires.
fn expire_by_kind_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    now: i64,
    outcomes: &dyn RunOutcomes,
    item: StoredItem,
) -> Result<bool, Error> {
    if item.kind != ItemKind::RunStart {
        return expire_in(tx, out, now, outcomes, item, None);
    }
    let answer = ItemAnswer { by: "system".to_owned(), answer: Some(EXPIRED.to_owned()), at: now };
    Ok(answer_in(tx, out, &item.id, item.rev, &answer)?.is_ok())
}

/// An item put off until a time that passed opens again.
fn back_in(tx: &dyn Tx, out: &mut Outbox, now: i64, mut item: StoredItem) -> Result<bool, Error> {
    let rev = item.rev;
    item.state = ItemState::Open;
    item.later_until = None;
    item.rev += 1;
    item.updated_at = now;
    if !tx.inbox_items().update_waiting(&item, rev)? {
        return Ok(false);
    }
    announce(tx, out, &item)?;
    Ok(true)
}
