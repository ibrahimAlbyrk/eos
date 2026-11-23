//! The freedom a routine earns (03 G3, §4.8 "Streak and offers"). After a
//! send went out, the routine's streak is read from its outcomes since its
//! last offer, and at [`OFFER_AFTER`](eos_domain::freedom::streak::OFFER_AFTER)
//! one `freedom_offer` opens in the same job. Accept raises the routine
//! once the answer committed; Not now counts the streak again from then;
//! Never stops offers. An offer that expired unanswered counts as Not now.

use eos_contracts::{FreedomChange, FreedomView, OfferChoice, Rung};
use eos_core::Error;
use eos_core::store::{Outbox, StoredItem, StoredOffer, Tx};
use eos_domain::freedom::streak::{Counted, OfferState, offer_due, streak};
use eos_domain::inbox::ItemKind;
use serde_json::{Value, json};

use crate::Items;
use crate::items::{NewItem, Opening, open_in};

/// The topic a routine's rung, streak or offer announces.
pub const INBOX_FREEDOM: &str = "inbox:freedom";
/// Needs you acts on an offer's answer itself.
pub(crate) const OFFER_PRODUCER: &str = "inbox";
/// The outcomes the streak is read from, newest first.
const READ_BACK: i64 = 200;

/// Where a routine stands: its streak since its last offer, and its offer
/// row (a fresh one when it never had one; an offer that no longer waits
/// reads as declined).
pub(crate) fn standing_in(tx: &dyn Tx, routine_id: &str, now: i64) -> Result<(i64, StoredOffer), Error> {
    let mut offer = tx.inbox_offers().find(routine_id)?.unwrap_or_else(|| StoredOffer {
        routine_id: routine_id.to_owned(),
        state: OfferState::None.as_str().to_owned(),
        item_id: None,
        streak_at: None,
        next_at: None,
        updated_at: now,
    });
    let rows = tx.inbox_outcomes().by_routine(routine_id, READ_BACK)?;
    let floor = offer.streak_at.unwrap_or(0);
    let counted: Vec<Counted<'_>> = rows
        .iter()
        .filter(|row| row.id > floor)
        .map(|row| Counted { outcome: &row.outcome.outcome, at: row.outcome.at })
        .collect();
    if OfferState::parse(&offer.state) == OfferState::Offered && !offer_waits(tx, &offer)? {
        offer.state = OfferState::Declined.as_str().to_owned();
        offer.item_id = None;
    }
    Ok((streak(&counted, now), offer))
}

/// Whether the offer's item still waits for the user.
fn offer_waits(tx: &dyn Tx, offer: &StoredOffer) -> Result<bool, Error> {
    let Some(id) = &offer.item_id else { return Ok(false) };
    Ok(tx.inbox_items().find(id)?.is_some_and(|item| item.state.is_waiting()))
}

/// The routine's rung as the user confirmed it; none for a routine with no
/// confirmed version.
fn confirmed_rung(tx: &dyn Tx, at: &Opening<'_>, routine_id: &str) -> Result<Option<Rung>, Error> {
    match at.control.confirmed_in(tx, routine_id) {
        Ok(confirmed) => Ok(Some(confirmed.freedom.rung)),
        Err(Error::NotFound { .. }) => Ok(None),
        Err(error) => Err(error),
    }
}

fn announce(out: &mut Outbox, routine_id: &str, rung: Rung, streak: i64, offer: &StoredOffer) {
    let change = FreedomChange { routine_id: routine_id.to_owned(), rung, streak, offer: offer.state.clone() };
    out.push(INBOX_FREEDOM, &change);
}

/// A send of the routine went out: the streak is read again, an offer
/// opens when one is due, and `inbox:freedom` tells where it stands.
pub(crate) fn sent_in(tx: &dyn Tx, out: &mut Outbox, at: &Opening<'_>, routine_id: &str) -> Result<(), Error> {
    let Some(rung) = confirmed_rung(tx, at, routine_id)? else { return Ok(()) };
    let (count, mut offer) = standing_in(tx, routine_id, at.now)?;
    if let Some(next) = offer_due(count, OfferState::parse(&offer.state), rung) {
        let item = open_in(tx, out, at, offer_item(tx, routine_id, rung, next, count)?)?;
        offer.state = OfferState::Offered.as_str().to_owned();
        offer.item_id = Some(item.id.clone());
        offer.streak_at = tx.inbox_outcomes().by_routine(routine_id, 1)?.first().map(|row| row.id);
        offer.updated_at = at.now;
        tx.inbox_offers().put(&offer)?;
        tracing::info!(routine_id, item_id = %item.id, streak = count, "a routine was offered more freedom");
        announce(out, routine_id, rung, 0, &offer);
        return Ok(());
    }
    announce(out, routine_id, rung, count, &offer);
    Ok(())
}

/// How a routine's new head differs from the one before it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HeadChange {
    /// The user changed its Freedom by hand.
    pub freedom_by_hand: bool,
    /// Who works, how or what it makes changed.
    pub work: bool,
}

