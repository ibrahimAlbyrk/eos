//! The `worker_loops` table (`core/src/ports/LoopStateRepo.ts`).
//!
//! The parts a loop's own engine needs (amending the goal, the progress
//! ring, held output) arrive with that feature.

use eos_contracts::{GoalSpec, LoopStatus, LoopStrategy};
use eos_domain::WorkerLoop;

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
    fn delete(&self, id: &str) -> Result<(), Error>;
    fn delete_by_worker(&self, worker_id: &str) -> Result<(), Error>;
}
