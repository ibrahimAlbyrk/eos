//! The limits a routine's runs keep: how near working time is to its cap,
//! the failures that pause a routine, the day spend is booked on, and what
//! counts as working time. Spend has no cap.

use serde_json::{Value, json};

use super::run::RunState;
use crate::time::civil_from_days;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// How near working time is to its cap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Budget {
    /// Below 90 %.
    Within,
    /// From 90 %: a run is told to wrap up.
    WrapUp,
    /// At 100 %: a run stops.
    Reached,
}

/// Where a run's working time `used` stands against its `cap`.
pub fn budget(used: f64, cap: f64) -> Budget {
    if used >= cap {
        Budget::Reached
    } else if used * 10.0 >= cap * 9.0 {
        Budget::WrapUp
    } else {
        Budget::Within
    }
}

/// How long a run of a routine made without them may work, and how many
/// of its runs go at once (D6).
pub const PER_RUN_MINUTES: i64 = 30;
pub const PARALLEL: i64 = 1;

/// Fills in the limits a received blueprint leaves out.
pub fn fill_defaults(blueprint: &mut Value) {
    let Some(fields) = blueprint.as_object_mut() else { return };
    let limits = fields.entry("limits").or_insert_with(|| json!({}));
    let Some(limits) = limits.as_object_mut() else { return };
    limits.entry("perRunMinutes").or_insert(json!(PER_RUN_MINUTES));
    limits.entry("parallel").or_insert(json!(PARALLEL));
}

/// Failed runs in a row at which a routine pauses (`failures`).
pub const FAILURES_TO_PAUSE: i64 = 3;

/// A routine's failed runs in a row after one ended in `ended`: one more
/// after a failure, none after a success, as they were otherwise.
pub fn failure_streak(streak: i64, ended: RunState) -> i64 {
    match ended {
        RunState::Failed => streak + 1,
        RunState::Done => 0,
        _ => streak,
    }
}

/// Whether a streak pauses the routine with reason `failures`.
pub fn pauses_for_failures(streak: i64) -> bool {
    streak >= FAILURES_TO_PAUSE
}

/// The day spend at `at` is booked on, `YYYY-MM-DD`: the day the user's
/// clock shows then, `offset_minutes` east of UTC at that moment. A zone
/// change counts from the next spend.
pub fn day_key(at: i64, offset_minutes: i32) -> String {
    let wall = at + i64::from(offset_minutes) * 60_000;
    let (year, month, day) = civil_from_days(wall.div_euclid(DAY_MS));
    format!("{year:04}-{month:02}-{day:02}")
}

/// The part of `elapsed_ms` spent in `state` that a run's working time
/// counts: time running or checking, while no question waits for the user.
pub fn work_ms(state: RunState, needs_user: bool, elapsed_ms: i64) -> i64 {
    let working = matches!(state, RunState::Running | RunState::Checking) && !needs_user;
    if working { elapsed_ms } else { 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_wraps_up_at_ninety_percent_and_stops_at_the_cap() {
        for cap in [60_000.0, 600_000.0, 1_800_000.0] {
            assert_eq!(budget(cap * 0.89, cap), Budget::Within, "{cap}");
            assert_eq!(budget(cap * 0.9, cap), Budget::WrapUp, "{cap}");
            assert_eq!(budget(cap * 0.99, cap), Budget::WrapUp, "{cap}");
            assert_eq!(budget(cap, cap), Budget::Reached, "{cap}");
            assert_eq!(budget(cap * 1.5, cap), Budget::Reached, "{cap}");
        }
        assert_eq!(budget(1_619_999.0, 1_800_000.0), Budget::Within, "a millisecond before 27 of 30 minutes");
        assert_eq!(budget(1_620_000.0, 1_800_000.0), Budget::WrapUp);
    }

    #[test]
    fn a_blueprint_without_limits_gets_time_and_parallel_defaults() {
        let mut none = json!({"format": 1});
        fill_defaults(&mut none);
        assert_eq!(none["limits"], json!({"perRunMinutes": 30, "parallel": 1}));
        let mut some = json!({"limits": {"parallel": 3}});
        fill_defaults(&mut some);
        assert_eq!(some["limits"], json!({"parallel": 3, "perRunMinutes": 30}));
        let mut text = json!("not a blueprint");
        fill_defaults(&mut text);
        assert_eq!(text, json!("not a blueprint"));
    }

    #[test]
    fn three_failures_in_a_row_pause_and_a_success_starts_the_count_again() {
        let mut streak = 0;
        let mut paused = Vec::new();
        for ended in [RunState::Failed, RunState::Failed, RunState::Done, RunState::Failed, RunState::Failed] {
            streak = failure_streak(streak, ended);
            paused.push(pauses_for_failures(streak));
        }
        assert_eq!(streak, 2);
        assert_eq!(paused, [false, false, false, false, false]);
        for ended in [RunState::Skipped, RunState::Cancelled] {
            assert_eq!(failure_streak(2, ended), 2, "{ended:?} neither counts nor resets");
        }
        let third = failure_streak(streak, RunState::Failed);
        assert_eq!((third, pauses_for_failures(third)), (3, true));
    }

    #[test]
    fn spend_is_booked_on_the_users_local_day_at_the_moment_of_spend() {
        // 2026-11-18 21:30 UTC.
        let at = 1_795_037_400_000;
        assert_eq!(day_key(at, 0), "2026-11-18");
        assert_eq!(day_key(at, 180), "2026-11-19", "already past midnight in Istanbul");
        assert_eq!(day_key(at, -300), "2026-11-18", "afternoon in New York");
        // The last millisecond before local midnight, and midnight itself.
        let midnight_istanbul = 1_795_035_600_000;
        assert_eq!(day_key(midnight_istanbul - 1, 180), "2026-11-18");
        assert_eq!(day_key(midnight_istanbul, 180), "2026-11-19");
        // A zone change between two spends: each is booked by the offset in force when it happened.
        assert_eq!(day_key(midnight_istanbul + 60_000, 180), "2026-11-19");
        assert_eq!(day_key(midnight_istanbul + 120_000, -300), "2026-11-18", "after a flight west");
        assert_eq!(day_key(0, -60), "1969-12-31");
    }

    #[test]
    fn working_time_counts_only_running_and_checking_without_an_open_question() {
        for state in RunState::ALL {
            let counted = matches!(state, RunState::Running | RunState::Checking);
            assert_eq!(work_ms(*state, false, 1_000), if counted { 1_000 } else { 0 }, "{state:?}");
            assert_eq!(work_ms(*state, true, 1_000), 0, "{state:?} while the user is asked");
        }
    }
}
