//! The limits a routine's runs keep: how near spend or working time is to
//! its cap, the failures and the spend that pause a routine, the day spend is
//! booked on, and what counts as working time. The caps are arguments: the
//! blueprint and the settings hold them.

use super::numbers::median;
use super::run::RunState;
use crate::time::civil_from_days;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// How near spend or working time is to its cap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Budget {
    /// Below 90 %.
    Within,
    /// From 90 %: a run is told to wrap up; the overall day sends a notice.
    WrapUp,
    /// At 100 %: a run stops; a day takes no new runs.
    Reached,
}

/// Where `used` stands against `cap`: a run's cost or working time, a
/// routine's or everything's spend today.
pub fn budget(used: f64, cap: f64) -> Budget {
    if used >= cap {
        Budget::Reached
    } else if used * 10.0 >= cap * 9.0 {
        Budget::WrapUp
    } else {
        Budget::Within
    }
}

/// The cost cap a new blueprint's run gets: `times` its estimate, at least
/// `at_least_usd`.
pub fn per_run_usd(estimate_usd: f64, times: f64, at_least_usd: f64) -> f64 {
    (estimate_usd * times).max(at_least_usd)
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

/// How many earlier runs abnormal spend is measured against.
const SPEND_RUNS: usize = 10;

/// Whether a run's cost pauses its routine with reason `spend`: above three
/// times the median of the routine's last ten runs before it (`earlier_usd`,
/// newest first) and above $1. A routine without earlier runs has nothing to
/// measure against.
pub fn abnormal_spend(cost_usd: f64, earlier_usd: &[f64]) -> bool {
    let usual = median(earlier_usd.iter().take(SPEND_RUNS).copied());
    usual.is_some_and(|usual| cost_usd > 3.0 * usual && cost_usd > 1.0)
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
    fn spend_and_time_wrap_up_at_ninety_percent_and_stop_at_the_cap() {
        for cap in [5.0, 20.0, 1_800_000.0] {
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
    fn a_run_may_spend_a_multiple_of_its_estimate_and_never_less_than_the_floor() {
        assert!((per_run_usd(0.8, 3.0, 1.0) - 2.4).abs() < 1e-9);
        assert_eq!(per_run_usd(0.2, 3.0, 1.0), 1.0);
        assert_eq!(per_run_usd(0.0, 3.0, 1.0), 1.0);
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
    fn spend_is_abnormal_above_three_times_the_median_and_above_a_dollar() {
        let usual = [0.5, 0.4, 0.6, 0.5, 0.5, 0.45, 0.55, 0.5, 0.5, 0.5];
        assert!(abnormal_spend(1.51, &usual));
        assert!(!abnormal_spend(1.5, &usual), "three times the median is not above it");
        let cheap = [0.1; 10];
        assert!(!abnormal_spend(0.9, &cheap), "nine times the median, but under a dollar");
        assert!(abnormal_spend(1.01, &cheap));
        assert!(!abnormal_spend(50.0, &[]), "a first run has nothing to compare with");
        // Only the last ten count: the expensive eleventh-newest run does not lift the median.
        let mut older = vec![0.5; 10];
        older.extend([100.0; 5]);
        assert!(abnormal_spend(2.0, &older));
        assert!(!abnormal_spend(2.0, &[0.5, 0.5, 1.0, 1.0]), "the median of an even count is the middle two's mean");
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