/// A routine kept a new head at `rung`: a Freedom the user changed by hand
/// lifts a "Never" on offers, and a change of who works, how or what it
/// makes counts the streak again from here (03 G3, §4.8).
pub fn head_changed_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    routine_id: &str,
    rung: Rung,
    change: HeadChange,
    now: i64,
) -> Result<(), Error> {
    let (count, mut offer) = standing_in(tx, routine_id, now)?;
    let lifts = change.freedom_by_hand && OfferState::parse(&offer.state) == OfferState::Never;
    if !lifts && !change.work {
        return Ok(());
    }
    if lifts {
        offer.state = OfferState::None.as_str().to_owned();
    }
    let mut count = count;
    if change.work {
        offer.streak_at = tx.inbox_outcomes().by_routine(routine_id, 1)?.first().map(|row| row.id).or(offer.streak_at);
        count = 0;
    }
    offer.updated_at = now;
    tx.inbox_offers().put(&offer)?;
    tracing::info!(
        routine_id,
        lifted = lifts,
        reset = change.work,
        "a routine's new head changed where it stands with offers"
    );
    announce(out, routine_id, rung, count, &offer);
    Ok(())
}

fn offer_item(tx: &dyn Tx, routine_id: &str, from: Rung, to: Rung, count: i64) -> Result<NewItem, Error> {
    let name = tx.routines().find(routine_id)?.map(|routine| routine.name).unwrap_or_else(|| "This routine".into());
    let (title, summary) = match to {
        Rung::Draft => (
            format!("Let {name} start without asking"),
            format!(
                "You sent its last {count} results as Eos made them. It can start on its own and keep each result as a draft for you."
            ),
        ),
        Rung::SendThenTell => (
            format!("Let {name} send, then tell you"),
            format!(
                "You sent its last {count} results as Eos made them. It can send them itself and tell you after, with a short time to undo."
            ),
        ),
        _ => (
            format!("Let {name} send on its own"),
            format!("Its last {count} sends went out without an undo. It can send without telling you each time."),
        ),
    };
    Ok(NewItem {
        kind: ItemKind::FreedomOffer,
        producer: OFFER_PRODUCER.to_owned(),
        routine_id: Some(routine_id.to_owned()),
        run_id: None,
        subject_key: Some(format!("freedom:{routine_id}")),
        title,
        summary,
        payload: json!({ "from": from, "rung": to, "streak": count }),
        by_hand: false,
    })
}

/// The user answered `item`, an offer, in the answering job. The rung to
/// raise the routine to once the job committed, on Accept.
pub(crate) fn answered_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    item: &StoredItem,
    choice: OfferChoice,
    now: i64,
) -> Result<Option<Rung>, Error> {
    crate::consume_in(tx, &item.id, now)?;
    let Some(routine_id) = item.routine_id.as_deref() else { return Ok(None) };
    let payload: Value = serde_json::from_str(&item.payload).unwrap_or(Value::Null);
    let offered: Option<Rung> = serde_json::from_value(payload["rung"].clone()).ok();
    let from: Option<Rung> = serde_json::from_value(payload["from"].clone()).ok();
    let state = match choice {
        OfferChoice::Accept => OfferState::None,
        OfferChoice::NotNow => OfferState::Declined,
        OfferChoice::Never => OfferState::Never,
    };
    let latest = tx.inbox_outcomes().by_routine(routine_id, 1)?.first().map(|row| row.id);
    let offer = StoredOffer {
        routine_id: routine_id.to_owned(),
        state: state.as_str().to_owned(),
        item_id: None,
        streak_at: latest,
        next_at: None,
        updated_at: now,
    };
    tx.inbox_offers().put(&offer)?;
    tracing::info!(routine_id, item_id = %item.id, state = state.as_str(), "an offer of freedom was answered");
    let raise = offered.filter(|_| choice == OfferChoice::Accept);
    if let Some(rung) = raise.or(from) {
        announce(out, routine_id, rung, 0, &offer);
    }
    Ok(raise)
}

/// `GET /api/routines/{id}/freedom`: the confirmed Freedom, the streak and
/// the offer, in one read.
pub(crate) fn view_in(tx: &dyn Tx, at: &Opening<'_>, routine_id: &str) -> Result<FreedomView, Error> {
    let confirmed = at.control.confirmed_in(tx, routine_id)?;
    let (count, offer) = standing_in(tx, routine_id, at.now)?;
    Ok(FreedomView {
        routine_id: routine_id.to_owned(),
        rung: confirmed.freedom.rung,
        grants: confirmed.freedom.grants,
        streak: count,
        offer: offer.state,
        offer_item_id: offer.item_id,
    })
}

impl Items {
    /// Where the routine stands with Freedom: what the user confirmed, its
    /// streak and its offer.
    pub async fn freedom(&self, routine_id: &str) -> Result<FreedomView, Error> {
        let (id, now) = (routine_id.to_owned(), self.clock.now_ms());
        let (ids, zone, control) = (self.ids.clone(), self.zone.clone(), self.control.clone());
        self.store
            .read(move |tx| {
                let at = Opening { now, ids: ids.as_ref(), zone: zone.as_ref(), control: control.as_ref() };
                view_in(tx, &at, &id)
            })
            .await
    }
}
