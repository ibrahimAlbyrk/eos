//! How fast Eos writes to GitHub (06 G24): content-creating requests stay
//! under GitHub's own limits (80 a minute, 500 an hour) with room for the
//! user's other apps, and once GitHub asked Eos to wait, nothing is sent
//! until then.

use std::collections::VecDeque;
use std::sync::Mutex;

use eos_core::capability::ActionError;

use crate::client::HttpResponse;

/// Writes in any minute.
pub const WRITES_PER_MINUTE: usize = 60;
/// Writes in any hour.
pub const WRITES_PER_HOUR: usize = 400;

const MINUTE_MS: i64 = 60_000;
const HOUR_MS: i64 = 60 * MINUTE_MS;
/// How long to wait when GitHub said to and gave no time.
const DEFAULT_WAIT_S: u64 = 60;

#[derive(Debug, Default)]
struct State {
    /// When each write of the last hour went out, oldest first.
    writes: VecDeque<i64>,
    /// GitHub asked to wait until then.
    blocked_until: i64,
}

#[derive(Debug, Default)]
pub(crate) struct RateBucket(Mutex<State>);

/// Whole seconds from `now` to `until`, at least one.
fn seconds(now: i64, until: i64) -> u64 {
    u64::try_from((until - now + 999) / 1000).unwrap_or(0).max(1)
}

impl RateBucket {
    /// Lets a request go at `now`, and counts it when it `writes`.
    pub(crate) fn admit(&self, writes: bool, now: i64) -> Result<(), ActionError> {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if state.blocked_until > now {
            return Err(ActionError::RateLimited { retry_after_s: seconds(now, state.blocked_until) });
        }
        if !writes {
            return Ok(());
        }
        while state.writes.front().is_some_and(|at| *at <= now - HOUR_MS) {
            state.writes.pop_front();
        }
        let in_minute = state.writes.iter().filter(|at| **at > now - MINUTE_MS).count();
        let free_at = if state.writes.len() >= WRITES_PER_HOUR {
            state.writes.front().map(|oldest| oldest + HOUR_MS)
        } else if in_minute >= WRITES_PER_MINUTE {
            state.writes.iter().rev().nth(WRITES_PER_MINUTE - 1).map(|at| at + MINUTE_MS)
        } else {
            None
        };
        if let Some(free_at) = free_at {
            return Err(ActionError::RateLimited { retry_after_s: seconds(now, free_at) });
        }
        state.writes.push_back(now);
        Ok(())
    }

    /// Keeps how long GitHub asked to wait (`retry-after` in seconds, else
    /// `x-ratelimit-reset` in epoch seconds), and answers it in seconds.
    pub(crate) fn blocked_by(&self, response: &HttpResponse, now: i64) -> u64 {
        let number = |name: &str| response.header(name).and_then(|value| value.trim().parse::<i64>().ok());
        let until = match (number("retry-after"), number("x-ratelimit-reset")) {
            (Some(after_s), _) => now + after_s.max(1) * 1000,
            (None, Some(reset_s)) if reset_s * 1000 > now => reset_s * 1000,
            _ => now + i64::try_from(DEFAULT_WAIT_S).unwrap_or(60) * 1000,
        };
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        state.blocked_until = state.blocked_until.max(until);
        seconds(now, until)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_stop_at_sixty_a_minute_and_four_hundred_an_hour_and_reads_never_count() {
        let bucket = RateBucket::default();
        for i in 0..60 {
            bucket.admit(true, i).expect("under the minute's limit");
        }
        assert_eq!(bucket.admit(true, 1_000), Err(ActionError::RateLimited { retry_after_s: 59 }));
        bucket.admit(false, 1_000).expect("a read is not a write");
        bucket.admit(true, MINUTE_MS).expect("the first write of the minute left the window");

        let hourly = RateBucket::default();
        for i in 0..400 {
            hourly.admit(true, i * 1_100).expect("fewer than 60 in any minute");
        }
        let now = 400 * 1_100;
        assert_eq!(hourly.admit(true, now), Err(ActionError::RateLimited { retry_after_s: 3_160 }), "the hour's first");
        hourly.admit(true, HOUR_MS).expect("the first write of the hour left the window");
    }

    #[test]
    fn once_github_asks_to_wait_nothing_goes_until_then() {
        let bucket = RateBucket::default();
        let retry = HttpResponse { status: 429, headers: vec![("Retry-After".into(), "30".into())], body: Vec::new() };
        assert_eq!(bucket.blocked_by(&retry, 1_000), 30);
        assert_eq!(bucket.admit(false, 20_000), Err(ActionError::RateLimited { retry_after_s: 11 }));
        bucket.admit(false, 31_000).expect("the wait is over");

        let reset = HttpResponse {
            status: 403,
            headers: vec![("x-ratelimit-remaining".into(), "0".into()), ("x-ratelimit-reset".into(), "100".into())],
            body: Vec::new(),
        };
        assert_eq!(bucket.blocked_by(&reset, 40_000), 60, "until the reset GitHub named");
    }
}
