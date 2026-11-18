//! What the system lends a routine: work holds, the power report, the Dock badge.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use eos_core::os::{AwakeHold, DockBadge, HoldReason, Power, PowerStatus, WorkHold};

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
}
