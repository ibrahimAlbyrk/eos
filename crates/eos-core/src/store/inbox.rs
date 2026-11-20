//! The Needs-you tables: `inbox_items`, `inbox_deliveries`, `inbox_edits`,
//! `inbox_outcomes`, `inbox_offers` and `inbox_halt`. Titles, summaries,
//! payloads, drafts, answers, bodies, targets and receipts are the user's
//! data: never logged.

use eos_contracts::ActionClass;
use eos_domain::inbox::{Attention, ItemKind, ItemState};

use crate::Error;

/// A row of `inbox_items`: one thing that waits for the user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredItem {
    /// `nd-` and 12 hex.
    pub id: String,
    pub kind: ItemKind,
    pub state: ItemState,
    /// The module that made it, and acts on its answer.
    pub producer: String,
    pub routine_id: Option<String>,
    pub run_id: Option<String>,
    /// The thing it is about, as its signal named it.
    pub subject_key: Option<String>,
    pub title: String,
    pub summary: String,
    /// What its kind carries, as JSON.
    pub payload: String,
    /// The user's saved edits, as JSON.
    pub working: Option<String>,
    /// One up per write: an answer names the rev it was made on.
    pub rev: i64,
    pub attention: Attention,
    /// Its subject moved on since it was made.
    pub stale_at: Option<i64>,
    pub stale_reason: Option<String>,
    /// Put aside until then.
    pub later_until: Option<i64>,
    pub expires_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub answered_at: Option<i64>,
    /// `dashboard`, `phone`, `peer` or `system`.
    pub answered_by: Option<String>,
    /// The answer, as JSON.
    pub answer: Option<String>,
    /// The item that took its place.
    pub replaced_by: Option<String>,
    /// Its producer acted on the answer.
    pub consumed_at: Option<i64>,
    pub notified_at: Option<i64>,
}

/// The user's answer to an item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemAnswer {
    /// `dashboard`, `phone`, `peer` or `system`.
    pub by: String,
    /// As JSON.
    pub answer: Option<String>,
    pub at: i64,
}

/// A row of `inbox_deliveries`: one result on its way to one target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredDelivery {
    /// `dl-` and 12 hex: the key every attempt sends under.
    pub id: String,
    /// The item it was approved from; none for a delivery Freedom sent.
    pub item_id: Option<String>,
    pub run_id: String,
    pub routine_id: String,
    pub channel: String,
    pub action: String,
    /// The id of the Goes-to recipient it goes to.
    pub target_ref: String,
    /// The target as JSON, from the recipient the gate checked.
    pub target: String,
    /// The `ResultDoc` as JSON.
    pub body: String,
    pub body_hash: String,
    pub class: ActionClass,
    /// `approved`, `auto` or `grant:<id>`.
    pub mode: String,
    /// `queued`, `holding`, `sending`, `sent`, `undone`, `failed`,
    /// `uncertain`, `stopped`, `frozen` or `waiting_capability`.
    pub state: String,
    /// It goes no earlier.
    pub send_at: Option<i64>,
    pub attempts: i64,
    /// When the engine next acts on it.
    pub next_attempt_at: Option<i64>,
    pub last_error_kind: Option<String>,
    /// What a two-step send left between its steps (a pending review's id).
    pub partial: Option<String>,
    /// What the send left at the service, as JSON.
    pub receipt: Option<String>,
    pub sent_at: Option<i64>,
    pub undo_until: Option<i64>,
    pub undone_at: Option<i64>,
    pub approved_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// An edit of a result before it went out, before it has a number.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewEdit {
    pub item_id: String,
    pub delivery_id: Option<String>,
    pub routine_id: String,
    pub run_id: String,
    pub result_kind: String,
    /// The `ResultDoc`s as JSON.
    pub before: String,
    pub after: String,
    /// The part edits as JSON.
    pub ops: String,
    pub changed: i64,
    pub removed: i64,
    pub added: i64,
    pub moved: i64,
    /// The draft was made from text from outside.
    pub derived_from_untrusted: bool,
    pub at: i64,
}

/// A row of `inbox_edits`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredEdit {
    /// The order it was made in.
    pub id: i64,
    pub edit: NewEdit,
}

/// What became of one result, before it has a number.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewOutcome {
    pub routine_id: String,
    pub run_id: String,
    pub item_id: Option<String>,
    pub delivery_id: Option<String>,
    /// `sent_unedited`, `sent_edited`, `discarded`, `expired`, `replaced`,
    /// `undone`, `wrong`, `auto_sent`, `auto_clean` or `held_flags`.
    pub outcome: String,
    /// The routine's rung when it happened.
    pub rung: String,
    pub at: i64,
}

/// A row of `inbox_outcomes`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredOutcome {
    pub id: i64,
    pub outcome: NewOutcome,
}

/// A row of `inbox_offers`: where a routine stands with offers of more
/// freedom.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredOffer {
    pub routine_id: String,
    /// `none`, `offered`, `declined` or `never`.
    pub state: String,
    /// The open offer's item.
    pub item_id: Option<String>,
    /// The streak's last outcome when it was offered or declined.
    pub streak_at: Option<i64>,
    /// No offer before then.
    pub next_at: Option<i64>,
    pub updated_at: i64,
}

