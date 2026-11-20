//! What the user does with an item: answer it, put it aside, discard it or
//! save edits of a draft. Each is one write job guarded by the item's rev.

use std::sync::Arc;

use eos_contracts::{InboxAnswer, ResultDoc};
use eos_core::delivery::Channels;
use eos_core::routine::RunOutcomes;
use eos_core::store::{ItemAnswer, Outbox, Store, StoredItem, Tx};
use eos_core::{Clock, Ids};
use eos_domain::inbox::{ItemKind, ItemState};
use eos_domain::routine::numbers::Outcome;
use tokio::sync::Notify;

use crate::outcomes::{self, Ended};
use crate::questions::QuestionWaiters;
use crate::{Error, announce, consume_in};

/// The kinds answered through [`Items::answer`]. A draft is sent or
/// discarded; a run's permission ask and an about-you suggestion are answered
/// by their own routes.
const ANSWERED_HERE: [ItemKind; 6] = [
    ItemKind::RunStart,
    ItemKind::Question,
    ItemKind::RoutineAlert,
    ItemKind::ConfirmChange,
    ItemKind::Notice,
    ItemKind::Suggestion,
];

/// What a discard stores as the answer.
const DISCARDED: &str = r#"{"discard":true}"#;

/// What a write found when the item is not as the caller saw it.
pub(crate) type Checked = Result<StoredItem, Error>;

/// The item, if it still waits at `rev` (any rev when none is named).
pub(crate) fn waiting_at(tx: &dyn Tx, id: &str, rev: Option<i64>) -> Result<Checked, eos_core::Error> {
    let item = tx.inbox_items().find(id)?.ok_or_else(|| eos_core::Error::not_found("item", id))?;
    if !item.state.is_waiting() {
        return Ok(Err(Error::AlreadyAnswered { state: item.state, answered_by: item.answered_by }));
    }
    match rev {
        Some(rev) if rev != item.rev => Ok(Err(Error::Changed { rev: item.rev })),
        _ => Ok(Ok(item)),
    }
}

/// Answers the item in one statement guarded by state and rev.
pub(crate) fn answer_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    id: &str,
    rev: i64,
    answer: &ItemAnswer,
) -> Result<Checked, eos_core::Error> {
    let item = match waiting_at(tx, id, Some(rev))? {
        Ok(item) => item,
        Err(refused) => return Ok(Err(refused)),
    };
    if !tx.inbox_items().answer(id, rev, answer)? {
        return Ok(Err(Error::Changed { rev: item.rev }));
    }
    let item = tx.inbox_items().find(id)?.ok_or_else(|| eos_core::Error::not_found("item", id))?;
    tracing::info!(item_id = %item.id, kind = item.kind.as_str(), by = %answer.by, "an item was answered");
    announce(tx, out, &item)?;
    Ok(Ok(item))
}

/// Changes a waiting item with `edit`, one rev up.
fn change_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    id: &str,
    rev: Option<i64>,
    now: i64,
    edit: impl FnOnce(&mut StoredItem) -> Result<(), eos_core::Error>,
) -> Result<Checked, eos_core::Error> {
    let mut item = match waiting_at(tx, id, rev)? {
        Ok(item) => item,
        Err(refused) => return Ok(Err(refused)),
    };
    let was = item.rev;
    edit(&mut item)?;
    item.rev = was + 1;
    item.updated_at = now;
    if !tx.inbox_items().update_waiting(&item, was)? {
        return Ok(Err(Error::Changed { rev: was }));
    }
    tracing::info!(item_id = %item.id, kind = item.kind.as_str(), state = item.state.as_str(), "an item changed");
    announce(tx, out, &item)?;
    Ok(Ok(item))
}

/// What the user's side of Needs you is built from.
pub struct ItemsParts {
    pub store: Arc<dyn Store>,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn Ids>,
    /// The channels a sent draft goes out through, for their actions' traits.
    pub channels: Arc<dyn Channels>,
    /// Hears what became of each run's result.
    pub outcomes: Arc<dyn RunOutcomes>,
    /// Poked once a send was queued ([`Gate::waker`](crate::gate::Gate::waker)).
    pub wake: Arc<Notify>,
    /// The run askers waiting on their questions
    /// ([`RunQuestions::waiters`](crate::RunQuestions::waiters)).
    pub waiters: Arc<QuestionWaiters>,
}

impl std::fmt::Debug for ItemsParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ItemsParts").finish_non_exhaustive()
    }
}

/// The user's side of Needs you.
#[derive(Clone)]
pub struct Items {
    pub(crate) store: Arc<dyn Store>,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) ids: Arc<dyn Ids>,
    pub(crate) channels: Arc<dyn Channels>,
    pub(crate) outcomes: Arc<dyn RunOutcomes>,
    pub(crate) wake: Arc<Notify>,
    waiters: Arc<QuestionWaiters>,
}

