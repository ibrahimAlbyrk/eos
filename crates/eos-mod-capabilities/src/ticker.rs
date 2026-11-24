//! The health ticker: one loop over the clock and the sleeper. Each
//! capability is checked once an hour at its own minute, from its id, so
//! the checks spread over the hour; a call the service refused for its sign-in, or
//! whose answer broke its shape, wakes the loop for an early check of that
//! capability. One switched off, or not installed here, is not checked, and
//! neither is one no routine needs: checking the Mail app opens Mail and asks
//! the user for Automation, which only a routine that reads mail may cause.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use eos_capabilities::CapabilityService;
use eos_core::capability::CapabilityRegistry;
use eos_core::store::Store;
use eos_core::{Clock, Sleeper};
use eos_domain::capability::health::HealthState;
use tokio::task::JoinHandle;

use crate::routes::users;

/// How often a capability is checked.
pub const CHECK_EVERY_MS: i64 = 60 * 60 * 1000;
/// How often the loop looks for a check that is due.
pub const TICK_MS: i64 = 60 * 1000;

/// Where in the hour `id` is checked: the same for every run.
fn slot(id: &str) -> i64 {
    let hash = id.bytes().fold(0_u64, |hash, byte| hash.wrapping_mul(31).wrapping_add(u64::from(byte)));
    let slots = (CHECK_EVERY_MS / TICK_MS) as u64;
    (hash % slots) as i64 * TICK_MS
}

fn checked(state: HealthState) -> bool {
    !matches!(state, HealthState::Disabled | HealthState::Available)
}

/// The running loop, from the app's ready to its stop.
#[derive(Debug, Default)]
pub(crate) struct Ticker {
    task: Mutex<Option<JoinHandle<()>>>,
}

impl Ticker {
    pub(crate) fn start(
        &self,
        service: Arc<CapabilityService>,
        store: Arc<dyn Store>,
        clock: Arc<dyn Clock>,
        sleeper: Arc<dyn Sleeper>,
    ) {
        let task = tokio::spawn(run(service, store, clock, sleeper));
        if let Some(previous) = self.task.lock().unwrap_or_else(|p| p.into_inner()).replace(task) {
            previous.abort();
        }
    }

    /// Ends the loop and waits until it let go of the service: an aborted
    /// task drops what it holds only at its next poll, which may come after
    /// the app has shut down.
    pub(crate) async fn stop(&self) {
        let task = self.task.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(task) = task {
            task.abort();
            let _ = task.await;
        }
    }
}

async fn run(service: Arc<CapabilityService>, store: Arc<dyn Store>, clock: Arc<dyn Clock>, sleeper: Arc<dyn Sleeper>) {
    // When each capability's next hourly check is due.
    let mut due: HashMap<String, i64> = HashMap::new();
    loop {
        let early = tokio::select! {
            () = sleeper.sleep(TICK_MS) => Vec::new(),
            early = service.early_checks() => early,
        };
        let now = clock.now_ms();
        let capabilities = match service.list().await {
            Ok(capabilities) => capabilities,
            Err(e) => {
                tracing::warn!(error = %e, "the capabilities could not be read for their checks");
                continue;
            }
        };
        let users = match store.read(users).await {
            Ok(users) => users,
            Err(e) => {
                tracing::warn!(error = %e, "the routines that need a capability could not be read for its checks");
                continue;
            }
        };
        let watched = |id: &str, state| checked(state) && (users.contains_key(id) || early.iter().any(|e| e == id));
        due.retain(|id, _| {
            capabilities.iter().any(|capability| &capability.id == id && watched(id, capability.health.state))
        });
        for capability in capabilities.iter().filter(|capability| watched(&capability.id, capability.health.state)) {
            let next = due.entry(capability.id.clone()).or_insert_with(|| {
                let this_hour = now - now % CHECK_EVERY_MS + slot(&capability.id);
                if this_hour > now { this_hour } else { this_hour + CHECK_EVERY_MS }
            });
            let hourly = now >= *next;
            while *next <= now {
                *next += CHECK_EVERY_MS;
            }
            if hourly || early.contains(&capability.id) {
                let started = clock.now_ms();
                match service.check(&capability.id).await {
                    Ok(health) => tracing::info!(
                        capability = %capability.id,
                        state = health.state.as_str(),
                        early = !hourly,
                        duration_ms = clock.now_ms() - started,
                        "capability checked"
                    ),
                    Err(e) => tracing::warn!(capability = %capability.id, error = %e, "a capability check failed"),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_capability_has_its_own_minute_in_the_hour() {
        let slots: Vec<i64> = ["github", "mail", "notify", "notes-db"].iter().map(|id| slot(id)).collect();
        assert!(slots.iter().all(|slot| (0..CHECK_EVERY_MS).contains(slot) && slot % TICK_MS == 0), "{slots:?}");
        assert_ne!(slot("github"), slot("mail"));
    }
}
