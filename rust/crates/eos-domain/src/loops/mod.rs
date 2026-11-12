//! A worker's goal loop: it keeps working until its goal's criteria pass
//! (`core/src/domain/loop-*.ts`, `judge-rubric.ts`).
//!
//! | Module | |
//! |---|---|
//! | `progress` | whether the attempts still make progress |
//! | `lint` | a goal's criteria checked against its strategy when it is armed |
//! | `feedback` | the variables of the messages a tick sends |
//! | `verdict` | the judge's prompt variables, reading its answer, the command check's verdict |

pub mod feedback;
pub mod lint;
pub mod progress;
pub mod verdict;

use eos_contracts::{GoalSpec, LoopStatus, LoopStrategy, WorkerRowLoop};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One checked attempt, as the no-progress safety remembers it. Stored as
/// JSON in the loop's `progress_ring`, in today's field names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopAttempt {
    /// A hash of the worker's change-set; empty when there is none to hash.
    pub state_hash: String,
    /// [`progress::outcome_key`] of the unmet criteria.
    pub outcome_hash: String,
    pub unmet_count: i64,
    pub reason: String,
}

/// Whether a loop in `from` may move to `to`. Only an active loop moves; a
/// move to the same status is allowed (the caller writes nothing then).
pub fn can_transition(from: LoopStatus, to: LoopStatus) -> bool {
    from == to || (from == LoopStatus::Active && to != LoopStatus::Active)
}

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
    /// The last attempts, oldest first (at most [`progress::RING_CAP`]).
    pub progress_ring: Vec<LoopAttempt>,
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
