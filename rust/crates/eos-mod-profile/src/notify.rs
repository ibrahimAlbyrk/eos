//! One banner for a burst of suggestions
//! (`manager/services/memory-suggest-notify.ts`). Agents may suggest several
//! memories in a row; the user gets one notification a little later
//! ("Agents noticed 3 things") counting whatever is still waiting. Clicking
//! it opens the Memory view.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use eos_contracts::stream::topics;
use eos_contracts::{
    UserMemoryChangeEvent, UserMemoryChangeEventAction, UserMemoryChangeEventBy, UserMemorySource, UserMemoryStatus,
};
use eos_core::Clock;
use eos_runtime::bus::{Bus, Subscription};
use serde::Serialize;

use crate::USER_MEMORY_CHANGE;
use crate::memories::UserMemoryService;

/// How long after the first suggestion the banner goes out.
pub const MEMORY_NOTIFY_DELAY: Duration = Duration::from_secs(30);

/// The payload of `notification:fire`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Notification {
    title: String,
    body: &'static str,
    worker_id: &'static str,
    /// The view to open on click.
    route: &'static str,
    ts: i64,
}

/// Waiting agent suggestions. A dream announces its own proposals with its
/// morning note.
fn pending(memories: &UserMemoryService) -> usize {
    let waiting = |m: &Arc<eos_contracts::UserMemory>| {
        m.status == UserMemoryStatus::Suggested && !matches!(m.source, UserMemorySource::Dream(_))
    };
    memories.list().iter().filter(|m| waiting(m)).count()
}

/// Subscribes to memory changes; the returned subscription ends the watch.
/// Must be called inside the async runtime: the delay is one of its timers.
pub(crate) fn watch(bus: &Bus, memories: Arc<UserMemoryService>, clock: Arc<dyn Clock>) -> Subscription {
    let timers = tokio::runtime::Handle::current();
    let armed = Arc::new(AtomicBool::new(false));
    let out = bus.clone();
    bus.on(&USER_MEMORY_CHANGE, move |event| {
        let Ok(change) = event.payload_as::<UserMemoryChangeEvent>() else { return };
        // The computer that made a synced suggestion already announced it.
        let from_an_agent = change.action == UserMemoryChangeEventAction::Created
            && change.status == UserMemoryStatus::Suggested
            && !matches!(change.by, UserMemoryChangeEventBy::Dream | UserMemoryChangeEventBy::Sync);
        if !from_an_agent || armed.swap(true, Ordering::SeqCst) {
            return;
        }
        let (armed, memories, clock, out) = (armed.clone(), memories.clone(), clock.clone(), out.clone());
        timers.spawn(async move {
            tokio::time::sleep(MEMORY_NOTIFY_DELAY).await;
            armed.store(false, Ordering::SeqCst);
            let waiting = pending(&memories);
            if waiting == 0 {
                return;
            }
            let title = if waiting == 1 {
                "An agent noticed something".to_owned()
            } else {
                format!("Agents noticed {waiting} things")
            };
            let notification = Notification {
                title,
                body: "Review it before it's remembered.",
                worker_id: "",
                route: "memory",
                ts: clock.now_ms(),
            };
            match serde_json::to_vec(&notification) {
                Ok(json) => out.publish_raw(topics::NOTIFICATION_FIRE, None, json.into()),
                Err(e) => tracing::error!(error = %e, "the memory notification could not be written"),
            }
        });
    })
}
