//! What powers the computer, asked of the system at most once a minute.

use std::sync::Mutex;

/// How long one answer of the system is used.
const FRESH_MS: i64 = 60_000;

/// The power source and energy saving the system reports.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PowerReading {
    /// It draws from a battery (its own, or a UPS), not from mains.
    pub on_battery: bool,
    /// How full its own battery is; `None` without one.
    pub battery_percent: Option<u8>,
    /// Low Power Mode is on.
    pub low_power: bool,
}

/// [`HostPlatform::power`](crate::HostPlatform::power), asked again once its last answer is a
/// minute old. A system that does not say reads as mains power with no battery.
#[derive(Debug, Default)]
pub struct PowerCache {
    last: Mutex<Option<(i64, PowerReading)>>,
}

impl PowerCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// The reading at `now_ms` on the caller's clock. A stale one runs a system tool: call it
    /// from a blocking thread. An answer from after `now_ms` (the clock was set back) is stale.
    pub fn status(&self, now_ms: i64) -> PowerReading {
        self.status_from(now_ms, || crate::host().power())
    }

    fn status_from(&self, now_ms: i64, ask: impl FnOnce() -> Option<PowerReading>) -> PowerReading {
        let mut last = self.last.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((at, reading)) = *last
            && (at..at.saturating_add(FRESH_MS)).contains(&now_ms)
        {
            return reading;
        }
        let reading = ask().unwrap_or_default();
        *last = Some((now_ms, reading));
        reading
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    const AT: i64 = 1_800_000_000_000;

    #[test]
    fn the_system_is_asked_again_only_after_a_minute() {
        let cache = PowerCache::new();
        let asked = &Cell::new(0);
        let reading = |percent: u8| {
            move || {
                asked.set(asked.get() + 1);
                Some(PowerReading { on_battery: true, battery_percent: Some(percent), low_power: false })
            }
        };
        assert_eq!(cache.status_from(AT, reading(80)).battery_percent, Some(80));
        assert_eq!(cache.status_from(AT + FRESH_MS - 1, reading(79)).battery_percent, Some(80));
        assert_eq!(asked.get(), 1);
        assert_eq!(cache.status_from(AT + FRESH_MS, reading(78)).battery_percent, Some(78));
        assert_eq!(asked.get(), 2);
    }

    #[test]
    fn a_clock_set_back_asks_again() {
        let cache = PowerCache::new();
        cache.status_from(AT, || Some(PowerReading { on_battery: true, ..PowerReading::default() }));
        let low = PowerReading { low_power: true, ..PowerReading::default() };
        assert_eq!(cache.status_from(AT - 3_600_000, || Some(low)), low);
    }

    #[test]
    fn a_system_that_does_not_say_reads_as_mains_power() {
        let cache = PowerCache::new();
        assert_eq!(cache.status_from(AT, || None), PowerReading::default());
        assert!(!PowerReading::default().on_battery);
    }
}
