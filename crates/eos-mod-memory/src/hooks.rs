//! When capture looks at a worker's conversation: at its idle edge, every
//! ten minutes while it keeps working (a long turn has no idle edge, G17),
//! and when its session ends. Looks run beside the worker, never holding it.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, PoisonError};

use eos_core::Sleeper;
use eos_core::routine::RunLookup;
use eos_domain::experience::moments::Signal;
use eos_memory::credit::{ChatOutcome, Credit, surprises};
use eos_memory::{Capture, Captured};
use tokio::sync::Notify;

/// How often a worker still working is looked at.
pub(crate) const TICK_MS: i64 = 10 * 60 * 1000;
/// Workers remembered as working between ticks.
const ACTIVE_MAX: usize = 512;
/// Looks in a row at one worker before the rest waits for the next edge.
const LOOKS_MAX: usize = 10;

pub(crate) struct Capturer {
    capture: Capture,
    runs: Option<Arc<dyn RunLookup>>,
    credit: Arc<Credit>,
    /// Workers that did something since the last tick.
    active: Mutex<HashSet<String>>,
    /// Wakes reflection when a look stored moments.
    reflect: Arc<Notify>,
}

impl Capturer {
    pub(crate) fn new(
        capture: Capture,
        runs: Option<Arc<dyn RunLookup>>,
        credit: Arc<Credit>,
        reflect: Arc<Notify>,
    ) -> Self {
        Self { capture, runs, credit, active: Mutex::new(HashSet::new()), reflect }
    }

    pub(crate) fn saw(&self, worker_id: &str) {
        let mut active = self.active.lock().unwrap_or_else(PoisonError::into_inner);
        if active.len() < ACTIVE_MAX || active.contains(worker_id) {
            active.insert(worker_id.to_owned());
        }
    }

    pub(crate) fn ended(&self, worker_id: &str) {
        self.active.lock().unwrap_or_else(PoisonError::into_inner).remove(worker_id);
    }

    /// Reads what the worker did since the last look.
    pub(crate) async fn look(&self, worker_id: &str) {
        let run = match &self.runs {
            Some(runs) => runs.run_of(worker_id).await,
            None => None,
        };
        for _ in 0..LOOKS_MAX {
            match self.capture.look(worker_id, run.clone()).await {
                Ok(captured) => {
                    self.settle(worker_id, &captured).await;
                    if !captured.stored.is_empty() {
                        self.reflect.notify_one();
                    }
                    if !captured.more {
                        return;
                    }
                }
                Err(e) => {
                    // The next edge or tick tries again; nothing waits in memory.
                    tracing::warn!(worker_id, error = %e, "memory: capture failed");
                    return;
                }
            }
        }
    }

    /// Credits the notes recalled in the conversation by how the look found
    /// it ending: a surprise outweighs an acceptance in the same look.
    async fn settle(&self, worker_id: &str, captured: &Captured) {
        let surprised = captured.stored.iter().any(|m| Signal::parse(&m.signal).is_some_and(surprises));
        let outcome = if surprised {
            ChatOutcome::Surprised
        } else if !captured.accepted.is_empty() {
            ChatOutcome::Good
        } else {
            return;
        };
        if let Err(e) = self.credit.chat_ended(worker_id, outcome).await {
            tracing::warn!(worker_id, error = %e, "memory: the chat's outcome was not credited");
        }
    }

    /// Looks at every worker that worked since the last tick, every ten
    /// minutes, until stopped.
    pub(crate) async fn tick(self: Arc<Self>, sleeper: Arc<dyn Sleeper>) {
        loop {
            sleeper.sleep(TICK_MS).await;
            let workers: Vec<String> = self.active.lock().unwrap_or_else(PoisonError::into_inner).drain().collect();
            for worker_id in workers {
                self.look(&worker_id).await;
            }
        }
    }
}
