//! What runs when a worker settles at IDLE with nothing left in its queue —
//! compaction, the goal loop, the report and context nudges, a feature's own —
//! in `order`. A hook that answers `true` has taken the worker (it is working
//! again), so the hooks after it wait for its next IDLE.
//!
//! A hook is asynchronous because deciding takes a database read; the hooks
//! of one idle edge still run one after the other.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, RwLock};

use crate::error::panic_message;
use crate::module::FailedModules;
use crate::router::BoxFuture;

type Decide = dyn Fn(&str) -> BoxFuture<'static, bool> + Send + Sync;

#[derive(Clone)]
pub struct IdleHook {
    pub id: &'static str,
    /// Lower runs first (today: compaction 10, goal loop 20, report gap 30,
    /// context threshold 40).
    pub order: i32,
    /// The module that added it; its hook does not run once its start failed.
    owner: &'static str,
    run: Arc<Decide>,
}

impl IdleHook {
    /// `run` gets the worker id and answers whether it took the worker.
    pub fn new<F>(id: &'static str, order: i32, run: impl Fn(&str) -> F + Send + Sync + 'static) -> Self
    where
        F: Future<Output = bool> + Send + 'static,
    {
        Self { id, order, owner: "kernel", run: Arc::new(move |worker_id| Box::pin(run(worker_id))) }
    }

    pub(crate) fn owned_by(mut self, module: &'static str) -> Self {
        self.owner = module;
        self
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
    failed: Arc<FailedModules>,
}

impl IdleHooks {
    pub fn new(hooks: impl IntoIterator<Item = IdleHook>) -> Self {
        let all = Self::default();
        for hook in hooks {
            all.add(hook);
        }
        all
    }

    /// The hooks of a module whose start failed are skipped.
    pub(crate) fn skipping(mut self, failed: Arc<FailedModules>) -> Self {
        self.failed = failed;
        self
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
    pub async fn run(&self, worker_id: &str) {
        let hooks = self.hooks.read().unwrap_or_else(|p| p.into_inner()).clone();
        for hook in hooks.iter().filter(|hook| !self.failed.is_failed(hook.owner)) {
            let failed = |panic: &str| tracing::error!(hook = hook.id, worker_id, panic, "an idle hook panicked");
            let deciding = match catch_unwind(AssertUnwindSafe(|| (hook.run)(worker_id))) {
                Ok(deciding) => deciding,
                Err(payload) => {
                    failed(&panic_message(payload.as_ref()));
                    continue;
                }
            };
            // In a task of its own: a panic while it decides ends only this hook.
            match tokio::spawn(deciding).await {
                Ok(true) => return,
                Ok(false) => {}
                Err(e) if e.is_panic() => failed(&panic_message(e.into_panic().as_ref())),
                Err(_) => return,
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
            std::future::ready(worker == takes)
        })
    }

    #[tokio::test]
    async fn runs_hooks_in_order_and_one_that_takes_the_worker_stops_the_rest() {
        let ran = Arc::new(Mutex::new(Vec::new()));
        let hooks = IdleHooks::default();
        hooks.add(recording(&ran, "b", 20, ""));
        hooks.add(recording(&ran, "a", 10, "busy"));
        hooks.add(recording(&ran, "c", 30, ""));
        hooks.run("w1").await;
        hooks.run("busy").await;
        assert_eq!(*ran.lock().expect("ran"), ["a:w1", "b:w1", "c:w1", "a:busy"]);
    }

    #[tokio::test]
    async fn a_removed_hook_no_longer_runs_and_a_same_id_hook_replaces() {
        let ran = Arc::new(Mutex::new(Vec::new()));
        let hooks = IdleHooks::new([recording(&ran, "a", 1, ""), recording(&ran, "b", 2, "")]);
        hooks.remove("a");
        hooks.add(recording(&ran, "b", 0, "w1"));
        hooks.add(recording(&ran, "z", 5, ""));
        hooks.run("w1").await;
        assert_eq!(*ran.lock().expect("ran"), ["b:w1"]);
    }

    #[tokio::test]
    async fn a_panicking_hook_does_not_stop_the_ones_after_it() {
        let ran = Arc::new(Mutex::new(Vec::new()));
        let hooks = IdleHooks::default();
        hooks.add(IdleHook::new("bad", 1, |_| -> std::future::Ready<bool> { panic!("hook bug") }));
        hooks.add(IdleHook::new("worse", 1, |_| async { panic!("hook bug while deciding") }));
        hooks.add(recording(&ran, "good", 2, ""));
        hooks.run("w1").await;
        assert_eq!(*ran.lock().expect("ran"), ["good:w1"]);
    }
}
