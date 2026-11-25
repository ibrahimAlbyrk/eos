//! A routine's run limits. Past either one a signal is decided `over-limit`:
//! kept and run again by hand, never lost. Also the limits of the folders a
//! routine watches, which its save and its folder source both check.

use eos_contracts::Limits;

/// The most entries a watched folder may hold.
pub const FOLDER_ENTRIES_MAX: usize = 5_000;
/// The most folders watched at once.
pub const FOLDERS_MAX: usize = 20;

/// A routine's runs as the limits count them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Load {
    /// Runs admitted in the hour before now.
    pub admitted_last_hour: i64,
    /// Runs admitted that have not started.
    pub queued: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admit {
    Run,
    OverLimit,
}

/// Whether one more run fits: fewer than `perHour` admitted in the last hour,
/// and fewer than `queued` waiting.
pub fn admit_check(load: Load, limits: &Limits) -> Admit {
    if load.admitted_last_hour >= limits.per_hour || load.queued >= limits.queued {
        Admit::OverLimit
    } else {
        Admit::Run
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_fits_below_both_limits_only() {
        let limits = Limits::default();
        let load = |admitted_last_hour, queued| Load { admitted_last_hour, queued };
        assert_eq!(admit_check(load(0, 0), &limits), Admit::Run);
        assert_eq!(admit_check(load(29, 24), &limits), Admit::Run);
        assert_eq!(admit_check(load(30, 0), &limits), Admit::OverLimit);
        assert_eq!(admit_check(load(0, 25), &limits), Admit::OverLimit);
        let tight = Limits { per_hour: 1, queued: 1, ..Limits::default() };
        assert_eq!(admit_check(load(1, 0), &tight), Admit::OverLimit);
    }
}
