//! Time, as a port: nothing above the adapters reads the system clock.

use std::time::{SystemTime, UNIX_EPOCH};

/// Wall-clock time in epoch milliseconds — the unit of every stored and wired
/// timestamp (`started_at`, `ts`, …).
pub trait Clock: Send + Sync + 'static {
    fn now_ms(&self) -> i64;
}

/// Waiting, as a port: a service that acts later asks for the wait here, so a
/// test decides when it is over.
pub trait Sleeper: Send + Sync + 'static {
    /// Resolves once `ms` milliseconds have passed.
    fn sleep(&self, ms: i64) -> crate::BoxFuture<'static, ()>;
}

/// The system's clock.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_system_clock_is_past_2025() {
        assert!(SystemClock.now_ms() > 1_735_689_600_000);
    }
}
