//! `models.json`: the provider's model list as last fetched, and fetching it
//! again.
//!
//! A live catalog fetches the list when the dashboard asks (the app opening,
//! the model menu opening; not again within a minute) and, in the background,
//! once the cached list is six hours old. A fetch that fails or brings no
//! models keeps the last list; the dashboard has its own baseline below it.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, PoisonError, RwLock};

use eos_contracts::CatalogModel;
use eos_core::agent::{ModelCatalog, ModelsApi};
use eos_core::{BoxFuture, Clock};
use eos_domain::model::context_window_for;
use serde::Deserialize;
use serde_json::json;

/// A cached list older than this is fetched again in the background.
const TTL_MS: i64 = 6 * 60 * 60 * 1000;
/// A list fetched (or tried) this recently is not fetched again.
const REFRESH_FLOOR_MS: i64 = 60 * 1000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheFile {
    fetched_at: f64,
    models: Vec<CatalogModel>,
}

impl eos_contracts::Validate for CacheFile {
    fn validate(&self, cx: &mut eos_contracts::Issues) {
        cx.at("models", |cx| self.models.validate(cx));
    }
}

struct Cache {
    fetched_at: i64,
    models: Vec<CatalogModel>,
}

/// What fetches the list, for a catalog that does.
struct Live {
    api: Arc<dyn ModelsApi>,
    clock: Arc<dyn Clock>,
    /// One fetch at a time.
    fetching: Arc<tokio::sync::Mutex<()>>,
    /// Fetches begun, so a caller that waited for one does not start another.
    begun: AtomicU64,
    /// When the last background fetch began.
    tried_at: AtomicI64,
}

struct Inner {
    file: PathBuf,
    cache: RwLock<Option<Cache>>,
    live: Option<Live>,
}

/// The cached list, and with [`live`](Self::live) fetching it again.
pub struct CachedModelCatalog(Arc<Inner>);

impl std::fmt::Debug for CachedModelCatalog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CachedModelCatalog").field("file", &self.0.file).finish_non_exhaustive()
    }
}

impl CachedModelCatalog {
    /// The cached list, never fetched again. A missing or unreadable file is
    /// an empty catalog: windows then come from the built-in baseline.
    pub fn open(file: &Path) -> Self {
        Self::build(file, None)
    }

    /// The cached list, fetched again from `api` and written back to the file.
    pub fn live(file: &Path, api: Arc<dyn ModelsApi>, clock: Arc<dyn Clock>) -> Self {
        let live =
            Live { api, clock, fetching: Arc::default(), begun: AtomicU64::new(0), tried_at: AtomicI64::new(i64::MIN) };
        Self::build(file, Some(live))
    }

    fn build(file: &Path, live: Option<Live>) -> Self {
        let cached = crate::json::read(file).and_then(|json| eos_contracts::parse::<CacheFile>(&json).ok());
        // Epoch milliseconds are far below 2^53: the number is exact.
        let cache = cached.map(|c| Cache { fetched_at: c.fetched_at as i64, models: c.models });
        Self(Arc::new(Inner { file: file.to_owned(), cache: RwLock::new(cache), live }))
    }

    fn cached(&self) -> Vec<CatalogModel> {
        let cache = self.0.cache.read().unwrap_or_else(PoisonError::into_inner);
        cache.as_ref().map(|c| c.models.clone()).unwrap_or_default()
    }

    /// A list older than the TTL (or none at all) is fetched in the
    /// background, at most once a minute, never beside another fetch.
    fn refresh_if_stale(&self) {
        let Some(live) = &self.0.live else { return };
        let now = live.clock.now_ms();
        if !self.0.due(now, TTL_MS) || now.saturating_sub(live.tried_at.load(Ordering::SeqCst)) < REFRESH_FLOOR_MS {
            return;
        }
        let (Ok(runtime), Ok(one)) = (tokio::runtime::Handle::try_current(), live.fetching.clone().try_lock_owned())
        else {
            return;
        };
        live.tried_at.store(now, Ordering::SeqCst);
        let inner = self.0.clone();
        runtime.spawn(async move {
            let _one = one;
            inner.fetch().await;
        });
    }
}

impl Inner {
    /// No list, or one fetched `age_ms` ago or longer.
    fn due(&self, now: i64, age_ms: i64) -> bool {
        let cache = self.cache.read().unwrap_or_else(PoisonError::into_inner);
        cache.as_ref().is_none_or(|c| now.saturating_sub(c.fetched_at) >= age_ms)
    }

    async fn fetch(&self) {
        let Some(live) = &self.live else { return };
        live.begun.fetch_add(1, Ordering::SeqCst);
        let Ok(models) = live.api.list().await else { return };
        if models.is_empty() {
            return;
        }
        let fetched_at = live.clock.now_ms();
        // The file is a cache: a failed write still serves this run.
        let text = serde_json::to_string_pretty(&json!({"fetchedAt": fetched_at, "models": models}));
        if let Ok(text) = text {
            let _ = crate::json::write(&self.file, &format!("{text}\n"));
        }
        *self.cache.write().unwrap_or_else(PoisonError::into_inner) = Some(Cache { fetched_at, models });
    }
}

impl ModelCatalog for CachedModelCatalog {
    fn models(&self) -> Vec<CatalogModel> {
        self.refresh_if_stale();
        self.cached()
    }

    fn context_window_for(&self, model: Option<&str>) -> i64 {
        let cache = self.0.cache.read().unwrap_or_else(PoisonError::into_inner);
        context_window_for(cache.as_ref().map_or(&[], |c| c.models.as_slice()), model)
    }

