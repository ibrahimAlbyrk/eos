//! Background tasks of a session: workflow runs (two recorded events and a
//! live snapshot) and background commands (the job list only).

use std::collections::HashMap;

use eos_agent_core::{TaskEvent, TaskEventKind, TaskUsage};
use eos_contracts::{
    AgentEvent, SubagentUsage, WorkflowCompletedEvent, WorkflowCompletedEventStatus, WorkflowRunProgress,
    WorkflowRunSnapshot, WorkflowRunStatus, WorkflowStartedEvent,
};
use eos_core::agent::{BackgroundTaskKind, BackgroundTaskUpdate, TaskOutcome};
use eos_domain::workflow_run::{RunEnd, apply_workflow_progress, empty_snapshot, settle_workflow_snapshot};
use serde_json::Value;

use super::Side;
use super::tracked::Calls;

const WORKFLOW: &str = "local_workflow";

struct Workflow {
    call_id: String,
    snapshot: WorkflowRunSnapshot,
    usage: Option<SubagentUsage>,
}

struct Shell {
    output_file: Option<String>,
}

#[derive(Default)]
pub(super) struct Tasks {
    workflows: HashMap<String, Workflow>,
    shells: HashMap<String, Shell>,
}

fn usage_of(usage: TaskUsage) -> Option<SubagentUsage> {
    (usage != TaskUsage::default()).then(|| SubagentUsage {
        total_tokens: Some(usage.total_tokens.into()),
        tool_uses: Some(usage.tool_uses.into()),
        duration_ms: Some(usage.duration_ms.into()),
    })
}

fn some(text: Option<String>) -> Option<String> {
    text.filter(|t| !t.is_empty())
}

fn fold(snapshot: &mut WorkflowRunSnapshot, rows: Option<&serde_json::value::RawValue>) {
    if let Some(rows) = rows.and_then(|r| serde_json::from_str::<Value>(r.get()).ok()) {
        *snapshot = apply_workflow_progress(snapshot, &rows);
    }
}

impl Tasks {
    pub(super) fn live_workflows(&self) -> usize {
        self.workflows.len()
    }

    /// Applies one task event. A workflow's start is returned with its call,
    /// for the caller to place after the call's result row; everything else
    /// recorded goes to `out`.
    pub(super) fn apply(
        &mut self,
        event: TaskEvent,
        calls: &Calls,
        side: &Side<'_>,
        out: &mut Vec<AgentEvent>,
    ) -> Option<(String, AgentEvent)> {
        let TaskEvent { task_id, tool_use_id, kind, .. } = event;
        match kind {
            TaskEventKind::Started {
                task_type,
                description,
                workflow_name,
                run_id,
                transcript_dir,
                command,
                output_file,
            } => {
                let call_id = tool_use_id?;
                if task_type == WORKFLOW {
                    let run = Workflow { call_id: call_id.clone(), snapshot: empty_snapshot(), usage: None };
                    self.workflows.insert(task_id.clone(), run);
                    let started = AgentEvent::WorkflowStarted(WorkflowStartedEvent {
                        call_id: call_id.clone(),
                        task_id,
                        run_id: some(run_id),
                        name: some(workflow_name),
                        description: some(Some(description)),
                        transcript_dir: some(transcript_dir),
                    });
                    return Some((call_id, started));
                }
                let (kind, title, said) = calls.shell(&call_id);
                let command = said.or(some(command));
                let fallback = if kind == BackgroundTaskKind::Monitor { "Monitor" } else { "Shell" };
                let title = title
                    .or(some(Some(description)))
                    .or_else(|| command.clone().filter(|_| kind == BackgroundTaskKind::Shell))
                    .unwrap_or_else(|| fallback.to_owned());
                let output_file = some(output_file);
                self.shells.insert(task_id.clone(), Shell { output_file: output_file.clone() });
                let update = BackgroundTaskUpdate::Started { task_id, call_id, kind, title, command, output_file };
                side.sink.background_task(side.worker_id, update);
            }
            TaskEventKind::Output { .. } => {
                if let Some(file) = self.shells.get(&task_id).and_then(|s| s.output_file.clone()) {
                    side.sink
                        .background_task(side.worker_id, BackgroundTaskUpdate::Output { task_id, output_file: file });
                }
            }
            TaskEventKind::Progress { usage, workflow_progress, .. } => {
                let run = self.workflows.get_mut(&task_id)?;
                fold(&mut run.snapshot, workflow_progress.as_deref());
                run.usage = usage_of(usage).or(run.usage.take());
                side.sink.workflow_progress(WorkflowRunProgress {
                    worker_id: side.worker_id.to_owned(),
                    call_id: run.call_id.clone(),
                    task_id,
                    status: WorkflowRunStatus::Running,
                    snapshot: run.snapshot.clone(),
                    usage: run.usage.clone(),
                    updated_at: side.now_ms.into(),
                });
            }
            TaskEventKind::Ended { status, summary, output_file, usage, workflow_progress, exit_code } => {
                let outcome = match status.as_str() {
                    "failed" => TaskOutcome::Failed,
                    "stopped" | "killed" => TaskOutcome::Stopped,
                    _ => TaskOutcome::Completed,
                };
                if let Some(mut run) = self.workflows.remove(&task_id) {
                    fold(&mut run.snapshot, workflow_progress.as_deref());
                    out.push(completed(task_id, run, outcome, some(Some(summary)), usage_of(usage)));
                } else if let Some(shell) = self.shells.remove(&task_id) {
                    let update = BackgroundTaskUpdate::Ended {
                        task_id,
                        outcome,
                        summary: some(Some(summary)),
                        output_file: some(output_file).or(shell.output_file),
                        exit_code: exit_code.map(i64::from),
                    };
                    side.sink.background_task(side.worker_id, update);
                }
            }
        }
        None
    }

    /// The session is going away: every run and command still open is closed as stopped.
    pub(super) fn stop_all(&mut self, side: &Side<'_>, out: &mut Vec<AgentEvent>) {
        let mut runs: Vec<(String, Workflow)> = self.workflows.drain().collect();
        runs.sort_by(|a, b| a.0.cmp(&b.0));
        for (task_id, run) in runs {
            out.push(completed(task_id, run, TaskOutcome::Stopped, None, None));
        }
        let mut shells: Vec<(String, Shell)> = self.shells.drain().collect();
        shells.sort_by(|a, b| a.0.cmp(&b.0));
        for (task_id, shell) in shells {
            let update = BackgroundTaskUpdate::Ended {
                task_id,
                outcome: TaskOutcome::Stopped,
                summary: None,
                output_file: shell.output_file,
                exit_code: None,
            };
            side.sink.background_task(side.worker_id, update);
        }
    }
}

/// A finished run carries its last snapshot, so it renders from the log alone.
fn completed(
    task_id: String,
    run: Workflow,
    outcome: TaskOutcome,
    summary: Option<String>,
    usage: Option<SubagentUsage>,
) -> AgentEvent {
    let (status, end) = match outcome {
        TaskOutcome::Completed => (WorkflowCompletedEventStatus::Completed, RunEnd::Completed),
        TaskOutcome::Failed => (WorkflowCompletedEventStatus::Failed, RunEnd::Failed),
        TaskOutcome::Stopped => (WorkflowCompletedEventStatus::Stopped, RunEnd::Stopped),
    };
    AgentEvent::WorkflowCompleted(WorkflowCompletedEvent {
        call_id: run.call_id,
        task_id,
        status,
        summary,
        usage: usage.or(run.usage),
        snapshot: Some(settle_workflow_snapshot(run.snapshot, end)),
    })
}
