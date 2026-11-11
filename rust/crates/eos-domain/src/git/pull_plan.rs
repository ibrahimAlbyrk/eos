//! What a pull should do. Only a fast-forward ever runs; a diverged branch is
//! reported, never merged on its own.

use eos_contracts::PullOutcome;

/// Where the current branch stands against its upstream.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PullState {
    /// `None` on a detached HEAD.
    pub branch: Option<String>,
    pub has_upstream: bool,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PullPlan {
    FastForward,
    UpToDate,
    Diverged { ahead: u32, behind: u32 },
    Detached,
    NoUpstream,
}

/// How a pull that ran ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PullExecReason {
    Pulled,
    /// Local changes block the fast-forward.
    Conflict,
    /// The remote moved since the last fetch.
    Unrelated,
    Failed,
}

pub fn decide_pull_plan(s: &PullState) -> PullPlan {
    if s.branch.as_deref().is_none_or(str::is_empty) {
        PullPlan::Detached
    } else if !s.has_upstream {
        PullPlan::NoUpstream
    } else if s.behind == 0 {
        PullPlan::UpToDate
    } else if s.ahead == 0 {
        PullPlan::FastForward
    } else {
        PullPlan::Diverged { ahead: s.ahead, behind: s.behind }
    }
}

/// What the user is told about a pull.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullSummary {
    pub outcome: PullOutcome,
    pub ok: bool,
    pub message: &'static str,
}

/// `reason` is how the command ended; plans that run nothing ignore it.
pub fn summarize_pull_result(plan: PullPlan, reason: Option<PullExecReason>) -> PullSummary {
    let (outcome, ok, message) = match (plan, reason) {
        (PullPlan::Detached, _) => (PullOutcome::Detached, false, "Detached HEAD — check out a branch to pull."),
        (PullPlan::NoUpstream, _) => (PullOutcome::NoUpstream, false, "No upstream configured — nothing to pull from."),
        (PullPlan::UpToDate, _) => (PullOutcome::UpToDate, true, "Already up to date."),
        (PullPlan::Diverged { .. }, _) => (
            PullOutcome::Diverged,
            false,
            "Branch diverged — pull can't fast-forward. Use Sync with remote to merge or rebase.",
        ),
        (PullPlan::FastForward, Some(PullExecReason::Pulled)) => (PullOutcome::Pulled, true, "Pulled (fast-forward)."),
        (PullPlan::FastForward, Some(PullExecReason::Conflict)) => {
            (PullOutcome::Conflict, false, "Local changes would be overwritten — commit or stash first.")
        }
        (PullPlan::FastForward, Some(PullExecReason::Unrelated)) => {
            (PullOutcome::Diverged, false, "Pull can't fast-forward — remote moved since last fetch.")
        }
        (PullPlan::FastForward, _) => (PullOutcome::Failed, false, "Pull failed."),
    };
    PullSummary { outcome, ok, message }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(branch: Option<&str>, has_upstream: bool, ahead: u32, behind: u32) -> PullState {
        PullState { branch: branch.map(str::to_owned), has_upstream, ahead, behind }
    }

    #[test]
    fn decides_from_upstream_ahead_and_behind() {
        assert_eq!(decide_pull_plan(&state(None, true, 0, 2)), PullPlan::Detached);
        assert_eq!(decide_pull_plan(&state(Some("f"), false, 0, 0)), PullPlan::NoUpstream);
        assert_eq!(decide_pull_plan(&state(Some("f"), true, 0, 3)), PullPlan::FastForward);
        assert_eq!(decide_pull_plan(&state(Some("f"), true, 2, 3)), PullPlan::Diverged { ahead: 2, behind: 3 });
        assert_eq!(decide_pull_plan(&state(Some("f"), true, 0, 0)), PullPlan::UpToDate);
        assert_eq!(decide_pull_plan(&state(Some("f"), true, 4, 0)), PullPlan::UpToDate);
    }

    #[test]
    fn summarizes_each_ending() {
        let outcome = |plan, reason| summarize_pull_result(plan, reason).outcome;
        let pulled = summarize_pull_result(PullPlan::FastForward, Some(PullExecReason::Pulled));
        assert!(pulled.ok && pulled.outcome == PullOutcome::Pulled);
        assert_eq!(outcome(PullPlan::FastForward, Some(PullExecReason::Conflict)), PullOutcome::Conflict);
        assert_eq!(outcome(PullPlan::FastForward, Some(PullExecReason::Unrelated)), PullOutcome::Diverged);
        assert_eq!(outcome(PullPlan::FastForward, Some(PullExecReason::Failed)), PullOutcome::Failed);
        assert_eq!(outcome(PullPlan::Diverged { ahead: 1, behind: 1 }, None), PullOutcome::Diverged);
        assert_eq!(outcome(PullPlan::UpToDate, None), PullOutcome::UpToDate);
        assert_eq!(outcome(PullPlan::Detached, None), PullOutcome::Detached);
        assert_eq!(outcome(PullPlan::NoUpstream, None), PullOutcome::NoUpstream);
    }
}
