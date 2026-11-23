//! How often the core's own timers wake it: every wait a service asks of the
//! sleeper port and that runs out is counted, by its length in whole seconds.
//! A wait cut short (another branch of a `select!` won) woke nothing and is not
//! counted. The idle measurement (`host/tests/memory.py --idle`) reads the
//! counts from the shell's status and holds them to the bounds of the plan's
//! idle cost (a loop wakes at most once a minute).

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, PoisonError};

use eos_core::{BoxFuture, Sleeper};
use serde_json::{Value, json};

/// Distinct wait lengths kept apart; longer tails share the last key.
const KEPT_LENGTHS: usize = 64;
/// The key of the waits beyond [`KEPT_LENGTHS`].
const OTHER: i64 = -1;

/// The counts, shared by the sleeper and whoever reads them.
#[derive(Debug, Clone, Default)]
pub struct WakeCounter(Arc<Mutex<BTreeMap<i64, u64>>>);

impl WakeCounter {
    fn count(&self, ms: i64) {
        let mut counts = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let seconds = ms.max(0) / 1000;
        let key = if counts.len() < KEPT_LENGTHS || counts.contains_key(&seconds) { seconds } else { OTHER };
        *counts.entry(key).or_default() += 1;
    }

    /// `{"total": n, "bySeconds": {"60": n, …}}`; `"-1"` holds the lengths
    /// past the kept ones.
    #[must_use]
    pub fn snapshot(&self) -> Value {
        let counts = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let by: serde_json::Map<String, Value> = counts.iter().map(|(s, n)| (s.to_string(), json!(n))).collect();
        json!({ "total": counts.values().sum::<u64>(), "bySeconds": by })
    }
}

/// The app's sleeper, counting each wait that runs out.
pub(crate) struct CountingSleeper {
    inner: Arc<dyn Sleeper>,
    counter: WakeCounter,
}

impl CountingSleeper {
    pub(crate) fn new(inner: Arc<dyn Sleeper>, counter: WakeCounter) -> Self {
        Self { inner, counter }
    }
}

impl Sleeper for CountingSleeper {
    fn sleep(&self, ms: i64) -> BoxFuture<'static, ()> {
        let (wait, counter) = (self.inner.sleep(ms), self.counter.clone());
        Box::pin(async move {
            wait.await;
            counter.count(ms);
        })
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    struct Instant;

    impl Sleeper for Instant {
        fn sleep(&self, _ms: i64) -> BoxFuture<'static, ()> {
            Box::pin(std::future::ready(()))
        }
    }

    struct Never;

    impl Sleeper for Never {
        fn sleep(&self, _ms: i64) -> BoxFuture<'static, ()> {
            Box::pin(std::future::pending())
        }
    }

    #[tokio::test]
    async fn a_wait_that_runs_out_counts_by_its_seconds() {
        let counter = WakeCounter::default();
        let sleeper = CountingSleeper::new(Arc::new(Instant), counter.clone());
        sleeper.sleep(60_000).await;
        sleeper.sleep(60_400).await;
        sleeper.sleep(15_000).await;
        assert_eq!(counter.snapshot(), json!({"total": 3, "bySeconds": {"15": 1, "60": 2}}));
    }

    #[tokio::test]
    async fn a_wait_cut_short_woke_nothing() {
        let counter = WakeCounter::default();
        let sleeper = CountingSleeper::new(Arc::new(Never), counter.clone());
        let cut = tokio::time::timeout(Duration::from_millis(5), sleeper.sleep(60_000)).await;
        assert!(cut.is_err());
        assert_eq!(counter.snapshot()["total"], 0);
    }

    #[test]
    fn lengths_past_the_kept_ones_share_one_key() {
        let counter = WakeCounter::default();
        for seconds in 0..=KEPT_LENGTHS as i64 + 1 {
            counter.count(seconds * 1000);
        }
        let snapshot = counter.snapshot();
        assert_eq!(snapshot["total"], KEPT_LENGTHS as u64 + 2);
        assert_eq!(snapshot["bySeconds"]["-1"], 2);
    }
}