/// The switch that stops every routine on this computer.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StoredHalt {
    pub on: bool,
    /// When it was switched on.
    pub since: Option<i64>,
    /// Who switched it last.
    pub by: Option<String>,
    pub updated_at: i64,
}

/// An item's place in Needs you's order: a page starts after it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemPlace {
    /// `eos_domain::inbox::order_rank` of its state and attention.
    pub rank: i64,
    pub created_at: i64,
    pub id: String,
}

/// Which items a page lists.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemQuery {
    /// Every item that waits when none is named.
    pub state: Option<ItemState>,
    pub routine_id: Option<String>,
    pub after: Option<ItemPlace>,
    pub limit: i64,
}

/// How many items wait in one state, of one kind, for one routine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WaitingCount {
    pub state: ItemState,
    pub kind: ItemKind,
    pub routine_id: Option<String>,
    pub count: i64,
}

pub trait InboxRepo {
    fn insert(&self, item: &StoredItem) -> Result<(), Error>;
    fn find(&self, id: &str) -> Result<Option<StoredItem>, Error>;
    /// Up to `limit` items that wait, open before later, then the loudest,
    /// then the newest.
    fn waiting(&self, limit: i64) -> Result<Vec<StoredItem>, Error>;
    /// Answers the item if it still waits at `rev`: it becomes `answered` and
    /// its rev goes one up. `false`, and nothing written, when it was
    /// answered, closed or changed since.
    fn answer(&self, id: &str, rev: i64, answer: &ItemAnswer) -> Result<bool, Error>;
    /// Writes what may change of an item (state, working, rev, times, answer,
    /// `replaced_by`) if it still waits at `rev`; `false`, and nothing
    /// written, when it ended or changed since.
    fn update_waiting(&self, item: &StoredItem, rev: i64) -> Result<bool, Error>;
    /// Writes a waiting item's title, summary, payload, `rev` and
    /// `updated_at` when its stored `rev` is still `rev`.
    fn retell(&self, item: &StoredItem, rev: i64) -> Result<bool, Error>;
    /// One page in Needs you's order, after `query.after`.
    fn page(&self, query: &ItemQuery) -> Result<Vec<StoredItem>, Error>;
    /// The items that wait, counted by state, kind and routine.
    fn counts(&self) -> Result<Vec<WaitingCount>, Error>;
    /// How many items are open.
    fn open_count(&self) -> Result<i64, Error>;
    /// The items of a routine that wait, oldest first.
    fn waiting_of_routine(&self, routine_id: &str) -> Result<Vec<StoredItem>, Error>;
    /// The items about `subject_key` that wait, oldest first.
    fn waiting_with_subject(&self, subject_key: &str) -> Result<Vec<StoredItem>, Error>;
    /// `producer`'s answered items it has not acted on yet, first answered
    /// first.
    fn unconsumed(&self, producer: &str) -> Result<Vec<StoredItem>, Error>;
    /// Marks an answered item as acted on; `false` when it was already.
    fn consume(&self, id: &str, at: i64) -> Result<bool, Error>;
}

pub trait DeliveryRepo {
    fn insert(&self, delivery: &StoredDelivery) -> Result<(), Error>;
    fn find(&self, id: &str) -> Result<Option<StoredDelivery>, Error>;
    /// Up to `limit` deliveries in `state` whose next attempt is due at
    /// `now`, the longest due first.
    fn due(&self, state: &str, now: i64, limit: i64) -> Result<Vec<StoredDelivery>, Error>;
    /// Writes every field of the row with its id but the ones it was made
    /// with (ids, target, body, class, mode, `created_at`).
    fn update(&self, delivery: &StoredDelivery) -> Result<(), Error>;
    /// The rows in `state`, oldest first.
    fn in_state(&self, state: &str) -> Result<Vec<StoredDelivery>, Error>;
    /// A run's rows, oldest first.
    fn of_run(&self, run_id: &str) -> Result<Vec<StoredDelivery>, Error>;
    /// When the earliest row in `state` is next due; none when no row in it
    /// has a time.
    fn next_due(&self, state: &str) -> Result<Option<i64>, Error>;
}

pub trait EditRepo {
    /// Answers the edit's number.
    fn insert(&self, edit: &NewEdit) -> Result<i64, Error>;
    fn find(&self, id: i64) -> Result<Option<StoredEdit>, Error>;
    /// Up to `limit` edits numbered after `cursor`, oldest first.
    fn since(&self, cursor: i64, limit: i64) -> Result<Vec<StoredEdit>, Error>;
}

pub trait OutcomeRepo {
    fn insert(&self, outcome: &NewOutcome) -> Result<i64, Error>;
    /// A routine's last `limit` outcomes, newest first.
    fn by_routine(&self, routine_id: &str, limit: i64) -> Result<Vec<StoredOutcome>, Error>;
}

pub trait OfferRepo {
    /// Writes a routine's offer in place of the one before.
    fn put(&self, offer: &StoredOffer) -> Result<(), Error>;
    fn find(&self, routine_id: &str) -> Result<Option<StoredOffer>, Error>;
}

pub trait HaltRepo {
    /// The switch; off when it was never used.
    fn get(&self) -> Result<StoredHalt, Error>;
    /// Writes the switch in place of the one before.
    fn put(&self, halt: &StoredHalt) -> Result<(), Error>;
}
