//! Claude's model list, `GET /v1/models`.
//!
//! Read with the token of the sign-in a new session would use: the endpoint
//! only describes models, so it costs nothing on the plan. The token is never
//! logged or returned. Without a sign-in nothing is sent.

use std::sync::Arc;
use std::time::Duration;

use eos_contracts::{CatalogModel, EFFORT_LEVELS};
use eos_core::BoxFuture;
use eos_core::accounts::{PlanStores, SessionCredential, SessionCredentials};
use eos_core::agent::ModelsApi;
use eos_kit_net::{ClientOptions, http_client};
use serde_json::{Value, json};

const ANTHROPIC_API: &str = "https://api.anthropic.com";
const PROVIDER: &str = "anthropic";
/// Eos names itself: it does not pose as another program.
const USER_AGENT: &str = concat!("eos/", env!("CARGO_PKG_VERSION"));
const TIMEOUT: Duration = Duration::from_secs(3);

/// The models Claude lists for the user's sign-in.
pub struct ClaudeModels {
    http: reqwest::Client,
    url: String,
    credentials: Arc<dyn SessionCredentials>,
    stores: Arc<dyn PlanStores>,
}

impl std::fmt::Debug for ClaudeModels {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClaudeModels").field("url", &self.url).finish_non_exhaustive()
    }
}

impl ClaudeModels {
    pub fn new(credentials: Arc<dyn SessionCredentials>, stores: Arc<dyn PlanStores>) -> Self {
        Self::at(ANTHROPIC_API, credentials, stores)
    }

    /// `base`: the API's origin (a local server in tests).
    pub fn at(base: &str, credentials: Arc<dyn SessionCredentials>, stores: Arc<dyn PlanStores>) -> Self {
        // The options are constants; a client that cannot be built is a broken TLS set-up.
        let http = http_client(&ClientOptions::new(USER_AGENT)).unwrap_or_default();
        Self { http, url: format!("{}/v1/models?limit=100", base.trim_end_matches('/')), credentials, stores }
    }

    /// The access token of the sign-in a new session would use, renewed
    /// first when it lapsed.
    async fn token(&self) -> Option<String> {
        let Some(SessionCredential::Store { dir, .. }) = self.credentials.for_new_session(PROVIDER).await else {
            return None;
        };
        self.stores.access_token(PROVIDER, dir.to_str()?).await
    }
}

/// The effort levels in a model's `capabilities.effort`: `[]` when it has
/// none, `None` when the answer does not say (callers then let any through).
fn effort_levels(capabilities: Option<&Value>) -> Option<Vec<String>> {
    let effort = capabilities?.get("effort")?.as_object()?;
    if effort.get("supported") == Some(&Value::Bool(false)) {
        return Some(Vec::new());
    }
    let supported = |level: &str| effort.get(level).and_then(|leaf| leaf.get("supported")) == Some(&json!(true));
    let levels: Vec<String> = EFFORT_LEVELS.iter().filter(|l| supported(l)).map(|l| (*l).to_owned()).collect();
    (!levels.is_empty()).then_some(levels)
}

/// The answer's models; one that does not read as a model is left out.
fn models_of(body: &Value) -> Result<Vec<CatalogModel>, String> {
    let data = body.get("data").and_then(Value::as_array).ok_or("models fetch: unexpected response shape")?;
    Ok(data
        .iter()
        .filter_map(|m| {
            let text = |key: &str| m.get(key).filter(|v| !v.is_null()).cloned().unwrap_or_else(|| json!(""));
            let model = json!({
                "id": m.get("id"),
                "displayName": text("display_name"),
                "createdAt": text("created_at"),
                "maxInputTokens": m.get("max_input_tokens"),
                "maxTokens": m.get("max_tokens"),
                "effortLevels": effort_levels(m.get("capabilities")),
            });
            eos_contracts::parse::<CatalogModel>(&model).ok()
        })
        .collect())
}

impl ModelsApi for ClaudeModels {
    fn list(&self) -> BoxFuture<'_, Result<Vec<CatalogModel>, String>> {
        Box::pin(async move {
            let token = self.token().await.ok_or("no usable Claude OAuth token")?;
            let request =
                self.http.get(&self.url).bearer_auth(token).header("anthropic-version", "2023-06-01").timeout(TIMEOUT);
            let res = request.send().await.map_err(|e| format!("models fetch failed: {}", e.without_url()))?;
            let status = res.status();
            if !status.is_success() {
                return Err(format!("models fetch failed: {}", status.as_u16()));
            }
            let bytes = res.bytes().await.map_err(|e| format!("models fetch failed: {}", e.without_url()))?;
            let body: Value =
                serde_json::from_slice(&bytes).map_err(|_| "models fetch: unexpected response shape".to_owned())?;
            models_of(&body)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // What GET /v1/models answers, as infra's tests of the fetcher feed it.
    #[test]
    fn the_answer_becomes_catalog_models_with_their_effort_levels() {
        let body = json!({"data": [
            {"id": "claude-opus-5-5", "display_name": "Claude Opus 5.5", "created_at": "2026-05-01T00:00:00Z",
             "max_input_tokens": 1000000, "max_tokens": 128000,
             "capabilities": {"effort": {"supported": true, "low": {"supported": true}, "medium": {"supported": false},
                                         "high": {"supported": true}, "max": {"supported": true}}}},
            {"id": "claude-haiku-5", "display_name": "Claude Haiku 5", "created_at": "2026-04-01T00:00:00Z",
             "max_input_tokens": null, "max_tokens": null, "capabilities": {"effort": {"supported": false}}},
            {"id": "claude-older", "created_at": "2025-01-01T00:00:00Z", "max_input_tokens": 200000, "max_tokens": 8192},
            {"id": "", "display_name": "nameless"},
            {"id": "claude-broken", "display_name": "x", "created_at": "x", "max_input_tokens": -5, "max_tokens": 1}
        ]});
        let models = models_of(&body).expect("models");
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(
            ids,
            ["claude-opus-5-5", "claude-haiku-5", "claude-older"],
            "what does not read as a model is left out"
        );
        assert_eq!(models[0].effort_levels.as_deref(), Some(&["low".to_owned(), "high".into(), "max".into()][..]));
        assert_eq!(models[0].max_input_tokens, Some(1_000_000));
        assert_eq!(models[1].effort_levels, Some(Vec::new()), "no effort at all");
        assert_eq!(models[1].max_input_tokens, None);
        assert_eq!(models[2].effort_levels, None, "unknown");
        assert_eq!(models[2].display_name, "");
        assert!(models_of(&json!({"models": []})).is_err());
    }
}
