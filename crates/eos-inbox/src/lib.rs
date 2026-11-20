//! Needs you: the things that wait for the user (`inbox_items`).
//!
//! - A producer (a routine's run, the signals' router, the architect) opens
//!   an item inside its own write job with [`open_in`], so the item and what
//!   made it commit together. A newer item about the same subject takes the
//!   place of an older one; a routine with more than [`ROUTINE_CAP`] items
//!   waiting is paused, with one alert.
//! - The user answers, puts aside, discards or edits an item through
//!   [`Items`]. Every write names the rev it was made on, so of two answers
//!   from the Mac and the phone only the first lands.
//! - An answer reaches its producer through the handoff: the producer lists
//!   its answered items it has not acted on ([`Items::unconsumed`]) at start
//!   and on `inbox:change`, and marks each one in its own write job with
//!   [`consume_in`]. At least once, keyed by the item's id.
//! - A deleted routine's waiting items are withdrawn ([`withdraw_routine_in`]).
//! - A routine run's permission asks show in Needs you instead of on the
//!   banner ([`RunAsks`], the gateway's routing).
//!
//! - A run worker's questions wait as `question` items ([`RunQuestions`]);
//!   every other worker asks as it always did.
//! - A run's checked result passes the [`gate`]: shown, refused, held as a
//!   `draft` item, or queued as deliveries ([`delivery`]).
//! - The user sends a held draft ([`Items::send`]): its deliveries, what the
//!   user changed ([`Edits`]) and what became of the result
//!   (`inbox_outcomes`) are written in the answering job.
//!
//! Every write announces `inbox:change` from its job's outbox. Titles,
//! summaries, payloads and answers are the user's: only ids, kinds, states
//! and counts are logged.

mod answer;
mod control;
pub mod delivery;
mod edits;
pub mod gate;
mod handoff;
mod items;
mod outcomes;
mod questions;
mod routing;
mod send;

use eos_contracts::InboxChange;
use eos_core::store::{Outbox, StoredItem, Tx};
use eos_domain::inbox::ItemState;

pub use answer::{Items, ItemsParts};
pub use edits::Edits;
pub use handoff::consume_in;
pub use items::{NewItem, Opening, ROUTINE_CAP, TOO_MANY_WAITING, notice_in, open_in, withdraw_routine_in};
pub use questions::{QuestionWaiters, RunQuestionParts, RunQuestions};
pub use routing::RunAsks;

/// The topic every write of an item announces.
pub const INBOX_CHANGE: &str = "inbox:change";
/// The topic every move of a delivery announces.
pub const INBOX_DELIVERY: &str = "inbox:delivery";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The item ended before this write: answered, replaced, expired or
    /// withdrawn.
    #[error("already answered")]
    AlreadyAnswered { state: ItemState, answered_by: Option<String> },
    /// The item changed since the rev the write was made on.
    #[error("changed")]
    Changed { rev: i64 },
    #[error(transparent)]
    Core(#[from] eos_core::Error),
}

/// Announces an item as it is now, with how many items are open.
fn announce(tx: &dyn Tx, out: &mut Outbox, item: &StoredItem) -> Result<(), eos_core::Error> {
    let change = InboxChange {
        id: item.id.clone(),
        kind: item.kind.as_str().to_owned(),
        state: item.state.as_str().to_owned(),
        routine_id: item.routine_id.clone(),
        rev: item.rev,
        open: tx.inbox_items().open_count()?,
    };
    out.push(INBOX_CHANGE, &change);
    Ok(())
}
