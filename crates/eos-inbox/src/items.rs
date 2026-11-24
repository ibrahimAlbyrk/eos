//! Opening items inside a producer's write job, and withdrawing a deleted
//! routine's and those of a run's start that no longer waits.

use eos_core::Error;
use eos_core::Ids;
use eos_core::os::TimeZone;
use eos_core::routine::RoutineControl;
use eos_core::store::{Outbox, StoredItem, Tx};
use eos_domain::inbox::{ItemKind, ItemState};
use serde_json::{Value, json};

use crate::announce;

/// A routine with more items than this waiting is paused.
pub const ROUTINE_CAP: usize = 25;
/// Why a routine with too many items waiting was paused, and the subject of
/// the one alert that says so.
pub const TOO_MANY_WAITING: &str = "too_many_waiting";
/// The largest payload an item carries; a larger result goes by reference.
const PAYLOAD_MAX: usize = 256 * 1024;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// Routines act on a routine alert's answer.
pub(crate) const ALERT_PRODUCER: &str = "routines";

/// What a producer opens.
#[derive(Debug, Clone, PartialEq)]
pub struct NewItem {
    pub kind: ItemKind,
    /// The module that acts on its answer.
    pub producer: String,
    pub routine_id: Option<String>,
    pub run_id: Option<String>,
    /// What it is about. A newer item of the same kind, producer and routine
    /// about the same subject takes the place of the one that waits. A
    /// notice's subject is its own kind (`over-limit`), and it replaces only
    /// the notice of the same local day.
    pub subject_key: Option<String>,
    pub title: String,
    pub summary: String,
    pub payload: Value,
    /// The user started the run that made it, and is likely waiting for it.
    pub by_hand: bool,
}

/// What opening an item needs from the producer's side.
#[derive(Clone, Copy)]
pub struct Opening<'a> {
    pub now: i64,
    pub ids: &'a dyn Ids,
    /// The user's time zone: a notice replaces only the same local day's.
    pub zone: &'a dyn TimeZone,
    /// Pauses a routine with too many items waiting, inside the same job.
    pub control: &'a dyn RoutineControl,
}

impl std::fmt::Debug for Opening<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Opening").field("now", &self.now).finish_non_exhaustive()
    }
}

/// The local day `at` falls on, counted from the epoch.
pub(crate) fn local_day(zone: &dyn TimeZone, at: i64) -> i64 {
    (at + i64::from(zone.offset_minutes_at(at)) * 60_000).div_euclid(DAY_MS)
}

/// Whether `waiting` gives way to `new`, which is about the same subject.
fn replaced_by(waiting: &StoredItem, new: &NewItem, at: &Opening<'_>) -> bool {
    let same = waiting.kind == new.kind && waiting.producer == new.producer && waiting.routine_id == new.routine_id;
    let same_day = new.kind != ItemKind::Notice || local_day(at.zone, waiting.created_at) == local_day(at.zone, at.now);
    same && same_day
}

/// Opens an item inside the producer's write job: it takes the place of the
/// waiting items about its subject, and a routine that has more than
/// [`ROUTINE_CAP`] items waiting is paused with one `routine_alert`. Every
/// item it writes is announced on `inbox:change` after the job commits.
pub fn open_in(tx: &dyn Tx, out: &mut Outbox, at: &Opening<'_>, new: NewItem) -> Result<StoredItem, Error> {
    open_replacing_in(tx, out, at, new).map(|(item, _)| item)
}

/// As [`open_in`], with the items the new one replaced.
pub(crate) fn open_replacing_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    at: &Opening<'_>,
    new: NewItem,
) -> Result<(StoredItem, Vec<StoredItem>), Error> {
    let payload = serde_json::to_string(&new.payload).map_err(|e| Error::Validation(e.to_string()))?;
    if payload.len() > PAYLOAD_MAX {
        return Err(Error::Validation("an item's payload is at most 256 KiB".into()));
    }
    let id = at.ids.inbox_id();
    let mut replaced = Vec::new();
    if let Some(subject) = &new.subject_key {
        for mut old in tx.inbox_items().waiting_with_subject(subject)? {
            if !replaced_by(&old, &new, at) {
                continue;
            }
            let rev = old.rev;
            old.state = ItemState::Replaced;
            old.replaced_by = Some(id.clone());
            old.rev += 1;
            old.updated_at = at.now;
            if tx.inbox_items().update_waiting(&old, rev)? {
                tracing::info!(item_id = %old.id, replaced_by = %id, kind = old.kind.as_str(), "an item was replaced");
                announce(tx, out, &old)?;
                replaced.push(old);
            }
        }
    }
    let item = StoredItem {
        id,
        kind: new.kind,
        state: ItemState::Open,
        producer: new.producer,
        routine_id: new.routine_id,
        run_id: new.run_id,
        subject_key: new.subject_key,
        title: new.title,
        summary: new.summary,
        payload,
        working: None,
        rev: 1,
        attention: new.kind.attention(new.by_hand),
        stale_at: None,
        stale_reason: None,
        later_until: None,
        expires_at: new.kind.expires_at(at.now),
        created_at: at.now,
        updated_at: at.now,
        answered_at: None,
        answered_by: None,
        answer: None,
        replaced_by: None,
        consumed_at: None,
        notified_at: None,
    };
    tx.inbox_items().insert(&item)?;
    tracing::info!(item_id = %item.id, kind = item.kind.as_str(), routine_id = ?item.routine_id, "an item opened");
    announce(tx, out, &item)?;
    if let Some(routine_id) = item.routine_id.as_deref().filter(|_| item.kind != ItemKind::RoutineAlert) {
        cap_in(tx, out, at, routine_id)?;
    }
    Ok((item, replaced))
}

