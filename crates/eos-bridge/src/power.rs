//! Noticing that the Mac slept. A sleeping process does not run, so a wall clock that jumped
//! further than the timer that reads it is a wake. The shell hands this to the core, which
//! has work to redo after a sleep (reconnects, missed checks).

use std::time::Duration;

/// Feeds on clock readings taken at a steady interval.
#[derive(Debug, Clone)]
pub struct WakeDetector {
    last_ms: Option<u64>,
    interval: Duration,
}

impl WakeDetector {
    pub fn new(interval: Duration) -> Self {
        WakeDetector { last_ms: None, interval }
    }

    /// Takes the current wall-clock reading; returns how long the Mac was away when the
    /// time since the last reading is far more than the interval.
    pub fn tick(&mut self, now_ms: u64) -> Option<Duration> {
        let last = self.last_ms.replace(now_ms)?;
        let gap = Duration::from_millis(now_ms.saturating_sub(last));
        // Three intervals: a busy machine can delay a timer, sleep is longer.
        (gap > self.interval * 3).then(|| gap - self.interval)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steady_ticks_are_not_a_wake() {
        let mut d = WakeDetector::new(Duration::from_secs(5));
        assert_eq!(d.tick(1_000), None, "the first reading has nothing to compare with");
        assert_eq!(d.tick(6_000), None);
        assert_eq!(d.tick(11_400), None, "a late timer");
        assert_eq!(d.tick(24_000), None, "a very late timer, still under three intervals");
    }

    #[test]
    fn a_jump_is_a_wake_with_its_length() {
        let mut d = WakeDetector::new(Duration::from_secs(5));
        d.tick(0);
        assert_eq!(d.tick(605_000), Some(Duration::from_secs(600)));
        assert_eq!(d.tick(610_000), None, "reported once");
    }

    #[test]
    fn a_clock_set_back_is_not_a_wake() {
        let mut d = WakeDetector::new(Duration::from_secs(5));
        d.tick(100_000);
        assert_eq!(d.tick(50_000), None);
        assert_eq!(d.tick(55_000), None);
    }
}
