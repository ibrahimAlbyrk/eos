//! The `worker_loops` table (`core/src/ports/LoopStateRepo.ts`).

use eos_contracts::{GoalSpec, LoopStatus, LoopStrategy};
use eos_domain::WorkerLoop;
use eos_domain::loops::LoopAttempt;

use crate::Error;

#[derive(Debug, Clone, PartialEq)]
pub struct NewLoop {
    pub id: String,
    pub worker_id: String,
    pub parent_id: Option<String>,
    pub goal: GoalSpec,
    pub strategy: LoopStrategy,
    pub max_attempts: Option<i64>,
    pub started_at: i64,
}

/// What an amend changes; `None` keeps the field.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct LoopAmend {
    pub goal: Option<GoalSpec>,
    pub strategy: Option<LoopStrategy>,
    /// `Some(None)`: no cap any more.
    pub max_attempts: Option<Option<i64>>,
}

pub trait LoopRepo {
    /// Inserts an active loop. A worker has at most one.
    fn insert(&self, new: &NewLoop) -> Result<(), Error>;
    fn find(&self, id: &str) -> Result<Option<WorkerLoop>, Error>;
    fn find_active_by_worker(&self, worker_id: &str) -> Result<Option<WorkerLoop>, Error>;
    /// The worker's latest loop, whatever its status.
    fn find_any_by_worker(&self, worker_id: &str) -> Result<Option<WorkerLoop>, Error>;
    /// Every active loop, oldest first.
    fn list_active(&self) -> Result<Vec<WorkerLoop>, Error>;
    fn set_status(&self, id: &str, status: LoopStatus, now: i64) -> Result<(), Error>;
    fn set_awaiting_input(&self, id: &str, awaiting: bool, now: i64) -> Result<(), Error>;
    fn set_held_report(&self, id: &str, report: Option<&str>, now: i64) -> Result<(), Error>;
    fn set_check_failures(&self, id: &str, failures: i64, now: i64) -> Result<(), Error>;
    fn amend(&self, id: &str, patch: &LoopAmend, now: i64) -> Result<(), Error>;
    /// Clears the progress ring: a fresh no-progress window.
    fn reset_progress(&self, id: &str, now: i64) -> Result<(), Error>;
    /// Counts an attempt and adds it to the ring (the last twenty are kept);
    /// its reason becomes the loop's last reason.
    fn record_attempt(&self, id: &str, attempt: &LoopAttempt, now: i64) -> Result<(), Error>;
    fn delete(&self, id: &str) -> Result<(), Error>;
    fn delete_by_worker(&self, worker_id: &str) -> Result<(), Error>;
}
