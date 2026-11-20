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
//! - The user's answer to a `delivery_problem` sends again, records the send
//!   as made or stops it, and settles the run, in the answering job.
//! - Resume on a routine's alert resumes the routine through its control,
//!   in the answering job; Keep paused leaves it paused. A resume the
//!   control refuses until recipients are confirmed rolls the answer back.
//! - A subject that moved on flags its waiting drafts stale, and one that
//!   closed expires its items ([`Items::subject`]); a stale draft is sent
//!   only on the user's second confirm.
//! - A draft a newer run's draft replaced ends its run as `replaced`.
//! - A send waits out a short hold where its channel cannot take it back,
//!   and can be stopped in it ([`Items::stop_delivery`]); a send that went
//!   out can be taken back in its channel's window ([`Items::undo`]) or
//!   called wrong ([`Items::wrong`]), and a failed one tried again, edited
//!   or not ([`Items::retry`]).
//! - "Stop everything" ([`Items::halt`]) freezes every send that has not
//!   gone out, and the gate and the claim hold everything while it is on;
//!   resuming ([`Items::resume`]) asks the user about each frozen send and
//!   sends nothing by itself.
//! - The sweeper ([`Items::sweep`]) expires items whose time ran out, opens
//!   again the ones put off, and deletes those that ended 90 days ago.
//!
//! - Each send that went out reads the routine's streak again; ten in a
//!   row as Eos made them open one `freedom_offer`, and an accepted offer
//!   raises the routine ([`Items::freedom`] reads where it stands).
//!
//! - [`attention::Notifier`] interrupts sparingly, keeps quiet hours, sends
//!   digests and keeps the Dock badge on the open count.
//!
//! Every write announces `inbox:change` from its job's outbox. Titles,
//! summaries, payloads and answers are the user's: only ids, kinds, states
//! and counts are logged.

mod alerts;
mod answer;
pub mod attention;
mod control;
pub mod delivery;
mod edits;
pub mod gate;
mod halt;
mod handoff;
mod items;
mod offers;
mod outcomes;
mod problems;
mod questions;
mod routing;
mod send;
mod stale;
mod sweep;

use eos_contracts::InboxChange;
use eos_core::store::{Outbox, StoredItem, Tx};
use eos_domain::inbox::ItemState;

pub use answer::{Items, ItemsParts};
pub use edits::Edits;
pub use halt::HALTED;
pub use handoff::consume_in;
pub use items::{
    NewItem, Opening, ROUTINE_CAP, TOO_MANY_WAITING, notice_in, open_in, withdraw_routine_in, withdraw_run_start_in,
};
pub use offers::INBOX_FREEDOM;
pub use questions::{QuestionWaiters, RunQuestionParts, RunQuestions, WITHDRAWN};
pub use routing::RunAsks;
pub use stale::SUBJECT_CLOSED;

/// The topic every write of an item announces.
pub const INBOX_CHANGE: &str = "inbox:change";
/// The topic every move of a delivery announces.
pub const INBOX_DELIVERY: &str = "inbox:delivery";
/// The topic the halt switch announces.
pub const INBOX_HALT: &str = "inbox:halt";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The item ended before this write: answered, replaced, expired or
    /// withdrawn.
    #[error("already answered")]
    AlreadyAnswered { state: ItemState, answered_by: Option<String> },
    /// The item changed since the rev the write was made on.
    #[error("changed")]
    Changed { rev: i64 },
    /// The draft's subject moved on since it was made, and the send did not
    /// confirm sending it anyway.
    #[error("stale")]
    Stale { reason: String },
    /// The send cannot be taken back: it is not out, its window passed or
    /// its channel has no undo.
    #[error("cannot_undo")]
    CannotUndo,
    /// Resume on a routine's alert, while its head names recipients the
    /// user has not confirmed (D53); nothing was written.
    #[error("recipients_unconfirmed")]
    RecipientsUnconfirmed(eos_core::routine::ResumeRefusal),
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
