//! The cache and rate floor in front of the plan-usage providers
//! (`manager/services/UsageService.ts`). Claude's usage endpoint answers 429
//! readily, so at most one upstream round is made per floor: inside it every
//! request, a manual refresh included, is served from the last snapshot. One
//! provider's failure never fails the response: its reason goes to `errors`
//! and its last good snapshot keeps being served, marked `stale`, while it is
//! retried with a growing backoff. The last good snapshots are saved so they
//! survive a restart; only "not signed in" drops them. Every upstream round
//! is announced as `usage:change`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use eos_contracts::{ProviderUsage, UsageError as UsageErrorEntry, UsageResponse};
use eos_core::Clock;
use eos_core::accounts::{UsageError, UsageProvider, UsageSnapshotStore, usage_key};
use eos_core::store::{Announcement, Announcer};

pub const MIN_INTERVAL_MS: i64 = 180_000;
const MAX_BACKOFF_MS: i64 = 15 * 60_000;
pub(crate) const USAGE_CHANGE: &str = "usage:change";

/// The providers of the moment: read on every fetch, so a sign-in added or
/// removed is picked up.
pub type Providers = Arc<dyn Fn() -> Vec<Arc<dyn UsageProvider>> + Send + Sync>;

#[derive(Default)]
struct ProviderState {
    last: Option<ProviderUsage>,
    error: Option<String>,
    failures: u32,
    retry_at: i64,
}

#[derive(Default)]
struct State {
    cache: Option<UsageResponse>,
    last_fetch_at: i64,
    /// One entry per current provider: a provider that is gone loses its
    /// entry at the next round.
    providers: HashMap<String, ProviderState>,
}

pub struct UsageService {
    providers: Providers,
    clock: Arc<dyn Clock>,
    floor_ms: i64,
    store: Arc<dyn UsageSnapshotStore>,
    announcer: Arc<dyn Announcer>,
    state: Mutex<State>,
    /// One upstream round at a time; whoever waits reads its result.
    round: tokio::sync::Mutex<()>,
}

impl std::fmt::Debug for UsageService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UsageService").field("floor_ms", &self.floor_ms).finish_non_exhaustive()
    }
}

impl UsageService {
    pub fn new(
        providers: Providers,
        clock: Arc<dyn Clock>,
        store: Arc<dyn UsageSnapshotStore>,
        announcer: Arc<dyn Announcer>,
    ) -> Self {
        Self::with_floor(providers, clock, store, announcer, MIN_INTERVAL_MS)
    }

