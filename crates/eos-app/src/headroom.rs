//! How much of the user's Claude plan is left (01 G28), from the usage the
//! accounts feature last fetched: never a request of its own.

use std::sync::Arc;

use eos_core::accounts::UsageSnapshotStore;
use eos_core::routine::PlanHeadroom;

/// The usage cache's provider for a Claude plan.
const CLAUDE: &str = "claude";

pub(crate) struct CachedHeadroom(pub(crate) Arc<dyn UsageSnapshotStore>);

impl PlanHeadroom for CachedHeadroom {
    fn busy(&self, percent: i64) -> bool {
        self.0.load().iter().filter(|usage| usage.provider == CLAUDE).any(|usage| {
            let window = usage.windows.five_hour.as_ref().and_then(Option::as_ref);
            // The cache keeps utilization in percent, 0 to 100.
            window.is_some_and(|window| window.utilization.0 >= percent as f64)
        })
    }
}

#[cfg(test)]
mod tests {
    use eos_contracts::ProviderUsage;
    use serde_json::json;

    use super::*;

    struct Cache(Vec<ProviderUsage>);

    impl UsageSnapshotStore for Cache {
        fn load(&self) -> Vec<ProviderUsage> {
            self.0.clone()
        }

        fn save(&self, _snapshots: &[ProviderUsage]) -> Result<(), eos_core::Error> {
            Ok(())
        }
    }

    fn usage(provider: &str, five_hour: serde_json::Value) -> ProviderUsage {
        serde_json::from_value(json!({"provider": provider, "windows": {"fiveHour": five_hour},
                                      "fetchedAt": "2026-11-20T10:00:00Z"}))
        .expect("a usage")
    }

    #[test]
    fn the_plan_is_busy_from_the_set_share_of_the_cached_five_hour_window() {
        let at = |utilization: f64| usage(CLAUDE, json!({"utilization": utilization, "resetsAt": null}));
        assert!(CachedHeadroom(Arc::new(Cache(vec![at(80.0)]))).busy(80));
        assert!(!CachedHeadroom(Arc::new(Cache(vec![at(79.5)]))).busy(80));
        assert!(!CachedHeadroom(Arc::new(Cache(vec![]))).busy(80), "nothing fetched yet");
        assert!(!CachedHeadroom(Arc::new(Cache(vec![usage(CLAUDE, json!(null))]))).busy(80));
        let other = usage("codex", json!({"utilization": 99, "resetsAt": null}));
        assert!(!CachedHeadroom(Arc::new(Cache(vec![other]))).busy(80), "only the Claude plan runs routines");
    }
}
