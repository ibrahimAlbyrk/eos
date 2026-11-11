//! A subscriber that reads events at its own pace, through a bounded queue.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use tokio::sync::mpsc;

use super::{Bus, Event, Filter, Subscription};

/// Why `recv` returned no event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum RecvError {
    /// The queue was full and this many events were dropped for this
    /// subscriber. What it holds may be stale: re-read the state the events
    /// describe, then keep receiving.
    #[error("the subscriber fell behind: {0} events were dropped")]
    Lagged(u64),
    /// The bus is gone.
    #[error("the bus is gone")]
    Closed,
}

/// Events through a bounded queue. A subscriber that falls more than the
/// queue's capacity behind loses events — it never slows the bus or grows
/// without bound — and is told so with [`RecvError::Lagged`]. Dropping the
/// receiver ends the subscription.
#[derive(Debug)]
pub struct EventReceiver {
    rx: mpsc::Receiver<Event>,
    missed: Arc<AtomicU64>,
    _subscription: Subscription,
}

impl EventReceiver {
    pub(super) fn new(bus: &Bus, filter: Filter, capacity: usize) -> Self {
        let (tx, rx) = mpsc::channel(capacity.max(1));
        let missed = Arc::new(AtomicU64::new(0));
        let counter = missed.clone();
        let subscription = bus.on(filter, move |ev| {
            if tx.try_send(ev.clone()).is_err() {
                counter.fetch_add(1, Ordering::Relaxed);
            }
        });
        Self { rx, missed, _subscription: subscription }
    }

    /// The next event. A lag is reported once, ahead of the events still queued.
    pub async fn recv(&mut self) -> Result<Event, RecvError> {
        let missed = self.missed.swap(0, Ordering::Relaxed);
        if missed > 0 {
            return Err(RecvError::Lagged(missed));
        }
        self.rx.recv().await.ok_or(RecvError::Closed)
    }
}
