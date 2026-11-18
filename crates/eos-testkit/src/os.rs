//! What the system lends a routine: work holds, the power report, the Dock badge, time zones.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use eos_core::os::{AwakeHold, DockBadge, HoldReason, Power, PowerStatus, WorkHold, ZoneRules};

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Counts the holds still alive, per reason. Starts nothing.
#[derive(Debug, Default)]
pub struct FakeWorkHold {
    live: Arc<Mutex<HashMap<HoldReason, usize>>>,
}

struct Hold {
    why: HoldReason,
    live: Arc<Mutex<HashMap<HoldReason, usize>>>,
}

impl AwakeHold for Hold {}

impl Drop for Hold {
    fn drop(&mut self) {
        if let Some(count) = locked(&self.live).get_mut(&self.why) {
            *count -= 1;
        }
    }
}

impl FakeWorkHold {
    pub fn new() -> Self {
        Self::default()
    }

    /// Holds of `why` not dropped yet.
    pub fn live(&self, why: HoldReason) -> usize {
        locked(&self.live).get(&why).copied().unwrap_or(0)
    }
}

impl WorkHold for FakeWorkHold {
    fn begin(&self, why: HoldReason) -> Option<Box<dyn AwakeHold>> {
        *locked(&self.live).entry(why).or_default() += 1;
        Some(Box::new(Hold { why, live: self.live.clone() }))
    }
}

/// A power report the test sets; mains power with no battery until it does.
#[derive(Debug, Default)]
pub struct FakePower(Mutex<PowerStatus>);

impl FakePower {
    pub fn new(status: PowerStatus) -> Self {
        Self(Mutex::new(status))
    }

    pub fn set(&self, status: PowerStatus) {
        *locked(&self.0) = status;
    }
}

impl Power for FakePower {
    fn status(&self) -> PowerStatus {
        *locked(&self.0)
    }
}

/// Keeps the number last put on the Dock icon.
#[derive(Debug, Default)]
pub struct FakeDockBadge(Mutex<Option<u32>>);

impl FakeDockBadge {
    pub fn new() -> Self {
        Self::default()
    }

    /// The number on the icon; `None` when it shows none.
    pub fn shown(&self) -> Option<u32> {
        *locked(&self.0)
    }
}

impl DockBadge for FakeDockBadge {
    fn set(&self, count: Option<u32>) {
        *locked(&self.0) = count;
    }
}

/// Time zones with fixed offsets, each with at most one daylight-saving change, and the zone
/// of the user's clock. Knows only `UTC`, the user's zone, until the test adds more.
#[derive(Debug, Clone)]
pub struct FakeZoneRules {
    local: String,
    zones: HashMap<String, Offsets>,
}

#[derive(Debug, Clone, Copy)]
struct Offsets {
    before: i32,
    change_at_ms: i64,
    after: i32,
}

impl FakeZoneRules {
    pub fn new() -> Self {
        Self { local: "UTC".to_owned(), zones: HashMap::new() }.fixed("UTC", 0)
    }

    /// The user's clock is in `zone`.
    pub fn local(mut self, zone: &str) -> Self {
        zone.clone_into(&mut self.local);
        self
    }

    /// `zone` is `offset_minutes` east of UTC at every instant.
    pub fn fixed(self, zone: &str, offset_minutes: i32) -> Self {
        self.changing(zone, offset_minutes, i64::MAX, offset_minutes)
    }

    /// `zone` is `before` minutes east of UTC until `change_at_ms`, and `after` from then on.
    pub fn changing(mut self, zone: &str, before: i32, change_at_ms: i64, after: i32) -> Self {
        self.zones.insert(zone.to_owned(), Offsets { before, change_at_ms, after });
        self
    }
}

impl Default for FakeZoneRules {
    fn default() -> Self {
        Self::new()
    }
}

impl ZoneRules for FakeZoneRules {
    fn offset_minutes_at(&self, zone: &str, epoch_ms: i64) -> Option<i32> {
        let zone = self.zones.get(zone)?;
        Some(if epoch_ms < zone.change_at_ms { zone.before } else { zone.after })
    }

    fn known(&self, zone: &str) -> bool {
        self.zones.contains_key(zone)
    }

    fn local_name(&self) -> String {
        self.local.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn holds_are_counted_per_reason_until_dropped() {
        let holds = FakeWorkHold::new();
        let run = holds.begin(HoldReason::Run);
        let armed = [holds.begin(HoldReason::Armed), holds.begin(HoldReason::Armed)];
        assert_eq!((holds.live(HoldReason::Run), holds.live(HoldReason::Armed)), (1, 2));
        drop(armed);
        assert_eq!((holds.live(HoldReason::Run), holds.live(HoldReason::Armed)), (1, 0));
        drop(run);
        assert_eq!(holds.live(HoldReason::Run), 0);
    }

    #[test]
    fn power_and_badge_answer_what_was_set() {
        let power = FakePower::default();
        assert_eq!(power.status(), PowerStatus::default());
        let low = PowerStatus { on_battery: true, battery_percent: Some(12), low_power: true };
        power.set(low);
        assert_eq!(power.status(), low);

        let badge = FakeDockBadge::new();
        badge.set(Some(3));
        assert_eq!(badge.shown(), Some(3));
        badge.set(None);
        assert_eq!(badge.shown(), None);
    }

    #[test]
    fn zones_change_their_offset_once_at_the_given_instant() {
        let zones = FakeZoneRules::new().local("Europe/London").changing("Europe/London", 0, 1_000, 60);
        assert_eq!(zones.local_name(), "Europe/London");
        assert_eq!(zones.offset_minutes_at("Europe/London", 999), Some(0));
        assert_eq!(zones.offset_minutes_at("Europe/London", 1_000), Some(60));
        assert_eq!(zones.offset_minutes_at("UTC", i64::MAX), Some(0));
        assert!(zones.known("UTC") && !zones.known("Mars/Base"));
        assert_eq!(zones.offset_minutes_at("Mars/Base", 0), None);
    }
}
