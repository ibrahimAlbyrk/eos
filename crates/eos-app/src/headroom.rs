//! How much of the user's Claude plan is left (01 G28), from the usage the
//! accounts feature last fetched: never a request of its own.

use std::sync::Arc;

use eos_core::Clock;
use eos_core::accounts::UsageSnapshotStore;
use eos_core::routine::PlanHeadroom;
use eos_domain::time::ms_from_iso;

/// The usage cache's provider for a Claude plan.
const CLAUDE: &str = "claude";

pub(crate) struct CachedHeadroom {
    pub(crate) cache: Arc<dyn UsageSnapshotStore>,
    pub(crate) clock: Arc<dyn Clock>,
}

impl PlanHeadroom for CachedHeadroom {
    fn busy(&self, percent: i64) -> bool {
        let now = self.clock.now_ms();
        self.cache.load().iter().filter(|usage| usage.provider == CLAUDE).any(|usage| {
            let window = usage.windows.five_hour.as_ref().and_then(Option::as_ref);
            // The cache is fetched only when someone looks at usage, so a
            // window whose reset has passed has rolled over since.
            let window = window.filter(|window| {
                window.resets_at.as_deref().and_then(ms_from_iso).is_none_or(|resets_at| resets_at > now)
            });
            // The cache keeps utilization in percent, 0 to 100.
            window.is_some_and(|window| window.utilization.0 >= percent as f64)
        })
    }
}

#[cfg(test)]
mod tests {
    use eos_contracts::ProviderUsage;
    use eos_testkit::FakeClock;
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

    fn headroom(usages: Vec<ProviderUsage>, now: &str) -> CachedHeadroom {
        let clock = Arc::new(FakeClock::at(ms_from_iso(now).expect("a time")));
        CachedHeadroom { cache: Arc::new(Cache(usages)), clock }
    }

    #[test]
    fn the_plan_is_busy_from_the_set_share_of_the_cached_five_hour_window() {
        let now = "2026-11-20T10:00:00Z";
        let at = |utilization: f64| usage(CLAUDE, json!({"utilization": utilization, "resetsAt": null}));
        assert!(headroom(vec![at(80.0)], now).busy(80));
        assert!(!headroom(vec![at(79.5)], now).busy(80));
        assert!(!headroom(vec![], now).busy(80), "nothing fetched yet");
        assert!(!headroom(vec![usage(CLAUDE, json!(null))], now).busy(80));
        let other = usage("codex", json!({"utilization": 99, "resetsAt": null}));
        assert!(!headroom(vec![other], now).busy(80), "only the Claude plan runs routines");
    }

    #[test]
    fn a_cached_window_whose_reset_has_passed_leaves_room() {
        let window = usage(CLAUDE, json!({"utilization": 95, "resetsAt": "2026-11-20T12:00:00Z"}));
        assert!(headroom(vec![window.clone()], "2026-11-20T11:59:00Z").busy(80));
        assert!(!headroom(vec![window], "2026-11-20T12:00:00Z").busy(80), "the window rolled over");
    }
}
