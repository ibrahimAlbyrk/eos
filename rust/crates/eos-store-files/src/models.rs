//! `models.json`: the provider's model list as last fetched
//! (`manager/services/ModelCatalogService.ts`, the cache half).

use std::path::Path;

use eos_contracts::CatalogModel;
use eos_core::agent::ModelCatalog;
use eos_domain::model::context_window_for;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheFile {
    #[allow(dead_code)]
    fetched_at: f64,
    models: Vec<CatalogModel>,
}

/// The cached list, read once. Fetching a fresh one needs a sign-in and the
/// network: that adapter replaces this one when it exists.
#[derive(Debug, Default)]
pub struct CachedModelCatalog {
    models: Vec<CatalogModel>,
}

impl CachedModelCatalog {
    /// A missing or unreadable file is an empty catalog: windows then come
    /// from the built-in baseline.
    pub fn open(file: &Path) -> Self {
        let cached = crate::json::read(file).and_then(|json| eos_contracts::parse::<CacheFile>(&json).ok());
        Self { models: cached.map(|c| c.models).unwrap_or_default() }
    }
}

impl eos_contracts::Validate for CacheFile {
    fn validate(&self, cx: &mut eos_contracts::Issues) {
        cx.at("models", |cx| self.models.validate(cx));
    }
}

impl ModelCatalog for CachedModelCatalog {
    fn models(&self) -> Vec<CatalogModel> {
        self.models.clone()
    }

    fn context_window_for(&self, model: Option<&str>) -> i64 {
        context_window_for(&self.models, model)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use eos_testkit::TempHome;

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
}
