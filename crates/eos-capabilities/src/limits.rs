//! How many calls run at once: [`PER_CAPABILITY`] per capability with
//! [`WAITING_MAX`] more waiting behind them, then `Busy`; [`OVERALL`] across
//! every capability. A slot is a semaphore permit held for the call's run,
//! never a lock.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use eos_core::capability::ActionError;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub(crate) const PER_CAPABILITY: usize = 4;
pub(crate) const WAITING_MAX: usize = 64;
pub(crate) const OVERALL: usize = 16;

/// One capability's slots and the calls waiting for one.
struct Lane {
    running: Arc<Semaphore>,
    waiting: AtomicUsize,
}

/// Counts a call as waiting until it is dropped: a call given up while it
/// waits stops counting too.
struct Waiting<'a>(&'a AtomicUsize);

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// A call's place: released when dropped.
#[derive(Debug)]
pub(crate) struct Slot {
    _lane: OwnedSemaphorePermit,
    _overall: OwnedSemaphorePermit,
}

pub(crate) struct Limits {
    overall: Arc<Semaphore>,
    // One lane per capability called: as many as there are capabilities.
    lanes: Mutex<HashMap<String, Arc<Lane>>>,
}

impl Default for Limits {
    fn default() -> Self {
        Self { overall: Arc::new(Semaphore::new(OVERALL)), lanes: Mutex::default() }
    }
}

impl Limits {
    /// Waits for a slot of capability `id`; `Busy` when too many wait already.
    pub(crate) async fn acquire(&self, id: &str) -> Result<Slot, ActionError> {
        let lane = {
            let mut lanes = self.lanes.lock().unwrap_or_else(|p| p.into_inner());
            let lane = lanes.entry(id.to_owned()).or_insert_with(|| {
                Arc::new(Lane { running: Arc::new(Semaphore::new(PER_CAPABILITY)), waiting: AtomicUsize::new(0) })
            });
            lane.clone()
        };
        let own = match lane.running.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                if lane.waiting.fetch_add(1, Ordering::SeqCst) >= WAITING_MAX {
                    lane.waiting.fetch_sub(1, Ordering::SeqCst);
                    return Err(ActionError::Busy);
                }
                let _waiting = Waiting(&lane.waiting);
                lane.running.clone().acquire_owned().await.map_err(|_| ActionError::Busy)?
            }
        };
        let overall = self.overall.clone().acquire_owned().await.map_err(|_| ActionError::Busy)?;
        Ok(Slot { _lane: own, _overall: overall })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    impl Limits {
        fn waiting(&self, id: &str) -> usize {
            let lanes = self.lanes.lock().expect("lanes");
            lanes.get(id).map_or(0, |lane| lane.waiting.load(Ordering::SeqCst))
        }
    }

    #[tokio::test]
    async fn sixteen_run_at_once_across_capabilities() {
        let limits = Limits::default();
        let mut slots = Vec::new();
        for i in 0..OVERALL {
            slots.push(limits.acquire(&format!("cap-{}", i / PER_CAPABILITY)).await.expect("a slot"));
        }
        let next = limits.acquire("another");
        let waited = tokio::time::timeout(std::time::Duration::from_millis(50), next).await;
        assert!(waited.is_err(), "the seventeenth waits");
        slots.pop();
        limits.acquire("another").await.expect("a slot once one is free");
    }

    #[tokio::test]
    async fn four_run_64_wait_and_the_next_is_busy_until_a_wait_is_given_up() {
        let limits = Arc::new(Limits::default());
        let mut running = Vec::new();
        for _ in 0..PER_CAPABILITY {
            running.push(limits.acquire("cap").await.expect("a slot at once"));
        }
        let waiting: Vec<_> = (0..WAITING_MAX)
            .map(|_| {
                let limits = limits.clone();
                tokio::spawn(async move { limits.acquire("cap").await.map(drop) })
            })
            .collect();
        while limits.waiting("cap") < WAITING_MAX {
            tokio::task::yield_now().await;
        }
        assert!(matches!(limits.acquire("cap").await, Err(ActionError::Busy)));
        assert!(limits.acquire("other").await.is_ok(), "another capability has its own slots");

        waiting[0].abort();
        while limits.waiting("cap") == WAITING_MAX {
            tokio::task::yield_now().await;
        }
        let given_up = tokio::time::timeout(std::time::Duration::from_millis(20), limits.acquire("cap")).await;
        assert!(given_up.is_err(), "the place it gave up is taken by a new wait, not refused");

        running.clear();
        for call in waiting.into_iter().skip(1) {
            call.await.expect("joins").expect("each waiting call gets a slot");
        }
    }
}