    pub fn with_floor(
        providers: Providers,
        clock: Arc<dyn Clock>,
        store: Arc<dyn UsageSnapshotStore>,
        announcer: Arc<dyn Announcer>,
        floor_ms: i64,
    ) -> Self {
        let mut state = State::default();
        for snapshot in store.load() {
            let key = usage_key(&snapshot.provider, snapshot.login_id.as_deref());
            state.providers.entry(key).or_default().last = Some(snapshot);
        }
        Self { providers, clock, floor_ms, store, announcer, state: Mutex::new(state), round: Default::default() }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The last good snapshot of every current provider, without fetching.
    pub fn peek(&self) -> Vec<ProviderUsage> {
        let providers = (self.providers)();
        let state = self.state();
        providers.iter().filter_map(|p| state.providers.get(&p.id())?.last.clone()).collect()
    }

    /// What is held now, without waiting on upstream: past the floor a
    /// refresh starts in the background and arrives as `usage:change`. Only
    /// with nothing held yet (never fetched, no saved snapshot) does it wait
    /// for the fetch.
    pub async fn current(self: &Arc<Self>) -> UsageResponse {
        let cached = self.state().cache.clone();
        let held = cached.or_else(|| (!self.peek().is_empty()).then(|| self.response()));
        let Some(held) = held else { return self.get_usage().await };
        if self.fresh().is_none() {
            let this = self.clone();
            tokio::spawn(async move { this.get_usage().await });
        }
        held
    }

    /// A sign-in was added or removed: what is held answers for the old ones,
    /// so fetch now, past the floor, and announce the result. A round already
    /// under way read the old sign-ins too, so this one runs after it.
    pub fn invalidate(self: &Arc<Self>) {
        let this = self.clone();
        tokio::spawn(async move {
            let _round = this.round.lock().await;
            this.state().cache = None;
            this.fetch_all().await;
        });
    }

    fn fresh(&self) -> Option<UsageResponse> {
        let state = self.state();
        let cache = state.cache.as_ref()?;
        (self.clock.now_ms() - state.last_fetch_at < self.floor_ms).then(|| cache.clone())
    }

    /// The cache inside the floor; otherwise a fresh round. A refresh is
    /// honoured the same way: it cannot get under the floor.
    pub async fn get_usage(&self) -> UsageResponse {
        if let Some(cached) = self.fresh() {
            return cached;
        }
        let _round = self.round.lock().await;
        // The round we waited for answers this request too.
        if let Some(cached) = self.fresh() {
            return cached;
        }
        self.fetch_all().await
    }

    async fn fetch_all(&self) -> UsageResponse {
        let now = self.clock.now_ms();
        let providers = (self.providers)();
        let mut changed = false;
        for provider in &providers {
            let id = provider.id();
            if now < self.state().providers.entry(id.clone()).or_default().retry_at {
                continue;
            }
            let fetched = provider.fetch().await;
            let mut state = self.state();
            let entry = state.providers.entry(id).or_default();
            changed |= self.apply(entry, fetched, now);
        }
        let response = {
            let mut state = self.state();
            state.providers.retain(|id, _| providers.iter().any(|p| p.id() == *id));
            state.last_fetch_at = now;
            let response = Self::response_of(&providers, &state);
            state.cache = Some(response.clone());
            response
        };
        if changed {
            // Best effort: a failed write only costs the snapshots across a restart.
            let _ = self.store.save(&self.peek());
        }
        if let Ok(payload) = serde_json::to_vec(&response) {
            self.announcer.announce(vec![Announcement { topic: USAGE_CHANGE, payload }]);
        }
        response
    }

    /// Takes one provider's answer; true when its saved snapshot changed.
    fn apply(&self, entry: &mut ProviderState, fetched: Result<ProviderUsage, UsageError>, now: i64) -> bool {
        match fetched {
            Ok(snapshot) => {
                *entry = ProviderState { last: Some(snapshot), ..ProviderState::default() };
                true
            }
            Err(UsageError::NoAccount(reason)) => {
                entry.error = Some(reason);
                entry.last.take().is_some()
            }
            Err(UsageError::Failed(reason)) => {
                entry.error = Some(reason);
                // Back off only while a snapshot covers the gap; with nothing
                // to show, keep retrying at the floor so a fixed sign-in
                // shows up promptly.
                if entry.last.is_some() {
                    entry.failures += 1;
                    let backoff = self.floor_ms.saturating_mul(1_i64 << (entry.failures - 1).min(20));
                    entry.retry_at = now + backoff.min(MAX_BACKOFF_MS);
                }
                false
            }
        }
    }

    fn response(&self) -> UsageResponse {
        let providers = (self.providers)();
        Self::response_of(&providers, &self.state())
    }

    fn response_of(providers: &[Arc<dyn UsageProvider>], state: &State) -> UsageResponse {
        let mut out = UsageResponse { providers: Vec::new(), errors: None };
        let mut errors = Vec::new();
        for provider in providers {
            let id = provider.id();
            let Some(entry) = state.providers.get(&id) else { continue };
            if let Some(last) = &entry.last {
                let stale = entry.error.is_some().then_some(true);
                out.providers.push(ProviderUsage { stale: stale.or(last.stale), ..last.clone() });
            }
            if let Some(reason) = &entry.error {
                errors.push(UsageErrorEntry { provider: id, reason: reason.clone() });
            }
        }
        out.errors = (!errors.is_empty()).then_some(errors);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use eos_testkit::{Announced, FakeClock, FakeUsageProvider, FakeUsageSnapshots};

    struct Fixture {
        svc: Arc<UsageService>,
        clock: Arc<FakeClock>,
        store: Arc<FakeUsageSnapshots>,
        announced: Arc<Announced>,
    }

    fn fixture(providers: Vec<Arc<FakeUsageProvider>>, saved: Vec<ProviderUsage>) -> Fixture {
        let clock = Arc::new(FakeClock::at(1_000_000));
        let store = Arc::new(FakeUsageSnapshots::with(saved));
        let announced = Arc::new(Announced::default());
        let list: Providers = Arc::new(move || providers.iter().map(|p| p.clone() as Arc<dyn UsageProvider>).collect());
        let svc = Arc::new(UsageService::new(list, clock.clone(), store.clone(), announced.clone()));
        Fixture { svc, clock, store, announced }
    }

    fn failed(reason: &str) -> Result<ProviderUsage, UsageError> {
        Err(UsageError::Failed(reason.into()))
    }

    // manager/services/__tests__/UsageService.test.ts
    #[tokio::test]
    async fn the_cache_answers_inside_the_floor_and_a_round_is_made_after_it() {
        let claude = FakeUsageProvider::new("claude");
        let t = fixture(vec![claude.clone()], vec![]);
        let first = t.svc.get_usage().await;
        assert_eq!(first.providers.len(), 1);
        t.clock.advance(MIN_INTERVAL_MS - 1);
        t.svc.get_usage().await;
        assert_eq!(claude.calls(), 1, "inside the floor: no second round");
        t.clock.advance(1);
        t.svc.get_usage().await;
        assert_eq!(claude.calls(), 2);
        assert_eq!(t.announced.topics(), ["usage:change", "usage:change"], "one event per round");
    }

    #[tokio::test]
    async fn concurrent_refreshes_share_one_round() {
        let claude = FakeUsageProvider::new("claude");
        let t = fixture(vec![claude.clone()], vec![]);
        let (a, b, c) = tokio::join!(t.svc.get_usage(), t.svc.get_usage(), t.svc.get_usage());
        assert_eq!(claude.calls(), 1);
        assert!(a == b && b == c);
    }

    #[tokio::test]
    async fn one_providers_failure_is_listed_and_the_other_still_answers() {
        let (claude, codex) = (FakeUsageProvider::new("claude"), FakeUsageProvider::new("codex"));
        codex.answer(Err(UsageError::NoAccount("Not signed in to ChatGPT.".into())));
        let t = fixture(vec![claude, codex], vec![]);
        let res = t.svc.get_usage().await;
        assert_eq!(res.providers.iter().map(|p| p.provider.as_str()).collect::<Vec<_>>(), ["claude"]);
        assert_eq!(
            res.errors,
            Some(vec![UsageErrorEntry { provider: "codex".into(), reason: "Not signed in to ChatGPT.".into() }])
        );
    }

    #[tokio::test]
    async fn a_failed_fetch_serves_the_last_snapshot_as_stale_and_backs_off() {
        let claude = FakeUsageProvider::new("claude");
        let t = fixture(vec![claude.clone()], vec![]);
        t.svc.get_usage().await;
        claude.answer(failed("usage fetch failed (HTTP 429)"));
        t.clock.advance(MIN_INTERVAL_MS);
        let res = t.svc.get_usage().await;
        assert_eq!(res.providers[0].stale, Some(true));
        assert_eq!(res.errors.as_ref().map(|e| e[0].reason.as_str()), Some("usage fetch failed (HTTP 429)"));
        assert_eq!(claude.calls(), 2);

        // First failure: retried one floor later; the second doubles the wait.
        t.clock.advance(MIN_INTERVAL_MS);
        t.svc.get_usage().await;
        assert_eq!(claude.calls(), 3);
        t.clock.advance(MIN_INTERVAL_MS);
        t.svc.get_usage().await;
        assert_eq!(claude.calls(), 3, "still backing off");
        t.clock.advance(MIN_INTERVAL_MS);
        claude.answer(Ok(FakeUsageProvider::snapshot("claude", None)));
        let healed = t.svc.get_usage().await;
        assert_eq!(claude.calls(), 4);
        assert_eq!((healed.providers[0].stale, healed.errors), (None, None));
    }

    #[tokio::test]
    async fn a_signed_out_account_loses_its_snapshot_also_on_disk() {
        let claude = FakeUsageProvider::new("claude");
        let t = fixture(vec![claude.clone()], vec![]);
        t.svc.get_usage().await;
        assert_eq!(t.store.saved().len(), 1);
        claude.answer(Err(UsageError::NoAccount("No Claude subscription token configured.".into())));
        t.clock.advance(MIN_INTERVAL_MS);
        let res = t.svc.get_usage().await;
        assert!(res.providers.is_empty());
        assert!(t.store.saved().is_empty());
    }

    #[tokio::test]
    async fn a_saved_snapshot_is_served_after_a_restart_without_waiting_on_upstream() {
        let claude = FakeUsageProvider::new("claude:lg-1");
        claude.answer(failed("offline"));
        let saved = FakeUsageProvider::snapshot("claude", Some("lg-1"));
        let t = fixture(vec![claude.clone()], vec![saved.clone()]);
        assert_eq!(t.svc.peek(), std::slice::from_ref(&saved), "it comes back under its sign-in");
        let held = t.svc.current().await;
        assert_eq!(held.providers, [saved]);
        tokio::task::yield_now().await;
        let after = t.svc.get_usage().await;
        assert_eq!(after.providers[0].stale, Some(true), "the refresh ran behind it and failed");
    }

    #[tokio::test]
    async fn with_nothing_held_the_first_read_waits_for_the_fetch() {
        let claude = FakeUsageProvider::new("claude");
        let t = fixture(vec![claude.clone()], vec![]);
        assert_eq!(t.svc.current().await.providers.len(), 1);
        assert_eq!(claude.calls(), 1);
    }

    #[tokio::test]
    async fn a_sign_in_made_inside_the_floor_shows_once_invalidated() {
        let (first, second) = (FakeUsageProvider::new("claude:lg-1"), FakeUsageProvider::new("claude:lg-2"));
        let live = Arc::new(Mutex::new(vec![first.clone()]));
        let (clock, announced) = (Arc::new(FakeClock::at(1_000_000)), Arc::new(Announced::default()));
        let source = live.clone();
        let list: Providers = Arc::new(move || {
            source.lock().expect("providers").iter().map(|p| p.clone() as Arc<dyn UsageProvider>).collect()
        });
        let store = Arc::new(FakeUsageSnapshots::default());
        let svc = Arc::new(UsageService::new(list, clock, store.clone(), announced.clone()));
        svc.get_usage().await;

        *live.lock().expect("providers") = vec![second.clone()];
        assert_eq!(svc.get_usage().await.providers[0].login_id.as_deref(), Some("lg-1"), "the floor still holds");
        svc.invalidate();
        while second.calls() == 0 {
            tokio::task::yield_now().await;
        }
        let res = svc.get_usage().await;
        assert_eq!(res.providers.iter().map(|p| p.login_id.as_deref()).collect::<Vec<_>>(), [Some("lg-2")]);
        assert_eq!(store.saved().len(), 1, "the removed sign-in's snapshot is gone");
        assert_eq!(announced.topics().len(), 2);
    }
}
