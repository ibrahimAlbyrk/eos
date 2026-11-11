//! Workflow runs, the pure part: folding a run's raw progress rows into the
//! canonical snapshot (`core/src/domain/workflow-run.ts`).
//!
//! The rows are Claude Code's untyped `workflow_progress` entries. This is
//! their only reader: unknown fields are dropped, unknown states read as
//! running, and anything malformed leaves the snapshot as it was.

use std::collections::BTreeMap;

use eos_contracts::primitives::Num;
use eos_contracts::{WorkflowAgent, WorkflowAgentState, WorkflowPhase, WorkflowRunSnapshot};
use serde_json::Value;

/// A run nothing was reported about yet.
pub fn empty_snapshot() -> WorkflowRunSnapshot {
    WorkflowRunSnapshot { phases: Vec::new(), agents: Vec::new(), logs: Vec::new() }
}

fn text(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}

fn number(v: Option<&Value>) -> Option<Num> {
    v.and_then(Value::as_f64).filter(|n| n.is_finite()).map(Num)
}

/// A 1-based position.
fn index(v: Option<&Value>) -> Option<i64> {
    let n = v?.as_f64()?;
    (n.fract() == 0.0 && n > 0.0 && n < 9.0e15).then_some(n as i64)
}

// "start" is sent twice: when the agent is queued (no start time yet) and
// again when it starts. "progress" is a running agent's tool tick.
fn agent_state(raw: Option<&Value>, started: bool) -> WorkflowAgentState {
    match raw.and_then(Value::as_str) {
        Some("done") => WorkflowAgentState::Done,
        Some("error") => WorkflowAgentState::Error,
        Some("cancelled") => WorkflowAgentState::Cancelled,
        Some("start") if !started => WorkflowAgentState::Queued,
        _ => WorkflowAgentState::Running,
    }
}

fn to_agent(e: &Value, prev: Option<&WorkflowAgent>) -> Option<WorkflowAgent> {
    let i = index(e.get("index"))?;
    let started_at = number(e.get("startedAt")).or(prev.and_then(|p| p.started_at));
    let mut agent = prev.cloned().unwrap_or(WorkflowAgent {
        index: i,
        label: String::new(),
        phase_index: None,
        agent_id: None,
        model: None,
        state: WorkflowAgentState::Running,
        queued_at: None,
        started_at: None,
        last_progress_at: None,
        duration_ms: None,
        last_tool_name: None,
        last_tool_summary: None,
        prompt_preview: None,
        result_preview: None,
        tokens: None,
        tool_calls: None,
        error: None,
        cached: None,
    });
    agent.index = i;
    agent.label = text(e.get("label"))
        .or_else(|| prev.map(|p| p.label.clone()).filter(|l| !l.is_empty()))
        .unwrap_or_else(|| format!("agent {i}"));
    agent.state = agent_state(e.get("state"), started_at.is_some());
    // A field the row carries replaces the earlier value; one it lacks keeps it.
    fn keep<T>(slot: &mut Option<T>, new: Option<T>) {
        if new.is_some() {
            *slot = new;
        }
    }
    keep(&mut agent.phase_index, index(e.get("phaseIndex")));
    keep(&mut agent.agent_id, text(e.get("agentId")));
    keep(&mut agent.model, text(e.get("model")));
    keep(&mut agent.queued_at, number(e.get("queuedAt")));
    keep(&mut agent.started_at, started_at);
    keep(&mut agent.last_progress_at, number(e.get("lastProgressAt")));
    keep(&mut agent.duration_ms, number(e.get("durationMs")));
    keep(&mut agent.last_tool_name, text(e.get("lastToolName")));
    keep(&mut agent.last_tool_summary, text(e.get("lastToolSummary")));
    keep(&mut agent.prompt_preview, text(e.get("promptPreview")));
    keep(&mut agent.result_preview, text(e.get("resultPreview")));
    keep(&mut agent.tokens, number(e.get("tokens")));
    keep(&mut agent.tool_calls, number(e.get("toolCalls")));
    keep(&mut agent.error, text(e.get("error")));
    keep(&mut agent.cached, (e.get("cached") == Some(&Value::Bool(true))).then_some(true));
    Some(agent)
}

