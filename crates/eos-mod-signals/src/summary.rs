//! What signals did, counted for the user over a window that ends now
//! (02 §3 I.45): handled, waiting, ignored, held back, failed, and the
//! schedule slots missed and fired late. A routine's page and the summary
//! count the same way.

use eos_contracts::SignalCounts;
use eos_core::Error;
use eos_core::os::TimeZone;
use eos_core::store::{SignalTally, Tx};
use eos_domain::routine::run::RunState;
use eos_domain::signals::decision::Decision;
use eos_domain::time::{instant_of, wall_clock};

use crate::scheduler::LATE_MS;

pub(crate) const DAY_MS: i64 = 24 * 60 * 60_000;

/// When the user's day began.
pub(crate) fn day_start(zone: &dyn TimeZone, now: i64) -> i64 {
    let offset_at = |at: i64| zone.offset_minutes_at(at);
    let wall = wall_clock(now, &offset_at);
    instant_of(wall - wall.rem_euclid(DAY_MS), &offset_at)
}

/// The routine's signals decided since `since`, with the slots its
/// schedules missed and fired late.
pub(crate) fn counts_in(tx: &dyn Tx, routine_id: &str, since: i64) -> Result<SignalCounts, Error> {
    let slots = tx.signal_routes().slots(routine_id, since, LATE_MS)?;
    let counts = SignalCounts { missed: slots.missed, late: slots.late, ..SignalCounts::default() };
    Ok(tx.signal_routes().tally(routine_id, since)?.iter().fold(counts, add))
}

/// Two windows' counts together.
pub(crate) fn sum(a: SignalCounts, b: SignalCounts) -> SignalCounts {
    SignalCounts {
        handled: a.handled + b.handled,
        waiting: a.waiting + b.waiting,
        ignored: a.ignored + b.ignored,
        held_back: a.held_back + b.held_back,
        failed: a.failed + b.failed,
        missed: a.missed + b.missed,
        late: a.late + b.late,
    }
}

fn add(mut counts: SignalCounts, tally: &SignalTally) -> SignalCounts {
    let n = tally.signals;
    match tally.decision {
        Decision::Unmatched => counts.ignored += n,
        Decision::OverLimit | Decision::Undecided | Decision::Unsorted | Decision::Paused | Decision::HeldDev => {
            counts.held_back += n
        }
        _ => match tally.run_state {
            Some(RunState::WaitingForUser) => {
                counts.handled += n;
                counts.waiting += n;
            }
            Some(RunState::Delivering | RunState::Done) => counts.handled += n,
            Some(RunState::Failed) => counts.failed += n,
            _ => {}
        },
    }
    counts
}