/// A notice that keeps count through the day (`over-limit`): the day's
/// waiting notice of the same producer, routine and subject is brought up
/// to date in place; otherwise one opens.
pub fn notice_in(tx: &dyn Tx, out: &mut Outbox, at: &Opening<'_>, new: NewItem) -> Result<StoredItem, Error> {
    let subject = new.subject_key.clone().unwrap_or_default();
    let waiting = tx.inbox_items().waiting_with_subject(&subject)?;
    let today = waiting.into_iter().find(|old| old.kind == ItemKind::Notice && replaced_by(old, &new, at));
    let Some(mut item) = today else { return open_in(tx, out, at, new) };
    let rev = item.rev;
    item.title = new.title;
    item.summary = new.summary;
    item.payload = serde_json::to_string(&new.payload).map_err(|e| Error::Validation(e.to_string()))?;
    item.rev += 1;
    item.updated_at = at.now;
    if tx.inbox_items().retell(&item, rev)? {
        announce(tx, out, &item)?;
    }
    Ok(item)
}

impl crate::Items {
    /// Opens or brings up to date the day's notice `new`, in a write job of
    /// its own, for a producer that writes nothing with it.
    pub async fn notice(&self, new: NewItem) -> Result<StoredItem, Error> {
        let (now, ids, zone, control) =
            (self.clock.now_ms(), self.ids.clone(), self.zone.clone(), self.control.clone());
        self.store
            .write(move |tx, out| {
                let at = Opening { now, ids: ids.as_ref(), zone: zone.as_ref(), control: control.as_ref() };
                notice_in(tx, out, &at, new)
            })
            .await
    }
}

/// Pauses a routine with more than [`ROUTINE_CAP`] items waiting, so nobody
/// pays for results nobody reads, and tells the user once.
fn cap_in(tx: &dyn Tx, out: &mut Outbox, at: &Opening<'_>, routine_id: &str) -> Result<(), Error> {
    let waiting = tx.inbox_items().waiting_of_routine(routine_id)?;
    let results = waiting.iter().filter(|item| item.kind != ItemKind::RoutineAlert).count();
    if results <= ROUTINE_CAP {
        return Ok(());
    }
    at.control.pause_in(tx, out, routine_id, TOO_MANY_WAITING)?;
    let alerted = waiting
        .iter()
        .any(|item| item.kind == ItemKind::RoutineAlert && item.subject_key.as_deref() == Some(TOO_MANY_WAITING));
    if alerted {
        return Ok(());
    }
    tracing::info!(routine_id, waiting = results, "a routine was paused: too many items wait");
    open_in(
        tx,
        out,
        at,
        NewItem {
            kind: ItemKind::RoutineAlert,
            producer: ALERT_PRODUCER.to_owned(),
            routine_id: Some(routine_id.to_owned()),
            run_id: None,
            subject_key: Some(TOO_MANY_WAITING.to_owned()),
            title: format!("{results} results wait for you"),
            summary: "The routine is paused until you go through them.".to_owned(),
            payload: json!({ "reason": TOO_MANY_WAITING, "waiting": results }),
            by_hand: false,
        },
    )
    .map(drop)
}

/// A deleted routine's waiting items become `withdrawn`, inside the
/// deleting job. Answers how many.
pub fn withdraw_routine_in(tx: &dyn Tx, out: &mut Outbox, now: i64, routine_id: &str) -> Result<usize, Error> {
    let mut withdrawn = 0;
    for mut item in tx.inbox_items().waiting_of_routine(routine_id)? {
        let rev = item.rev;
        item.state = ItemState::Withdrawn;
        item.rev += 1;
        item.updated_at = now;
        if tx.inbox_items().update_waiting(&item, rev)? {
            announce(tx, out, &item)?;
            withdrawn += 1;
        }
    }
    tracing::info!(routine_id, withdrawn, "a deleted routine's items were withdrawn");
    Ok(withdrawn)
}

/// A run's start that waits becomes `withdrawn` once its run leaves the
/// queue some other way (skipped, stopped, started without it), inside the
/// job that moves the run: no answer can act on it any more.
pub fn withdraw_run_start_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    now: i64,
    routine_id: &str,
    run_id: &str,
) -> Result<(), Error> {
    for mut item in tx.inbox_items().waiting_of_routine(routine_id)? {
        if item.kind != ItemKind::RunStart || item.run_id.as_deref() != Some(run_id) {
            continue;
        }
        let rev = item.rev;
        item.state = ItemState::Withdrawn;
        item.rev += 1;
        item.updated_at = now;
        if tx.inbox_items().update_waiting(&item, rev)? {
            tracing::info!(item_id = %item.id, run_id, "a run's start that waited was withdrawn");
            announce(tx, out, &item)?;
        }
    }
    Ok(())
}
