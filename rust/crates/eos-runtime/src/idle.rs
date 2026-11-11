//! What runs when a worker settles at IDLE with nothing left in its queue —
//! compaction, the goal loop, the report and context nudges, a feature's own —
//! in `order`. A hook that returns `true` has taken the worker (it is working
//! again), so the hooks after it wait for its next IDLE.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, RwLock};

use crate::error::panic_message;

#[derive(Clone)]
pub struct IdleHook {
    pub id: &'static str,
    /// Lower runs first (today: compaction 10, goal loop 20, report gap 30,
    /// context threshold 40).
    pub order: i32,
    run: Arc<dyn Fn(&str) -> bool + Send + Sync>,
}

impl IdleHook {
    /// `run` gets the worker id and returns whether it took the worker.
    pub fn new(id: &'static str, order: i32, run: impl Fn(&str) -> bool + Send + Sync + 'static) -> Self {
        Self { id, order, run: Arc::new(run) }
    }
}

impl std::fmt::Debug for IdleHook {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IdleHook").field("id", &self.id).field("order", &self.order).finish_non_exhaustive()
    }
}

#[derive(Debug, Default)]
pub struct IdleHooks {
    hooks: RwLock<Arc<[IdleHook]>>,
}

impl IdleHooks {
    pub fn new(hooks: impl IntoIterator<Item = IdleHook>) -> Self {
        let all = Self::default();
        for hook in hooks {
            all.add(hook);
        }
        all
    }

    /// Adds a hook; one with the same id is replaced. Hooks of equal order
    /// run in the order they were added.
    pub fn add(&self, hook: IdleHook) {
        let mut hooks = self.hooks.write().unwrap_or_else(|p| p.into_inner());
        let mut next: Vec<IdleHook> = hooks.iter().filter(|h| h.id != hook.id).cloned().collect();
        next.push(hook);
        next.sort_by_key(|h| h.order);
        *hooks = next.into();
    }

    pub fn remove(&self, id: &str) {
        let mut hooks = self.hooks.write().unwrap_or_else(|p| p.into_inner());
        *hooks = hooks.iter().filter(|h| h.id != id).cloned().collect();
    }

    /// Runs the hooks for a worker that just went idle. A hook that panics is
    /// logged and counts as "did not take the worker".
    pub fn run(&self, worker_id: &str) {
        let hooks = self.hooks.read().unwrap_or_else(|p| p.into_inner()).clone();
        for hook in hooks.iter() {
            match catch_unwind(AssertUnwindSafe(|| (hook.run)(worker_id))) {
                Ok(true) => return,
                Ok(false) => {}
                Err(payload) => {
                    tracing::error!(hook = hook.id, worker_id, panic = %panic_message(payload.as_ref()), "an idle hook panicked");
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn recording(ran: &Arc<Mutex<Vec<String>>>, id: &'static str, order: i32, takes: &'static str) -> IdleHook {
        let ran = ran.clone();
        IdleHook::new(id, order, move |worker| {
            ran.lock().expect("ran").push(format!("{id}:{worker}"));
            worker == takes
        })
    }

    #[test]
    fn runs_hooks_in_order_and_one_that_takes_the_worker_stops_the_rest() {
        let ran = Arc::new(Mutex::new(Vec::new()));
        let hooks = IdleHooks::default();
        hooks.add(recording(&ran, "b", 20, ""));
        hooks.add(recording(&ran, "a", 10, "busy"));
        hooks.add(recording(&ran, "c", 30, ""));
        hooks.run("w1");
        hooks.run("busy");
        assert_eq!(*ran.lock().expect("ran"), ["a:w1", "b:w1", "c:w1", "a:busy"]);
    }

    #[test]
    fn a_removed_hook_no_longer_runs_and_a_same_id_hook_replaces() {
        let ran = Arc::new(Mutex::new(Vec::new()));
        let hooks = IdleHooks::new([recording(&ran, "a", 1, ""), recording(&ran, "b", 2, "")]);
        hooks.remove("a");
        hooks.add(recording(&ran, "b", 0, "w1"));
        hooks.add(recording(&ran, "z", 5, ""));
        hooks.run("w1");
        assert_eq!(*ran.lock().expect("ran"), ["b:w1"]);
    }

    #[test]
    fn a_panicking_hook_does_not_stop_the_ones_after_it() {
        let ran = Arc::new(Mutex::new(Vec::new()));
        let hooks = IdleHooks::default();
        hooks.add(IdleHook::new("bad", 1, |_| panic!("hook bug")));
        hooks.add(recording(&ran, "good", 2, ""));
        hooks.run("w1");
        assert_eq!(*ran.lock().expect("ran"), ["good:w1"]);
    }
}
