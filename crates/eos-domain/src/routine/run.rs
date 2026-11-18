//! One run: the states it moves through and which moves exist, the station
//! the run view shows, why a run ended or stopped, and its check rounds.
//! Each move is one write job of the engine; this says only which are
//! allowed.

words! {
    pub enum RunState {
        /// Waits for its time, a free slot or the user's go-ahead.
        Queued = "queued",
        Running = "running",
        /// Its result is being checked.
        Checking = "checking",
        /// Its result is held at the gate for the user.
        WaitingForUser = "waiting_for_user",
        Delivering = "delivering",
        Done = "done",
        Skipped = "skipped",
        Cancelled = "cancelled",
        Paused = "paused",
        Failed = "failed",
    }
}

impl RunState {
    /// A run that ended: it never moves again.
    pub fn is_terminal(self) -> bool {
        matches!(self, RunState::Done | RunState::Skipped | RunState::Cancelled | RunState::Failed)
    }

    /// A run in this state says why it got there.
    pub fn takes_reason(self) -> bool {
        matches!(self, RunState::Failed | RunState::Skipped | RunState::Cancelled | RunState::Paused)
    }

    /// Whether a run may move from this state to `next`. Work goes back to
    /// `running` from the check (it failed once, or the user told the team
    /// something), from the gate (revise) and from a delivered milestone of a
    /// project. A result that is shown only, or says there is nothing to
    /// send, is done at the check; a held one is done when the user discards
    /// it or it expires or is replaced. Only a run that has not started is
    /// skipped; a delivery is never cancelled.
    pub fn can_become(self, next: RunState) -> bool {
        use RunState::*;
        match self {
            Queued => matches!(next, Running | Skipped | Cancelled),
            Running => matches!(next, Checking | Paused | Failed | Cancelled),
            Checking => matches!(next, WaitingForUser | Delivering | Done | Running | Paused | Failed | Cancelled),
            WaitingForUser => matches!(next, Delivering | Done | Running | Cancelled),
            Delivering => matches!(next, Done | Running | Failed),
            Paused => matches!(next, Running | Cancelled),
            Done | Skipped | Cancelled | Failed => false,
        }
    }
}

words! {
    /// Where a run is, for the run view.
    pub enum Station {
        Brief = "brief",
        Work = "work",
        Check = "check",
        Gate = "gate",
        Deliver = "deliver",
    }
}

words! {
    /// Why a run failed, was skipped, cancelled or paused.
    pub enum Reason {
        /// The lead ended its turn twice without a result.
        NoResult = "no_result",
        /// The result failed its check twice.
        CheckFailed = "check_failed",
        /// The check itself broke twice.
        CheckError = "check_error",
        Crashed = "crashed",
        /// Eos stopped twice while it ran.
        Interrupted = "interrupted",
        /// It spent its cost budget.
        BudgetRun = "budget_run",
        /// It spent its working time.
        BudgetTime = "budget_time",
        /// A capability it reads with is missing or broken.
        Capability = "capability",
        NoCredential = "no_credential",
        /// Its blueprint does not pass the rules.
        Invalid = "invalid",
        Delivery = "delivery",
        /// A newer run for the same item took its place.
        Superseded = "superseded",
        /// The day's budget is spent.
        DayCap = "day_cap",
        TooLate = "too_late",
        QueueFull = "queue_full",
        User = "user",
        /// The stop switch is on.
        Halted = "halted",
        /// Another Mac runs it.
        Moved = "moved",
        Internal = "internal",
    }
}

/// A run's result is checked at most this many times.
pub const CHECK_ROUNDS_MAX: i64 = 2;

/// After a failed check of round `attempt` (counted from 1): the round the
/// run goes back to work for, or `None` when that was the last and the run
/// fails as `check_failed`.
pub fn next_attempt(attempt: i64) -> Option<i64> {
    (attempt < CHECK_ROUNDS_MAX).then_some(attempt + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn states_stations_and_reasons_are_stored_as_their_words_and_read_back() {
        let states: Vec<&str> = RunState::ALL.iter().map(|state| state.as_str()).collect();
        assert_eq!(
            states,
            [
                "queued",
                "running",
                "checking",
                "waiting_for_user",
                "delivering",
                "done",
                "skipped",
                "cancelled",
                "paused",
                "failed"
            ]
        );
        let stations: Vec<&str> = Station::ALL.iter().map(|station| station.as_str()).collect();
        assert_eq!(stations, ["brief", "work", "check", "gate", "deliver"]);
        let reasons: Vec<&str> = Reason::ALL.iter().map(|reason| reason.as_str()).collect();
        assert_eq!(
            reasons,
            [
                "no_result",
                "check_failed",
                "check_error",
                "crashed",
                "interrupted",
                "budget_run",
                "budget_time",
                "capability",
                "no_credential",
                "invalid",
                "delivery",
                "superseded",
                "day_cap",
                "too_late",
                "queue_full",
                "user",
                "halted",
                "moved",
                "internal"
            ]
        );
        for state in RunState::ALL {
            assert_eq!(RunState::parse(state.as_str()), Some(*state));
        }
        for station in Station::ALL {
            assert_eq!(Station::parse(station.as_str()), Some(*station));
        }
        for reason in Reason::ALL {
            assert_eq!(Reason::parse(reason.as_str()), Some(*reason));
        }
        assert_eq!((RunState::parse("waiting"), Station::parse("start"), Reason::parse("timeout")), (None, None, None));
    }

    #[test]
    fn a_run_moves_only_along_the_allowed_moves() {
        use RunState::*;
        let allowed = [
            (Queued, Running),
            (Queued, Skipped),
            (Queued, Cancelled),
            (Running, Checking),
            (Running, Paused),
            (Running, Failed),
            (Running, Cancelled),
            (Checking, WaitingForUser),
            (Checking, Delivering),
            (Checking, Done),
            (Checking, Running),
            (Checking, Paused),
            (Checking, Failed),
            (Checking, Cancelled),
            (WaitingForUser, Delivering),
            (WaitingForUser, Done),
            (WaitingForUser, Running),
            (WaitingForUser, Cancelled),
            (Delivering, Done),
            (Delivering, Running),
            (Delivering, Failed),
            (Paused, Running),
            (Paused, Cancelled),
        ];
        for from in RunState::ALL {
            for to in RunState::ALL {
                assert_eq!(from.can_become(*to), allowed.contains(&(*from, *to)), "{from:?} → {to:?}");
            }
        }
    }

    #[test]
    fn an_ended_run_never_moves_and_says_why_it_ended_unless_it_is_done() {
        use RunState::*;
        let terminal: Vec<RunState> = RunState::ALL.iter().copied().filter(|state| state.is_terminal()).collect();
        assert_eq!(terminal, [Done, Skipped, Cancelled, Failed]);
        for from in terminal {
            assert!(RunState::ALL.iter().all(|to| !from.can_become(*to)), "{from:?} moved");
        }
        let with_reason: Vec<RunState> = RunState::ALL.iter().copied().filter(|state| state.takes_reason()).collect();
        assert_eq!(with_reason, [Skipped, Cancelled, Paused, Failed]);
    }

    #[test]
    fn a_result_is_checked_twice_at_most() {
        assert_eq!(next_attempt(1), Some(2), "the first failed check sends the run back to work");
        assert_eq!(next_attempt(CHECK_ROUNDS_MAX), None, "the second fails the run");
    }
}