/// Folds one progress list into the snapshot. The engine sends the run's
/// whole list each time, but rows are merged by index anyway, so a partial
/// list never drops what an earlier one reported.
pub fn apply_workflow_progress(prev: &WorkflowRunSnapshot, raw: &Value) -> WorkflowRunSnapshot {
    let Some(rows) = raw.as_array() else { return prev.clone() };
    let mut phases: BTreeMap<i64, WorkflowPhase> = prev.phases.iter().map(|p| (p.index, p.clone())).collect();
    let mut agents: BTreeMap<i64, WorkflowAgent> = prev.agents.iter().map(|a| (a.index, a.clone())).collect();
    let mut logs = Vec::new();
    for e in rows.iter().filter(|e| e.is_object()) {
        match e.get("type").and_then(Value::as_str) {
            Some("workflow_phase") => {
                if let (Some(i), Some(title)) = (index(e.get("index")), text(e.get("title"))) {
                    let detail = phases.get(&i).and_then(|p| p.detail.clone());
                    phases.insert(i, WorkflowPhase { index: i, title, detail });
                }
            }
            Some("workflow_agent") => {
                let prev = index(e.get("index")).and_then(|i| agents.get(&i));
                if let Some(agent) = to_agent(e, prev) {
                    agents.insert(agent.index, agent);
                }
            }
            Some("workflow_log") => logs.extend(text(e.get("message"))),
            _ => {}
        }
    }
    // Logs carry no index: a list that has any is the run's whole log so far.
    WorkflowRunSnapshot {
        phases: phases.into_values().collect(),
        agents: agents.into_values().collect(),
        logs: if logs.is_empty() { prev.logs.clone() } else { logs },
    }
}

/// How a run ended, for [`settle_workflow_snapshot`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunEnd {
    Completed,
    Failed,
    Stopped,
}

/// A run that ended leaves its in-flight agents as they last reported. They
/// end with the run: done when it completed, cancelled when it was stopped
/// or failed.
pub fn settle_workflow_snapshot(mut snapshot: WorkflowRunSnapshot, end: RunEnd) -> WorkflowRunSnapshot {
    let closed = if end == RunEnd::Completed { WorkflowAgentState::Done } else { WorkflowAgentState::Cancelled };
    for agent in &mut snapshot.agents {
        if matches!(agent.state, WorkflowAgentState::Running | WorkflowAgentState::Queued) {
            agent.state = closed;
        }
    }
    snapshot
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // core/src/__tests__/workflow-run.test.ts
    #[test]
    fn progress_rows_fold_into_phases_agents_and_logs() {
        let first = apply_workflow_progress(
            &empty_snapshot(),
            &json!([
                {"type": "workflow_phase", "index": 1, "title": "Explore"},
                {"type": "workflow_agent", "index": 1, "label": "scan", "phaseIndex": 1, "state": "start", "queuedAt": 5},
                {"type": "workflow_log", "message": "starting"},
                {"type": "workflow_agent", "index": 0, "label": "bad index"},
                "noise",
            ]),
        );
        assert_eq!(first.phases.len(), 1);
        assert_eq!(first.agents.len(), 1);
        assert_eq!(first.agents[0].state, WorkflowAgentState::Queued, "queued until it reports a start time");
        assert_eq!(first.logs, ["starting"]);

        let second = apply_workflow_progress(
            &first,
            &json!([
                {"type": "workflow_agent", "index": 1, "state": "start", "startedAt": 9, "agentId": "a1"},
                {"type": "workflow_agent", "index": 2, "state": "progress", "lastToolName": "Read", "tokens": 12},
            ]),
        );
        let scan = &second.agents[0];
        assert_eq!((scan.label.as_str(), scan.state, scan.phase_index), ("scan", WorkflowAgentState::Running, Some(1)));
        assert_eq!(scan.queued_at, Some(Num(5.0)), "a field the row lacks is kept");
        assert_eq!(second.agents[1].label, "agent 2");
        assert_eq!(second.logs, ["starting"], "a list without logs keeps the earlier ones");

        let third = apply_workflow_progress(&second, &json!([{"type": "workflow_agent", "index": 1, "state": "done"}]));
        assert_eq!(third.agents[0].state, WorkflowAgentState::Done);
        assert_eq!(apply_workflow_progress(&third, &json!({"not": "a list"})), third);
    }

    #[test]
    fn open_agents_end_with_their_run() {
        let running = apply_workflow_progress(
            &empty_snapshot(),
            &json!([
                {"type": "workflow_agent", "index": 1, "state": "done"},
                {"type": "workflow_agent", "index": 2, "state": "progress", "startedAt": 1},
                {"type": "workflow_agent", "index": 3, "state": "start"},
            ]),
        );
        let states = |s: &WorkflowRunSnapshot| s.agents.iter().map(|a| a.state).collect::<Vec<_>>();
        let (done, cancelled) = (WorkflowAgentState::Done, WorkflowAgentState::Cancelled);
        assert_eq!(states(&settle_workflow_snapshot(running.clone(), RunEnd::Completed)), [done, done, done]);
        assert_eq!(states(&settle_workflow_snapshot(running.clone(), RunEnd::Stopped)), [done, cancelled, cancelled]);
        assert_eq!(states(&settle_workflow_snapshot(running, RunEnd::Failed)), [done, cancelled, cancelled]);
    }
}
