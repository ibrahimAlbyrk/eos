//! How a workflow run reads as a row of the Jobs tab
//! (`core/src/domain/background-jobs.ts`).

use eos_contracts::{WorkflowAgentState, WorkflowRunSnapshot};
use eos_runtime::jobs::JobProgress;

/// The longest line a job's detail shows.
pub(crate) const DETAIL_CHARS: usize = 160;

/// `Verify 2/3 · 6 agents`, and the agents that ended out of all as the bar.
pub(crate) fn progress_of(snapshot: &WorkflowRunSnapshot) -> (Option<String>, Option<JobProgress>) {
    let WorkflowRunSnapshot { phases, agents, .. } = snapshot;
    let running = agents.iter().filter(|a| a.state == WorkflowAgentState::Running);
    let current = running.map(|a| a.phase_index.unwrap_or(0)).max().unwrap_or(0).max(0);
    let phase = phases.iter().find(|p| p.index == current).map(|p| format!("{} {}/{}", p.title, p.index, phases.len()));
    let count = match agents.len() {
        0 => None,
        1 => Some("1 agent".to_owned()),
        n => Some(format!("{n} agents")),
    };
    let parts: Vec<String> = phase.into_iter().chain(count).collect();
    let ended =
        |state| matches!(state, WorkflowAgentState::Done | WorkflowAgentState::Error | WorkflowAgentState::Cancelled);
    let done = agents.iter().filter(|a| ended(a.state)).count() as u64;
    (
        (!parts.is_empty()).then(|| parts.join(" · ")),
        (!agents.is_empty()).then_some(JobProgress { done, total: agents.len() as u64 }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use eos_domain::workflow_run::{apply_workflow_progress, empty_snapshot};
    use serde_json::json;

    #[test]
    fn a_run_reads_as_its_running_phase_and_how_many_agents_ended() {
        assert_eq!(progress_of(&empty_snapshot()), (None, None));
        let snapshot = apply_workflow_progress(
            &empty_snapshot(),
            &json!([
                {"type": "workflow_phase", "index": 1, "title": "Explore"},
                {"type": "workflow_phase", "index": 2, "title": "Verify"},
                {"type": "workflow_agent", "index": 1, "phaseIndex": 1, "state": "done"},
                {"type": "workflow_agent", "index": 2, "phaseIndex": 2, "state": "progress", "startedAt": 1},
            ]),
        );
        let (detail, bar) = progress_of(&snapshot);
        assert_eq!(detail.as_deref(), Some("Verify 2/2 · 2 agents"));
        assert_eq!(bar, Some(JobProgress { done: 1, total: 2 }));
    }
}
