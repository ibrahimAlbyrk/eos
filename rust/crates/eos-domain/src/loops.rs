//! A worker's goal loop: it keeps working until its goal's criteria pass.

use eos_contracts::{GoalSpec, LoopStatus, LoopStrategy, WorkerRowLoop};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct WorkerLoop {
    pub id: String,
    pub worker_id: String,
    pub parent_id: Option<String>,
    /// The goal as stored. Rows written by older versions hold other shapes,
    /// so it is typed only where it is used ([`goal_spec`](Self::goal_spec)).
    pub goal: Value,
    pub strategy: LoopStrategy,
    pub status: LoopStatus,
    /// Checks made so far.
    pub attempt: i64,
    /// `None`: no cap.
    pub max_attempts: Option<i64>,
    /// The worker's report, held back until the goal passes.
    pub held_report: Option<String>,
    /// What the last check said.
    pub last_reason: Option<String>,
    /// Paused until someone answers the worker.
    pub awaiting_input: bool,
    /// Checks in a row that could not run.
    pub check_failures: i64,
    pub started_at: i64,
    pub updated_at: i64,
}

impl WorkerLoop {
    /// The goal's one-line summary, when it has one.
    pub fn goal_summary(&self) -> Option<&str> {
        self.goal.get("summary").and_then(Value::as_str)
    }

    /// The goal with its criteria; `None` for a row of an older shape.
    pub fn goal_spec(&self) -> Option<GoalSpec> {
        serde_json::from_value(self.goal.clone()).ok()
    }

    /// What a worker row shows of its active loop.
    pub fn to_row(&self) -> WorkerRowLoop {
        WorkerRowLoop {
            status: self.status,
            attempt: self.attempt.into(),
            max_attempts: self.max_attempts.map(Into::into),
            last_reason: self.last_reason.clone(),
            goal_summary: self.goal_summary().map(str::to_owned),
        }
    }
}
