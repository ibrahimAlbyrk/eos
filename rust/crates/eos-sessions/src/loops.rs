//! A worker's goal loop on record (`core/src/use-cases/attachLoop.ts`).
//!
//! A step of a database write job: the loop row is saved with whatever else
//! the job writes.

use eos_contracts::{GoalSpec, LoopStrategy};
use eos_core::store::{NewLoop, Tx};
use eos_core::{Error, Ids};

/// Who arms a loop on whom, and with what.
#[derive(Debug, Clone, PartialEq)]
pub struct AttachLoop {
    /// The orchestrator arming it.
    pub caller_id: String,
    /// The worker it runs on; the caller itself when `None`.
    pub target: Option<String>,
    pub goal: GoalSpec,
    pub strategy: Option<LoopStrategy>,
    /// How many attempts at most; `None` for no cap.
    pub limit: Option<i64>,
}

/// Arms a loop and returns its id. The caller must be an orchestrator and the
/// target itself or a worker it spawned; a worker has one active loop at most.
pub fn attach_loop(tx: &dyn Tx, ids: &dyn Ids, now: i64, input: &AttachLoop) -> Result<String, Error> {
    let caller = tx.workers().find(&input.caller_id)?.ok_or_else(|| Error::not_found("worker", &input.caller_id))?;
    if !caller.is_orchestrator {
        return Err(Error::PermissionDenied(format!("worker {} is not an orchestrator", input.caller_id)));
    }
    let target_id = input.target.as_deref().unwrap_or(&input.caller_id);
    let mut parent_id = None;
    if target_id != input.caller_id {
        let target = tx.workers().find(target_id)?.ok_or_else(|| Error::not_found("worker", target_id))?;
        if target.parent_id.as_deref() != Some(&input.caller_id) {
            return Err(Error::PermissionDenied(format!("worker {target_id} is not managed by {}", input.caller_id)));
        }
        parent_id = target.parent_id;
    }
    if tx.loops().find_active_by_worker(target_id)?.is_some() {
        return Err(Error::Conflict(format!("an active loop already exists on {target_id}")));
    }
    let id = ids.loop_id();
    tx.loops().insert(&NewLoop {
        id: id.clone(),
        worker_id: target_id.to_owned(),
        parent_id,
        goal: input.goal.clone(),
        strategy: input.strategy.unwrap_or(LoopStrategy::Hybrid),
        max_attempts: input.limit,
        started_at: now,
    })?;
    Ok(id)
}
