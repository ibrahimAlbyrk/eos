//! How strong a note is and which state it is in, from its counters.

use super::note::{NoteState, Trust};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// Helped this often, at this strength, a trying note is firm.
const FIRM_HELPED: i64 = 3;
const FIRM_STRENGTH: f64 = 0.75;
/// Unused this long, a note cools until it is used again.
const COOL_AFTER_MS: i64 = 30 * DAY_MS;
/// Below this strength, hurt at least twice, a note closes.
const CLOSE_STRENGTH: f64 = 0.25;
const CLOSE_HURT: i64 = 2;
/// Activation counts this many newest uses, each halving every 14 days.
pub const ACTIVATION_USES: usize = 20;
const ACTIVATION_HALF_LIFE_DAYS: f64 = 14.0;

/// A note's counters, summed over every Mac.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Counters {
    pub helped: i64,
    pub hurt: i64,
    pub used: i64,
    pub last_used_at: Option<i64>,
}

/// `(helped + 1) / (helped + hurt + 2)`, capped by the note's trust.
pub fn strength(trust: Trust, helped: i64, hurt: i64) -> f64 {
    let raw = (helped + 1) as f64 / (helped + hurt + 2) as f64;
    raw.min(trust.cap())
}

/// The state a new note starts in: what the user said is firm at once.
pub fn initial(trust: Trust) -> NoteState {
    if trust == Trust::Said { NoteState::Firm } else { NoteState::Trying }
}

/// The state a note moves to at `now`, from `current`. Closed stays closed;
/// `created_at` stands in for the last use of a note never used.
pub fn next(current: NoteState, trust: Trust, counters: Counters, created_at: i64, now: i64) -> NoteState {
    if current == NoteState::Closed {
        return NoteState::Closed;
    }
    let strength = strength(trust, counters.helped, counters.hurt);
    if strength < CLOSE_STRENGTH && counters.hurt >= CLOSE_HURT {
        return NoteState::Closed;
    }
    let last = counters.last_used_at.unwrap_or(created_at);
    if now - last >= COOL_AFTER_MS {
        return NoteState::Cooling;
    }
    let earned = counters.helped >= FIRM_HELPED && strength >= FIRM_STRENGTH;
    match current {
        NoteState::Trying if earned => NoteState::Firm,
        NoteState::Cooling if earned || trust == Trust::Said => NoteState::Firm,
        NoteState::Cooling => NoteState::Trying,
        other => other,
    }
}

/// `min(1, Σ 0.5^(age_days / 14) / 3)` over the newest uses (`use_times`,
/// any order; only the newest [`ACTIVATION_USES`] count).
pub fn activation(use_times: &[i64], now: i64) -> f64 {
    let mut newest: Vec<i64> = use_times.to_vec();
    newest.sort_unstable_by(|a, b| b.cmp(a));
    newest.truncate(ACTIVATION_USES);
    let sum: f64 = newest
        .iter()
        .map(|at| {
            let age_days = (now - at).max(0) as f64 / DAY_MS as f64;
            0.5f64.powf(age_days / ACTIVATION_HALF_LIFE_DAYS)
        })
        .sum();
    (sum / 3.0).min(1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strength_is_laplace_and_capped_by_trust() {
        assert_eq!(strength(Trust::Said, 0, 0), 0.5);
        assert_eq!(strength(Trust::Said, 8, 0), 0.9);
        assert_eq!(strength(Trust::Guess, 8, 0), 0.6);
        assert_eq!(strength(Trust::Outcome, 98, 0), 0.8);
    }

    #[test]
    fn said_starts_firm_and_the_rest_try() {
        assert_eq!(initial(Trust::Said), NoteState::Firm);
        for trust in [Trust::Did, Trust::Outcome, Trust::Guess] {
            assert_eq!(initial(trust), NoteState::Trying);
        }
    }

    #[test]
    fn a_trying_note_firms_up_after_three_helps() {
        let used = |helped, hurt| Counters { helped, hurt, used: helped, last_used_at: Some(1_000) };
        assert_eq!(next(NoteState::Trying, Trust::Did, used(2, 0), 0, 2_000), NoteState::Trying);
        assert_eq!(next(NoteState::Trying, Trust::Did, used(3, 0), 0, 2_000), NoteState::Firm);
        assert_eq!(next(NoteState::Trying, Trust::Did, used(3, 1), 0, 2_000), NoteState::Trying, "strength 0.67");
        assert_eq!(next(NoteState::Trying, Trust::Guess, used(9, 0), 0, 2_000), NoteState::Trying, "capped at 0.6");
    }

    #[test]
    fn unused_notes_cool_and_come_back_on_use() {
        let quiet = Counters { last_used_at: Some(0), ..Counters::default() };
        assert_eq!(next(NoteState::Firm, Trust::Said, quiet, 0, COOL_AFTER_MS), NoteState::Cooling);
        assert_eq!(next(NoteState::Trying, Trust::Did, Counters::default(), 0, COOL_AFTER_MS), NoteState::Cooling);
        let fresh = Counters { last_used_at: Some(COOL_AFTER_MS), ..Counters::default() };
        assert_eq!(next(NoteState::Cooling, Trust::Said, fresh, 0, COOL_AFTER_MS + 1), NoteState::Firm);
        assert_eq!(next(NoteState::Cooling, Trust::Did, fresh, 0, COOL_AFTER_MS + 1), NoteState::Trying);
    }

    #[test]
    fn a_note_that_hurts_closes_for_good() {
        let bad = Counters { helped: 0, hurt: 3, used: 3, last_used_at: Some(0) };
        assert_eq!(next(NoteState::Firm, Trust::Did, bad, 0, 1), NoteState::Closed);
        let edge = Counters { hurt: 2, ..bad };
        assert_ne!(next(NoteState::Firm, Trust::Did, edge, 0, 1), NoteState::Closed, "strength 0.25 is not below");
        assert_eq!(next(NoteState::Closed, Trust::Said, Counters::default(), 0, 1), NoteState::Closed);
    }

    #[test]
    fn activation_decays_with_age_and_saturates() {
        assert_eq!(activation(&[], 0), 0.0);
        assert!((activation(&[0, 0, 0], 0) - 1.0).abs() < 1e-9);
        let two_weeks = 14 * DAY_MS;
        assert!((activation(&[0], two_weeks) - 0.5 / 3.0).abs() < 1e-9);
        assert_eq!(activation(&[0; 30], 0), 1.0);
        let now = 5 * two_weeks;
        let old = vec![0; ACTIVATION_USES];
        let mut mixed = old.clone();
        mixed.push(now);
        assert!(activation(&mixed, now) > activation(&old, now), "the newest use counts first");
    }
}
