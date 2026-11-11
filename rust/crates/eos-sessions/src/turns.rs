//! What is remembered about each worker's current turn, in memory.
//!
//! - The settle window (`manager/services/TurnSettleService.ts`): right
//!   after a turn ends or is interrupted, late events of that turn must not
//!   wake a worker that is correctly idle. A real new turn starts through a
//!   message (which clears the window) or the agent's own turn start (which
//!   the window does not hold, unless an interrupt is still pending).
//! - Whether the turn produced output yet and which row its prompt is
//!   (`TurnOutputTracker.ts`): an interrupt before any output takes the
//!   prompt back instead.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use eos_core::Clock;

/// How long late events of a finished turn are ignored.
const SETTLE_MS: i64 = 4000;

#[derive(Default, Clone, Copy)]
struct Turn {
    settle_until: Option<i64>,
    /// Interrupted, and the agent's stream has not ended that turn yet.
    interrupted: bool,
    /// The agent answered something in this turn.
    seen: bool,
    /// The row of the prompt that started it.
    recall_row: Option<i64>,
}

pub(crate) struct Turns {
    clock: Arc<dyn Clock>,
    by_worker: Mutex<HashMap<String, Turn>>,
}

impl Turns {
    pub(crate) fn new(clock: Arc<dyn Clock>) -> Self {
        Self { clock, by_worker: Mutex::default() }
    }

    fn with<T>(&self, worker_id: &str, change: impl FnOnce(&mut Turn) -> T) -> T {
        let mut all = self.by_worker.lock().unwrap_or_else(PoisonError::into_inner);
        change(all.entry(worker_id.to_owned()).or_default())
    }

    /// A turn just ended: its stragglers are ignored for a while.
    pub(crate) fn mark_settling(&self, worker_id: &str) {
        let until = self.clock.now_ms() + SETTLE_MS;
        self.with(worker_id, |t| {
            t.settle_until = Some(until);
            t.interrupted = false;
        });
    }

    pub(crate) fn mark_interrupt(&self, worker_id: &str) {
        let until = self.clock.now_ms() + SETTLE_MS;
        self.with(worker_id, |t| {
            t.settle_until = Some(until);
            t.interrupted = true;
        });
    }

    /// A real new turn starts.
    pub(crate) fn clear_settle(&self, worker_id: &str) {
        self.with(worker_id, |t| {
            t.settle_until = None;
            t.interrupted = false;
        });
    }

    pub(crate) fn is_settling(&self, worker_id: &str) -> bool {
        let now = self.clock.now_ms();
        self.with(worker_id, |t| match t.settle_until {
            Some(until) if now <= until => true,
            Some(_) => {
                t.settle_until = None;
                t.interrupted = false;
                false
            }
            None => false,
        })
    }

    pub(crate) fn is_interrupt_pending(&self, worker_id: &str) -> bool {
        self.is_settling(worker_id) && self.with(worker_id, |t| t.interrupted)
    }

    /// A message was delivered: nothing of its turn was answered yet.
    pub(crate) fn reset_output(&self, worker_id: &str) {
        self.with(worker_id, |t| {
            t.seen = false;
            t.recall_row = None;
        });
    }

    pub(crate) fn set_recall_row(&self, worker_id: &str, row_id: i64) {
        self.with(worker_id, |t| t.recall_row = Some(row_id));
    }

    pub(crate) fn mark_seen(&self, worker_id: &str) {
        self.with(worker_id, |t| t.seen = true);
    }

    /// The prompt row an interrupt may take back: set, and nothing answered yet.
    pub(crate) fn recallable(&self, worker_id: &str) -> Option<i64> {
        self.with(worker_id, |t| if t.seen { None } else { t.recall_row })
    }

    /// The worker is gone.
    pub(crate) fn forget(&self, worker_id: &str) {
        self.by_worker.lock().unwrap_or_else(PoisonError::into_inner).remove(worker_id);
    }

    pub(crate) fn len(&self) -> usize {
        self.by_worker.lock().unwrap_or_else(PoisonError::into_inner).len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use eos_testkit::FakeClock;

    #[test]
    fn a_finished_turn_settles_for_a_while() {
        let clock = Arc::new(FakeClock::new());
        let turns = Turns::new(clock.clone());
        assert!(!turns.is_settling("w"));
        turns.mark_interrupt("w");
        assert!(turns.is_settling("w") && turns.is_interrupt_pending("w"));
        turns.mark_settling("w");
        assert!(turns.is_settling("w") && !turns.is_interrupt_pending("w"), "the stream ended the interrupted turn");
        clock.advance(SETTLE_MS + 1);
        assert!(!turns.is_settling("w"));
        turns.mark_settling("w");
        turns.clear_settle("w");
        assert!(!turns.is_settling("w"));
    }

    #[test]
    fn a_prompt_can_be_taken_back_until_the_agent_answers() {
        let turns = Turns::new(Arc::new(FakeClock::new()));
        assert_eq!(turns.recallable("w"), None);
        turns.reset_output("w");
        turns.set_recall_row("w", 7);
        assert_eq!(turns.recallable("w"), Some(7));
        turns.mark_seen("w");
        assert_eq!(turns.recallable("w"), None);
        turns.forget("w");
        assert_eq!(turns.len(), 0);
    }
}
