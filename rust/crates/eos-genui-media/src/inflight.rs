//! One piece of work per key, however many ask for it at once.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};

type Flying<T> = Shared<BoxFuture<'static, Option<T>>>;

/// Concurrent asks for the same key share one run of the work. The work runs
/// as its own task, so it finishes (and its result is cached by whoever wrote
/// it) even when every caller has gone away, and a key leaves the table the
/// moment its work ends.
pub(crate) struct Inflight<T: Clone + Send + Sync + 'static> {
    flying: Arc<Mutex<HashMap<String, Flying<T>>>>,
    /// How many keys may be in flight; beyond it an ask is not started.
    limit: usize,
}

impl<T: Clone + Send + Sync + 'static> Inflight<T> {
    pub(crate) fn new(limit: usize) -> Self {
        Self { flying: Arc::default(), limit }
    }

    /// The result of `work` for `key`, shared with everyone asking meanwhile.
    /// `None` when the work panicked or the table is full.
    pub(crate) async fn once<F>(&self, key: &str, work: impl FnOnce() -> F) -> Option<T>
    where
        F: Future<Output = T> + Send + 'static,
    {
        let flying = {
            let mut table = self.flying.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(flying) = table.get(key) {
                flying.clone()
            } else {
                if table.len() >= self.limit {
                    return None;
                }
                let (owner, key_owned) = (self.flying.clone(), key.to_owned());
                let work = work();
                let task = tokio::spawn(async move {
                    let done = work.await;
                    owner.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&key_owned);
                    done
                });
                let (owner, key_owned) = (self.flying.clone(), key.to_owned());
                let flying: Flying<T> = async move {
                    match task.await {
                        Ok(done) => Some(done),
                        Err(_) => {
                            // The work panicked before it could leave the table.
                            owner.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&key_owned);
                            None
                        }
                    }
                }
                .boxed()
                .shared();
                table.insert(key.to_owned(), flying.clone());
                flying
            }
        };
        flying.await
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.flying.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn concurrent_asks_share_one_run_and_the_table_empties() {
        let inflight: Inflight<usize> = Inflight::new(2);
        let runs = Arc::new(AtomicUsize::new(0));
        let (release, gate) = tokio::sync::watch::channel(false);
        let work = |runs: Arc<AtomicUsize>, mut gate: tokio::sync::watch::Receiver<bool>| async move {
            let _ = gate.wait_for(|open| *open).await;
            runs.fetch_add(1, Ordering::SeqCst) + 1
        };
        let asks = async {
            tokio::join!(
                inflight.once("a", || work(runs.clone(), gate.clone())),
                inflight.once("a", || work(runs.clone(), gate.clone())),
                inflight.once("b", || work(runs.clone(), gate.clone())),
                // The table holds two keys: a third is not started.
                inflight.once("c", || work(runs.clone(), gate.clone())),
            )
        };
        let open = async {
            tokio::task::yield_now().await;
            release.send(true).expect("open");
        };
        let ((a1, a2, b, c), ()) = tokio::join!(asks, open);
        assert_eq!(a1, a2);
        assert!(a1.is_some() && b.is_some());
        assert_eq!(c, None);
        assert_eq!(runs.load(Ordering::SeqCst), 2);
        assert_eq!(inflight.len(), 0);
    }

    #[tokio::test]
    async fn work_finishes_when_its_caller_went_away() {
        let inflight: Inflight<u8> = Inflight::new(4);
        let (done, finished) = tokio::sync::oneshot::channel();
        let ask = inflight.once("k", || async move {
            tokio::task::yield_now().await;
            let _ = done.send(());
            1
        });
        // Polled once (the work is started), then dropped.
        assert_eq!(ask.now_or_never(), None);
        finished.await.expect("the work ran to its end");
        tokio::task::yield_now().await;
        assert_eq!(inflight.len(), 0);
    }
}