    fn refresh_now(&self) -> BoxFuture<'_, Vec<CatalogModel>> {
        Box::pin(async move {
            let Some(live) = &self.0.live else { return self.cached() };
            if self.0.due(live.clock.now_ms(), REFRESH_FLOOR_MS) {
                let seen = live.begun.load(Ordering::SeqCst);
                let _one = live.fetching.lock().await;
                // A fetch that ran while this one waited answers for it too.
                if live.begun.load(Ordering::SeqCst) == seen {
                    self.0.fetch().await;
                }
            }
            self.cached()
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use eos_testkit::{FakeClock, TempHome};

    fn opus(id: &str, window: i64) -> CatalogModel {
        CatalogModel {
            id: id.into(),
            display_name: "Claude Opus".into(),
            created_at: "2026-05-01T00:00:00Z".into(),
            max_input_tokens: Some(window),
            max_tokens: Some(64_000),
            effort_levels: Some(vec!["low".into(), "high".into()]),
        }
    }

    /// Answers what it is given next, and counts the asks.
    #[derive(Default)]
    struct Api {
        answers: Mutex<Vec<Result<Vec<CatalogModel>, String>>>,
        asked: AtomicU64,
    }

    impl Api {
        fn asked(&self) -> u64 {
            self.asked.load(Ordering::SeqCst)
        }

        fn next(&self, answer: Result<Vec<CatalogModel>, String>) {
            self.answers.lock().expect("answers").push(answer);
        }
    }

    impl ModelsApi for Api {
        fn list(&self) -> BoxFuture<'_, Result<Vec<CatalogModel>, String>> {
            self.asked.fetch_add(1, Ordering::SeqCst);
            let next = self.answers.lock().expect("answers").pop().unwrap_or_else(|| Err("offline".into()));
            Box::pin(std::future::ready(next))
        }
    }

    #[test]
    fn the_cached_list_answers_windows_and_a_missing_file_falls_back() {
        let home = TempHome::new();
        let none = CachedModelCatalog::open(&home.join("models.json"));
        assert!(none.models().is_empty());
        assert_eq!(none.context_window_for(Some("opus")), 1_000_000);

        home.write(
            "models.json",
            r#"{"fetchedAt": 1790000000000, "models": [
                {"id":"claude-opus-5-5","displayName":"Claude Opus 5.5","createdAt":"2026-05-01T00:00:00Z","maxInputTokens":500000,"maxTokens":64000,"effortLevels":["low","high"]}
            ]}"#,
        );
        let cached = CachedModelCatalog::open(&home.join("models.json"));
        assert_eq!(cached.models().len(), 1);
        assert_eq!(cached.context_window_for(Some("opus")), 500_000);
        assert_eq!(cached.context_window_for(Some("gpt-9")), 200_000);

        home.write("models.json", r#"{"fetchedAt": 1, "models": [{"id":""}]}"#);
        assert!(
            CachedModelCatalog::open(&home.join("models.json")).models().is_empty(),
            "an invalid cache is no cache"
        );
    }

    #[tokio::test]
    async fn a_refresh_fetches_at_most_once_a_minute_writes_the_file_and_keeps_the_list_when_a_fetch_fails() {
        let home = TempHome::new();
        let (api, clock) = (Arc::new(Api::default()), Arc::new(FakeClock::new()));
        let file = home.join("models.json");
        let catalog = CachedModelCatalog::live(&file, api.clone(), clock.clone());

        assert!(catalog.refresh_now().await.is_empty(), "offline, nothing cached");
        api.next(Ok(vec![opus("claude-opus-5-5", 500_000)]));
        assert_eq!(catalog.refresh_now().await, [opus("claude-opus-5-5", 500_000)]);
        assert_eq!(api.asked(), 2, "nothing cached: every refresh asks");
        let written: serde_json::Value = serde_json::from_slice(&std::fs::read(&file).expect("written")).expect("json");
        assert_eq!(written["fetchedAt"], json!(clock.now_ms()), "milliseconds, as an integer");
        assert_eq!(written["models"][0]["effortLevels"], json!(["low", "high"]));
        assert_eq!(catalog.context_window_for(Some("opus")), 500_000);

        // Within a minute the list is served as it is.
        clock.advance(59_000);
        assert_eq!(catalog.refresh_now().await.len(), 1);
        assert_eq!(api.asked(), 2);
        // After it, fetched again; a failure or an empty list keeps the last one.
        clock.advance(1_000);
        assert_eq!(catalog.refresh_now().await.len(), 1);
        api.next(Ok(Vec::new()));
        clock.advance(60_000);
        assert_eq!(catalog.refresh_now().await.len(), 1);
        assert_eq!(api.asked(), 4);

        // The next run starts from the file.
        let reopened = CachedModelCatalog::live(&file, Arc::new(Api::default()), clock.clone());
        assert_eq!(reopened.cached(), [opus("claude-opus-5-5", 500_000)]);
    }

    #[tokio::test]
    async fn a_list_six_hours_old_is_fetched_in_the_background_once() {
        let home = TempHome::new();
        let (api, clock) = (Arc::new(Api::default()), Arc::new(FakeClock::new()));
        api.next(Ok(vec![opus("claude-opus-5-5", 500_000)]));
        let catalog = CachedModelCatalog::live(&home.join("models.json"), api.clone(), clock.clone());
        catalog.refresh_now().await;

        clock.advance(TTL_MS - 1);
        catalog.models();
        tokio::task::yield_now().await;
        assert_eq!(api.asked(), 1, "fresh enough");

        api.next(Ok(vec![opus("claude-opus-6", 800_000)]));
        clock.advance(1);
        assert_eq!(catalog.models().len(), 1, "the reader gets the cached list at once");
        catalog.models();
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        assert_eq!(api.asked(), 2, "one fetch in the background");
        assert_eq!(catalog.models()[0].id, "claude-opus-6");
    }
}
