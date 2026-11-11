//! What a push should do, decided from where the branch stands. The command
//! itself is run by the `BranchPush` port; nothing here touches git.

use eos_contracts::PushOutcome;

/// Where the current branch stands against its remote.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PushState {
    /// `None` on a detached HEAD.
    pub branch: Option<String>,
    /// `None` when no remote is configured.
    pub remote: Option<String>,
    pub has_upstream: bool,
    /// Commits here that the upstream lacks.
    pub ahead: u32,
    /// Commits on the upstream that are not here.
    pub behind: u32,
}

/// A push git should run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushTarget {
    pub kind: PushKind,
    pub remote: String,
    pub branch: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushKind {
    SetUpstream,
    FastForward,
    ForceWithLease,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PushPlan {
    Push(PushTarget),
    UpToDate,
    /// Only behind: pushing would need a force, so the answer is "pull first".
    BehindOnly,
    Detached,
    NoRemote,
}

/// How a push that ran ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushExecReason {
    Pushed,
    Rejected,
    LeaseStale,
    Auth,
    Failed,
}

pub fn decide_push_plan(s: &PushState) -> PushPlan {
    let Some(branch) = s.branch.clone().filter(|b| !b.is_empty()) else { return PushPlan::Detached };
    let Some(remote) = s.remote.clone().filter(|r| !r.is_empty()) else { return PushPlan::NoRemote };
    let push = |kind| PushPlan::Push(PushTarget { kind, remote: remote.clone(), branch: branch.clone() });
    if !s.has_upstream {
        push(PushKind::SetUpstream)
    } else if s.ahead > 0 && s.behind == 0 {
        push(PushKind::FastForward)
    } else if s.ahead > 0 {
        push(PushKind::ForceWithLease)
    } else if s.behind > 0 {
        PushPlan::BehindOnly
    } else {
        PushPlan::UpToDate
    }
}

/// What the user is told about a push.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushSummary {
    pub outcome: PushOutcome,
    pub ok: bool,
    pub message: &'static str,
}

/// `reason` is how the command ended; plans that run nothing ignore it.
pub fn summarize_push_result(plan: &PushPlan, reason: Option<PushExecReason>) -> PushSummary {
    let (outcome, ok, message) = match (plan, reason) {
        (PushPlan::Detached, _) => (PushOutcome::Detached, false, "Detached HEAD — check out a branch to push."),
        (PushPlan::NoRemote, _) => (PushOutcome::NoRemote, false, "No remote configured."),
        (PushPlan::UpToDate, _) => (PushOutcome::UpToDate, true, "Already up to date."),
        (PushPlan::BehindOnly, _) => {
            (PushOutcome::BehindOnly, false, "Nothing to push — branch is behind. Pull first.")
        }
        (PushPlan::Push(target), Some(PushExecReason::Pushed)) => match target.kind {
            PushKind::SetUpstream => (PushOutcome::PushedNew, true, "Pushed and set upstream."),
            PushKind::ForceWithLease => (PushOutcome::PushedForce, true, "Force-pushed (with lease)."),
            PushKind::FastForward => (PushOutcome::Pushed, true, "Pushed."),
        },
        (PushPlan::Push(_), Some(PushExecReason::Rejected)) => {
            (PushOutcome::Rejected, false, "Push rejected — remote moved. Pull/rebase first.")
        }
        (PushPlan::Push(_), Some(PushExecReason::LeaseStale)) => {
            (PushOutcome::LeaseStale, false, "Force-push rejected — remote moved since last fetch.")
        }
        (PushPlan::Push(_), Some(PushExecReason::Auth)) => (PushOutcome::Auth, false, "Authentication failed."),
        (PushPlan::Push(_), _) => (PushOutcome::Failed, false, "Push failed."),
    };
    PushSummary { outcome, ok, message }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(branch: Option<&str>, remote: Option<&str>, has_upstream: bool, ahead: u32, behind: u32) -> PushState {
        PushState { branch: branch.map(str::to_owned), remote: remote.map(str::to_owned), has_upstream, ahead, behind }
    }

    fn kind(plan: &PushPlan) -> Option<PushKind> {
        match plan {
            PushPlan::Push(target) => Some(target.kind),
            _ => None,
        }
    }

    #[test]
    fn blocks_without_a_branch_or_a_remote() {
        assert_eq!(decide_push_plan(&state(None, Some("origin"), true, 1, 0)), PushPlan::Detached);
        assert_eq!(decide_push_plan(&state(Some("f"), None, false, 0, 0)), PushPlan::NoRemote);
    }

    #[test]
    fn picks_the_push_from_ahead_and_behind() {
        let plan = decide_push_plan(&state(Some("f"), Some("origin"), false, 0, 0));
        assert_eq!(
            plan,
            PushPlan::Push(PushTarget { kind: PushKind::SetUpstream, remote: "origin".into(), branch: "f".into() })
        );
        assert_eq!(kind(&decide_push_plan(&state(Some("f"), Some("o"), true, 3, 0))), Some(PushKind::FastForward));
        assert_eq!(kind(&decide_push_plan(&state(Some("f"), Some("o"), true, 2, 5))), Some(PushKind::ForceWithLease));
        // Never a force when only behind.
        assert_eq!(decide_push_plan(&state(Some("f"), Some("o"), true, 0, 4)), PushPlan::BehindOnly);
        assert_eq!(decide_push_plan(&state(Some("f"), Some("o"), true, 0, 0)), PushPlan::UpToDate);
    }

    #[test]
    fn summarizes_each_ending() {
        let push = |kind| PushPlan::Push(PushTarget { kind, remote: "o".into(), branch: "f".into() });
        let outcome = |plan: &PushPlan, reason| summarize_push_result(plan, reason).outcome;
        assert_eq!(outcome(&push(PushKind::SetUpstream), Some(PushExecReason::Pushed)), PushOutcome::PushedNew);
        assert_eq!(outcome(&push(PushKind::FastForward), Some(PushExecReason::Pushed)), PushOutcome::Pushed);
        assert_eq!(outcome(&push(PushKind::ForceWithLease), Some(PushExecReason::Pushed)), PushOutcome::PushedForce);
        assert_eq!(outcome(&push(PushKind::ForceWithLease), Some(PushExecReason::LeaseStale)), PushOutcome::LeaseStale);
        assert_eq!(outcome(&push(PushKind::FastForward), Some(PushExecReason::Rejected)), PushOutcome::Rejected);
        assert_eq!(outcome(&push(PushKind::FastForward), Some(PushExecReason::Auth)), PushOutcome::Auth);
        assert_eq!(outcome(&push(PushKind::FastForward), Some(PushExecReason::Failed)), PushOutcome::Failed);
        assert_eq!(outcome(&push(PushKind::FastForward), None), PushOutcome::Failed);
        let up = summarize_push_result(&PushPlan::UpToDate, None);
        assert!(up.ok && up.outcome == PushOutcome::UpToDate);
        assert!(!summarize_push_result(&PushPlan::BehindOnly, None).ok);
        assert_eq!(outcome(&PushPlan::Detached, None), PushOutcome::Detached);
        assert_eq!(outcome(&PushPlan::NoRemote, None), PushOutcome::NoRemote);
    }
}
