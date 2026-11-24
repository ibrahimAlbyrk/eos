//! Slack's rate tiers kept on Eos's side (06 §4.7): posts one a second in
//! each conversation and 50 a minute in all; history and replies 40 a
//! minute; search, people and conversation lists 15 a minute. A 429 stops
//! its method until `Retry-After` passed. A call over a bucket is refused
//! unsent, with how long until a slot frees.

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, MutexGuard};

use eos_core::capability::ActionError;

const MINUTE_MS: i64 = 60_000;
const SECOND_MS: i64 = 1_000;

/// The windows a method's calls count in: (calls, window in ms, per conversation).
fn windows(method: &str) -> &'static [(usize, i64, bool)] {
    match method {
        "chat.postMessage" => &[(1, SECOND_MS, true), (50, MINUTE_MS, false)],
        "conversations.history" | "conversations.replies" => &[(40, MINUTE_MS, false)],
        "search.messages" | "users.list" | "users.conversations" => &[(15, MINUTE_MS, false)],
        _ => &[],
    }
}

#[derive(Debug, Default)]
struct State {
    /// Call times by (method, conversation or "").
    calls: HashMap<(String, String), VecDeque<i64>>,
    /// Until when Slack asked a method to wait.
    blocked: HashMap<String, i64>,
}

#[derive(Debug, Default)]
pub(crate) struct Buckets(Mutex<State>);

impl Buckets {
    fn state(&self) -> MutexGuard<'_, State> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Takes a slot for one call of `method`, or answers how long to wait.
    pub(crate) fn admit(&self, method: &str, conversation: Option<&str>, now: i64) -> Result<(), ActionError> {
        let mut state = self.state();
        if let Some(until) = state.blocked.get(method).copied().filter(|until| *until > now) {
            return Err(ActionError::RateLimited { retry_after_s: seconds(until - now) });
        }
        let keys: Vec<((String, String), usize, i64)> = windows(method)
            .iter()
            .map(|(calls, window, per)| {
                let at = if *per { conversation.unwrap_or_default() } else { "" };
                ((format!("{method}/{window}"), at.to_owned()), *calls, *window)
            })
            .collect();
        for (key, calls, window) in &keys {
            let stamps = state.calls.entry(key.clone()).or_default();
            while stamps.front().is_some_and(|at| *at <= now - window) {
                stamps.pop_front();
            }
            if stamps.len() >= *calls {
                let frees = stamps.front().copied().unwrap_or(now) + window;
                return Err(ActionError::RateLimited { retry_after_s: seconds(frees - now) });
            }
        }
        for (key, _, _) in keys {
            state.calls.entry(key).or_default().push_back(now);
        }
        Ok(())
    }

    /// How long Slack still holds `method`, in seconds.
    pub(crate) fn held(&self, method: &str, now: i64) -> Option<u64> {
        self.state().blocked.get(method).copied().filter(|until| *until > now).map(|until| seconds(until - now))
    }

    /// Slack answered 429: `method` waits `retry_after_s`.
    pub(crate) fn blocked(&self, method: &str, retry_after_s: u64, now: i64) {
        let until = now + i64::try_from(retry_after_s).unwrap_or(i64::MAX / 2_000) * 1000;
        self.state().blocked.insert(method.to_owned(), until);
    }
}

fn seconds(ms: i64) -> u64 {
    u64::try_from((ms + 999) / 1000).unwrap_or(1).max(1)
}
