//! `/compact`: one run per worker at a time. The run takes the idle worker
//! (WORKING, reason `compaction`, so messages queue behind it), has its
//! session summarize the conversation, and gives the worker back at IDLE,
//! where what was queued meanwhile goes out. The session reports the run
//! itself (the `compaction_*` rows).

use std::collections::HashSet;
use std::sync::{Arc, Mutex, PoisonError};

use eos_contracts::WorkerState;
use eos_core::agent::AgentSession;
use eos_domain::worker::state_name;
use eos_sessions::{Transition, transition_state};

use crate::Parts;

pub(crate) struct Inner {
    parts: Parts,
    /// Workers a run holds in WORKING: their messages queue.
    holding: Mutex<HashSet<String>>,
}

/// Cheap to clone.
#[derive(Clone)]
pub struct CompactionService(Arc<Inner>);

impl std::fmt::Debug for CompactionService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CompactionService").finish_non_exhaustive()
    }
}

impl CompactionService {
    pub fn new(parts: Parts) -> Self {
        Self(Arc::new(Inner { parts, holding: Mutex::default() }))
    }

    fn holding(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.0.holding.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// True while a run holds the worker in WORKING. The moment it settles
    /// to IDLE what was queued must be delivered as usual.
    pub fn is_compacting(&self, worker_id: &str) -> bool {
        self.holding().contains(worker_id)
    }

    /// The worker's session, when it is live and can be compacted.
    fn session(&self, worker_id: &str) -> Option<Arc<dyn AgentSession>> {
        self.0.parts.sessions.session(worker_id).filter(|s| s.capabilities().context_compaction == Some(true))
    }

    /// `/compact`. Asked for is asked for: neither the switch nor the
    /// threshold matters. `Err` is why it did not start.
    pub async fn start(&self, worker_id: &str, instructions: &str) -> Result<(), String> {
        let Some(session) = self.session(worker_id) else { return Err("this agent cannot be compacted".to_owned()) };
        if !self.holding().insert(worker_id.to_owned()) {
            return Err("a compaction is already running".to_owned());
        }
        let release = Release { service: self.clone(), id: worker_id.to_owned() };
        self.take(worker_id).await?;
        let instructions = Some(instructions.trim().to_owned()).filter(|i| !i.is_empty());
        let service = self.clone();
        tokio::spawn(async move {
            if let Err(e) = session.compact(instructions).await {
                tracing::warn!(worker_id = %release.id, error = %e, "a compaction could not run");
            }
            drop(release);
            service.give_back(session.worker_id()).await;
        });
        Ok(())
    }

    /// IDLE → WORKING. Only an idle worker is taken: a message that got in first keeps it.
    async fn take(&self, worker_id: &str) -> Result<(), String> {
        let (id, now) = (worker_id.to_owned(), self.0.parts.clock.now_ms());
        let taken = self
            .0
            .parts
            .store
            .write(move |tx, out| {
                let Some(worker) = tx.workers().find(&id)? else { return Ok(Err("worker not found".to_owned())) };
                if worker.state != WorkerState::Idle
                    || transition_state(tx, out, now, &id, WorkerState::Working, "compaction")? != Transition::Applied
                {
                    return Ok(Err(format!("cannot compact from state {}", state_name(worker.state))));
                }
                Ok(Ok(()))
            })
            .await;
        taken.unwrap_or_else(|e| Err(e.to_string()))
    }

    /// WORKING → IDLE, then the idle edge. Only what this run lifted is
    /// settled: a stop or a removal owns the state now.
    async fn give_back(&self, worker_id: &str) {
        let (id, now) = (worker_id.to_owned(), self.0.parts.clock.now_ms());
        let settled = self
            .0
            .parts
            .store
            .write(move |tx, out| {
                let working = tx.workers().find(&id)?.is_some_and(|w| w.state == WorkerState::Working);
                Ok(working
                    && transition_state(tx, out, now, &id, WorkerState::Idle, "compaction")? == Transition::Applied)
            })
            .await;
        match settled {
            Ok(true) => self.0.parts.sessions.settled(worker_id).await,
            Ok(false) => {}
            Err(e) => tracing::error!(worker_id, error = %e, "a compacted worker could not be settled"),
        }
    }
}

/// Lets go of a worker a run held, however the run ends (a panic too):
/// otherwise every message to the worker would queue for good.
struct Release {
    service: CompactionService,
    id: String,
}

impl Drop for Release {
    fn drop(&mut self) {
        self.service.holding().remove(&self.id);
    }
}
