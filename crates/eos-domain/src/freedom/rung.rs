//! The rung one action of a run's result gets: from its class, the Freedom
//! the user confirmed and the grants its item's facts pass, then held as a
//! draft by any cap.

use eos_contracts::{ActionClass, Facts, Freedom, Rung};

use crate::signals::which::{self, Verdict};

/// A send the user approved that has not gone out after this long waits for
/// the user again.
pub const APPROVED_FRESH_MS: i64 = 60 * 60 * 1000;
/// A send that was to go on its own and has not gone out after this long is
/// held as a draft.
pub const AUTOMATIC_FRESH_MS: i64 = 24 * 60 * 60 * 1000;
/// Nothing goes out without the user until the prompt-injection suite
/// passes: every result is held as a draft at most, whatever its class,
/// Freedom or grants (decisions, risk 1).
pub const AUTOMATIC_RUNGS_LOCKED: bool = true;

/// What holds a result as a draft whatever its rung.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Caps {
    /// An agent in a chat started the run, and a chat can read outside text.
    pub agent_origin: bool,
    /// The target is a place the item names that the blueprint does not
    /// bound, so the item's author would choose who hears it.
    pub unbounded_place: bool,
    /// The outbound check flagged the result.
    pub flagged: bool,
    /// The result's subject changed while it waited (`stale_at`).
    pub stale: bool,
    /// The send was decided earlier and has not gone out yet.
    pub waiting: Option<Waiting>,
    /// The user stopped Eos.
    pub halted: bool,
}

/// Who decided a send that has not gone out yet, and how long ago.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Waiting {
    Approved { for_ms: i64 },
    Automatic { for_ms: i64 },
}

impl Caps {
    pub fn holds(&self) -> bool {
        let too_old = match self.waiting {
            Some(Waiting::Approved { for_ms }) => for_ms > APPROVED_FRESH_MS,
            Some(Waiting::Automatic { for_ms }) => for_ms > AUTOMATIC_FRESH_MS,
            None => false,
        };
        self.agent_origin || self.unbounded_place || self.flagged || self.stale || too_old || self.halted
    }
}

/// The rung of an action of `class` for an item with `item_facts`, under the
/// Freedom the user confirmed. Reading and writing locally leave nothing for
/// the user to hold; telling the user is delivered; speaking takes the
/// routine's rung; an irreversible action is held unless a grant covers it.
/// A grant whose rule the facts pass only ever adds freedom, and a fact the
/// item lacks passes no grant. While [`AUTOMATIC_RUNGS_LOCKED`], at most
/// `Draft`.
pub fn effective_rung(class: ActionClass, freedom: &Freedom, item_facts: &Facts, caps: &Caps) -> Rung {
    let rung = unlocked_rung(class, freedom, item_facts, caps);
    if AUTOMATIC_RUNGS_LOCKED { rung.min(Rung::Draft) } else { rung }
}

/// The rung the rules give with automatic sending unlocked.
fn unlocked_rung(class: ActionClass, freedom: &Freedom, item_facts: &Facts, caps: &Caps) -> Rung {
    let base = match class {
        // The run's tool scope bounds where these reach; they are never results.
        ActionClass::Read | ActionClass::WriteLocal => return Rung::OnItsOwn,
        ActionClass::TellUser => return if caps.holds() { Rung::Draft } else { Rung::OnItsOwn },
        ActionClass::Speak => freedom.rung,
        ActionClass::Irreversible => freedom.rung.min(Rung::Draft),
    };
    let irreversible = class == ActionClass::Irreversible;
    let rung = freedom
        .grants
        .iter()
        .filter(|grant| grant.covers_irreversible || !irreversible)
        .filter(|grant| which::evaluate(&grant.when, item_facts) == Verdict::Pass)
        .map(|grant| grant.rung)
        .fold(base, Ord::max);
    if caps.holds() { rung.min(Rung::Draft) } else { rung }
}

#[cfg(test)]
mod tests;
