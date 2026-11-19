//! Checks asked for ahead of the hourly one: a call the service refused for
//! its sign-in, or whose answer broke its declared shape, may mean the
//! capability changed, and a check says so sooner than the next hour.

use std::sync::Mutex;

use eos_domain::capability::health::Event;
use tokio::sync::Notify;

use crate::CapabilityService;

#[derive(Debug, Default)]
pub(crate) struct EarlyChecks {
    queued: Mutex<Vec<String>>,
    signal: Notify,
}

impl EarlyChecks {
    /// Queues a check of `id` when `event` asks for one.
    pub(crate) fn after(&self, id: &str, event: Option<&Event>) {
        if !matches!(event, Some(Event::Unauthorized | Event::BadOutput)) {
            return;
        }
        let mut queued = self.queued.lock().unwrap_or_else(|p| p.into_inner());
        if !queued.iter().any(|queued| queued == id) {
            queued.push(id.to_owned());
        }
        drop(queued);
        self.signal.notify_one();
    }

    fn take(&self) -> Vec<String> {
        std::mem::take(&mut *self.queued.lock().unwrap_or_else(|p| p.into_inner()))
    }
}

impl CapabilityService {
    /// Waits until a call asked for an early check, and answers the
    /// capabilities to check. Dropped while it waits, it loses nothing.
    pub async fn early_checks(&self) -> Vec<String> {
        loop {
            let queued = self.early.take();
            if !queued.is_empty() {
                return queued;
            }
            self.early.signal.notified().await;
        }
    }
}
