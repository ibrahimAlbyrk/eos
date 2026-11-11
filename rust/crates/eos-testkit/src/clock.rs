use std::sync::atomic::{AtomicI64, Ordering};

use eos_core::Clock;

/// A clock that stands still until the test moves it.
#[derive(Debug)]
pub struct FakeClock(AtomicI64);

impl FakeClock {
    /// 2027-01-15T08:00:00Z: later than every seeded row, so "now" sorts last.
    pub const START_MS: i64 = 1_800_000_000_000;

    pub fn new() -> Self {
        Self::at(Self::START_MS)
    }

    pub fn at(now_ms: i64) -> Self {
        Self(AtomicI64::new(now_ms))
    }

    pub fn set(&self, now_ms: i64) {
        self.0.store(now_ms, Ordering::SeqCst);
    }

    /// Moves time forward and returns the new time.
    pub fn advance(&self, ms: i64) -> i64 {
        self.0.fetch_add(ms, Ordering::SeqCst) + ms
    }
}

impl Default for FakeClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for FakeClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_only_when_told() {
        let clock = FakeClock::new();
        assert_eq!(clock.now_ms(), FakeClock::START_MS);
        assert_eq!(clock.advance(250), FakeClock::START_MS + 250);
        assert_eq!(clock.now_ms(), FakeClock::START_MS + 250);
        clock.set(5);
        assert_eq!(clock.now_ms(), 5);
    }
}
