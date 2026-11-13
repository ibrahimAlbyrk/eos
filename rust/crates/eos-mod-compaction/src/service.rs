//! When to compact, and one run per worker at a time
//! (`manager/modules/compaction/CompactionService.ts`).
//!
//! - automatic: at a worker's idle edge, ahead of the nudges — a worker at
//!   or over the configured threshold is compacted before anything hands it
//!   more work;
//! - by hand: the `/compact` command.
//!
//! An automatic run waits while the worker's background subagents and
//! workflow runs are going (replacing the conversation would end them), up
//! to the occupancy past which waiting is the bigger risk. Their end wakes
//! the agent, and its next idle edge checks again.
//!
//! An automatic run that failed is not tried again at the same occupancy,
//! only after a new turn has moved the context: a broken summarizer cannot
//! spin at IDLE. Configuration is read at each check.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, PoisonError};

use eos_contracts::{CompactionTrigger, WorkerState};
use eos_core::agent::AgentSession;
use eos_domain::Worker;
use eos_runtime::jobs::JobSpec;

use crate::rules::{is_compaction_due, should_defer_compaction};
use crate::run::{self, Begun, Input};
use crate::{JOB_KIND, Parts};

/// Workers whose failed automatic run is remembered, at most.
const MAX_FAILED: usize = 256;

#[derive(Default)]
struct State {
    /// Workers with a run going, from the decision to start until its end.
    running: HashSet<String>,
    /// Workers a run holds in WORKING: their messages queue.
    holding: HashSet<String>,
    /// The occupancy at which a worker's automatic run last failed.
    failed_at: HashMap<String, i64>,
}

pub(crate) struct Inner {
    parts: Parts,
    state: Mutex<State>,
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
        Self(Arc::new(Inner { parts, state: Mutex::default() }))
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.0.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// True while a run holds the worker in WORKING. The moment it settles
    /// to IDLE what was queued must be delivered as usual.
    pub fn is_compacting(&self, worker_id: &str) -> bool {
        self.state().holding.contains(worker_id)
    }

    async fn worker(&self, worker_id: &str) -> Option<Worker> {
        let id = worker_id.to_owned();
        self.0.parts.store.read(move |tx| tx.workers().find(&id)).await.ok().flatten()
    }

    /// The worker's session, when it is live and can be compacted.
    fn session(&self, worker_id: &str) -> Option<Arc<dyn AgentSession>> {
        self.0.parts.sessions.session(worker_id).filter(|s| s.capabilities().context_compaction == Some(true))
    }

    /// Starts an automatic compaction when one is due. `true`: the worker is
    /// taken; its next idle edge comes when the compaction ends.
    pub async fn check_on_idle(&self, worker_id: &str) -> bool {
        if self.state().running.contains(worker_id) {
            return false;
        }
        let Some(worker) = self.worker(worker_id).await.filter(|w| w.state == WorkerState::Idle) else { return false };
        let used = worker.last_context_tokens.unwrap_or(0);
        if self.state().failed_at.get(worker_id) == Some(&used) {
            return false;
        }
        let config = self.0.parts.config.current();
        let limit = Some(self.0.parts.models.context_window_for(worker.model.as_deref()));
        if !is_compaction_due(config.compaction.enabled, config.compaction.threshold, used, limit) {
            return false;
        }
        let Some(session) = self.session(worker_id) else { return false };
        if should_defer_compaction(session.live_subagents(), used, limit, config.context.full_ratio) {
            return false;
        }
        let input = Input { worker_id: worker_id.to_owned(), trigger: CompactionTrigger::Auto, instructions: None };
        self.launch(session, input, used).await.is_ok()
    }

    /// `/compact`. Asked for is asked for: neither the switch nor the
    /// threshold matters. `Err` is why it did not start.
    pub async fn start(&self, worker_id: &str, instructions: &str) -> Result<(), String> {
        if self.state().running.contains(worker_id) {
            return Err("a compaction is already running".to_owned());
        }
        let Some(worker) = self.worker(worker_id).await else { return Err("worker not found".to_owned()) };
        if worker.state != WorkerState::Idle {
            return Err("the agent is busy".to_owned());
        }
        let Some(session) = self.session(worker_id) else { return Err("this agent cannot be compacted".to_owned()) };
        let instructions = Some(instructions.to_owned()).filter(|i| !i.is_empty());
        let input = Input { worker_id: worker_id.to_owned(), trigger: CompactionTrigger::Manual, instructions };
        self.launch(session, input, worker.last_context_tokens.unwrap_or(0)).await
    }

    /// Takes the worker and runs the compaction in a task of its own.
    async fn launch(&self, session: Arc<dyn AgentSession>, input: Input, used_at_start: i64) -> Result<(), String> {
        let id = input.worker_id.clone();
        {
            let mut state = self.state();
            if !state.running.insert(id.clone()) {
                return Err("a compaction is already running".to_owned());
            }
            state.holding.insert(id.clone());
        }
        let begun = match run::begin(&self.0.parts, session, input.clone()).await {
            Ok(begun) => begun,
            Err(why) => {
                let mut state = self.state();
                state.running.remove(&id);
                state.holding.remove(&id);
                return Err(why);
            }
        };
        // Shown only while it runs.
        let mut job = JobSpec::new(JOB_KIND, Some(&id), "context", "Compacting context");
        job.ambient = true;
        self.0.parts.jobs.start(job).update_now(|_| {});
        let service = self.clone();
        tokio::spawn(async move { service.run(begun, input, used_at_start).await });
        Ok(())
    }

    async fn run(&self, begun: Begun, input: Input, used_at_start: i64) {
        let (service, id) = (self.clone(), input.worker_id);
        let auto = input.trigger == CompactionTrigger::Auto;
        // The bookkeeping ends before the worker's idle edge runs the hooks again.
        let done = move |replaced: bool| {
            let mut state = service.state();
            state.holding.remove(&id);
            state.running.remove(&id);
            if replaced {
                state.failed_at.remove(&id);
            } else if auto {
                if state.failed_at.len() >= MAX_FAILED {
                    state.failed_at.clear();
                }
                state.failed_at.insert(id.clone(), used_at_start);
            }
            drop(state);
            if let Some(job) = service.0.parts.jobs.get(JOB_KIND, Some(&id), "context") {
                job.drop_job();
            }
        };
        run::finish(&self.0.parts, begun, done).await;
    }
}