impl std::fmt::Debug for Items {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Items").finish_non_exhaustive()
    }
}

impl Items {
    pub fn new(parts: ItemsParts) -> Self {
        let ItemsParts { store, clock, ids, channels, outcomes, wake, waiters } = parts;
        Self { store, clock, ids, channels, outcomes, wake, waiters }
    }

    /// Answers the item as it was at `rev`. `by` is who answered:
    /// `dashboard`, `phone`, `peer` or `system`. The answer must be of the
    /// item's kind, and of a kind answered here.
    pub async fn answer(&self, id: &str, rev: i64, answer: &InboxAnswer, by: &str) -> Result<StoredItem, Error> {
        let text = serde_json::to_value(answer).map_err(|e| eos_core::Error::Validation(e.to_string()))?;
        let kind = text["kind"].as_str().and_then(ItemKind::parse);
        let answer = ItemAnswer { by: by.to_owned(), answer: Some(text.to_string()), at: self.clock.now_ms() };
        let id = id.to_owned();
        let item = self
            .store
            .write(move |tx, out| {
                let item = tx.inbox_items().find(&id)?.ok_or_else(|| eos_core::Error::not_found("item", &id))?;
                if item.state.is_waiting() && !ANSWERED_HERE.contains(&item.kind) {
                    return Err(eos_core::Error::Validation(format!(
                        "a {} item is not answered here",
                        item.kind.as_str()
                    )));
                }
                if item.state.is_waiting() && kind != Some(item.kind) {
                    return Err(eos_core::Error::Validation(format!(
                        "the answer is not for a {} item",
                        item.kind.as_str()
                    )));
                }
                answer_in(tx, out, &id, rev, &answer)
            })
            .await??;
        self.waiters.wake(&item);
        Ok(item)
    }

    /// Puts the item aside until `until`, or until the next digest.
    pub async fn later(&self, id: &str, until: Option<i64>) -> Result<StoredItem, Error> {
        let (id, now) = (id.to_owned(), self.clock.now_ms());
        self.store
            .write(move |tx, out| {
                change_in(tx, out, &id, None, now, |item| {
                    item.state = ItemState::Later;
                    item.later_until = until;
                    Ok(())
                })
            })
            .await?
    }

    /// Discards the item as it was at `rev`: its producer hears a discard.
    /// A discarded draft ends its run as `discarded`, in the same job.
    pub async fn discard(&self, id: &str, rev: i64, by: &str) -> Result<StoredItem, Error> {
        let now = self.clock.now_ms();
        let answer = ItemAnswer { by: by.to_owned(), answer: Some(DISCARDED.to_owned()), at: now };
        let (id, run_outcomes) = (id.to_owned(), self.outcomes.clone());
        let item = self
            .store
            .write(move |tx, out| {
                let item = match answer_in(tx, out, &id, rev, &answer)? {
                    Ok(item) => item,
                    Err(refused) => return Ok(Err(refused)),
                };
                if item.kind == ItemKind::Draft {
                    consume_in(tx, &item.id, now)?;
                    let ended = Ended { item: &item, delivery_id: None, outcome: Outcome::Discarded, at: now };
                    outcomes::ended_in(tx, out, run_outcomes.as_ref(), ended)?;
                }
                Ok(Ok(item))
            })
            .await??;
        self.waiters.wake(&item);
        Ok(item)
    }

    /// Keeps the user's edits of a draft made on `rev`.
    pub async fn save_draft(&self, id: &str, rev: i64, doc: &ResultDoc) -> Result<StoredItem, Error> {
        let working = serde_json::to_string(doc).map_err(|e| eos_core::Error::Validation(e.to_string()))?;
        let (id, now) = (id.to_owned(), self.clock.now_ms());
        self.store
            .write(move |tx, out| {
                change_in(tx, out, &id, Some(rev), now, |item| {
                    if item.kind != ItemKind::Draft {
                        return Err(eos_core::Error::Validation("only a draft keeps edits".into()));
                    }
                    item.working = Some(working);
                    Ok(())
                })
            })
            .await?
    }

    /// `producer`'s answered items it has not acted on yet, first answered
    /// first. The producer marks each with [`consume_in`](crate::consume_in)
    /// once it acted.
    pub async fn unconsumed(&self, producer: &str) -> Result<Vec<StoredItem>, Error> {
        let producer = producer.to_owned();
        Ok(self.store.read(move |tx| tx.inbox_items().unconsumed(&producer)).await?)
    }
}
