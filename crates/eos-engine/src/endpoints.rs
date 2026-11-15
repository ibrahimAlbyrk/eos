//! The providers reached with an API key (`config.json` backends that speak
//! the Chat Completions API), kept registered with the engine as the file
//! and the keys change.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use eos_agent_core::{BoxFuture, Credential, ModelError, TokenSource};
use eos_agent_sdk::{ChatCompat, MaxTokens, ProviderConfig, Sdk};
use eos_contracts::{ProviderModel, ProviderModels};
use eos_core::Clock;
use eos_core::store::ConfigSource;
use eos_domain::provider::{EndpointKey, ProviderEndpoint, endpoint_of, endpoints};
use eos_platform::CredentialStore;

use crate::accounts::NOT_SIGNED_IN;

/// How long a provider's model list is kept before it is read again.
const MODELS_TTL_MS: i64 = 10 * 60 * 1000;
/// The effort levels a server that takes an effort is offered.
const EFFORTS: [&str; 3] = ["low", "medium", "high"];

/// The endpoint's key (`None`: none is set; empty: the server asks for none).
pub(crate) fn key_of(secrets: &dyn CredentialStore, endpoint: &ProviderEndpoint) -> Option<String> {
    let key = match &endpoint.key {
        EndpointKey::Keychain(service) => secrets.read_secret(service)?,
        EndpointKey::Env(variable) => std::env::var(variable).ok()?,
        EndpointKey::None => return Some(String::new()),
    };
    Some(key.trim().to_owned()).filter(|k| !k.is_empty())
}

/// The context window of `model` when it is a key-based provider's.
pub(crate) fn window_of(config: &dyn ConfigSource, model: &str) -> Option<i64> {
    endpoint_of(&endpoints(&config.current()), model).map(|(endpoint, _)| endpoint.context_window)
}

/// An endpoint's key, read when a request needs it: a key saved or removed
/// in Settings holds from the next request.
struct Key {
    secrets: Arc<dyn CredentialStore>,
    endpoint: ProviderEndpoint,
}

impl TokenSource for Key {
    fn credential(&self) -> BoxFuture<'_, Result<Credential, ModelError>> {
        let (secrets, endpoint) = (self.secrets.clone(), self.endpoint.clone());
        Box::pin(async move {
            let read = tokio::task::spawn_blocking(move || key_of(secrets.as_ref(), &endpoint));
            match read.await {
                Ok(Some(key)) => Ok(Credential::ApiKey(key)),
                _ => Err(ModelError::Auth(NOT_SIGNED_IN.into())),
            }
        })
    }
}

pub(crate) struct Endpoints {
    config: Arc<dyn ConfigSource>,
    secrets: Arc<dyn CredentialStore>,
    clock: Arc<dyn Clock>,
    sdk: Sdk,
    /// What the engine has, as last registered.
    registered: Mutex<Vec<ProviderEndpoint>>,
    /// Each provider's model list and when it was read (ms).
    models: Mutex<HashMap<String, (i64, Vec<String>)>>,
}

fn provider_config(endpoint: &ProviderEndpoint, auth: Arc<dyn TokenSource>) -> ProviderConfig {
    let max_tokens = if endpoint.max_completion_tokens { MaxTokens::MaxCompletionTokens } else { MaxTokens::MaxTokens };
    ProviderConfig {
        id: endpoint.id.clone(),
        base_url: endpoint.base_url.clone(),
        chat_path: Some(endpoint.chat_path.clone()),
        auth,
        key_header: endpoint.key_header.map(str::to_owned),
        headers: Vec::new(),
        compat: ChatCompat {
            max_tokens,
            effort: endpoint.effort,
            replay_reasoning: endpoint.replay_reasoning,
            ..ChatCompat::default()
        },
        context_window: u64::try_from(endpoint.context_window).ok().filter(|w| *w > 0),
        max_tokens: endpoint.max_tokens.and_then(|m| u32::try_from(m).ok()).filter(|m| *m > 0),
    }
}

impl Endpoints {
    pub(crate) fn new(
        config: Arc<dyn ConfigSource>,
        secrets: Arc<dyn CredentialStore>,
        clock: Arc<dyn Clock>,
        sdk: Sdk,
    ) -> Self {
        Self { config, secrets, clock, sdk, registered: Mutex::default(), models: Mutex::default() }
    }

    /// Registers what `config.json` lists now with the engine (what changed
    /// only) and returns it.
    pub(crate) fn sync(&self) -> Vec<ProviderEndpoint> {
        let wanted = endpoints(&self.config.current());
        let mut registered = self.registered.lock().unwrap_or_else(PoisonError::into_inner);
        for gone in registered.iter().filter(|r| !wanted.iter().any(|w| w.id == r.id)) {
            self.sdk.remove_provider(&gone.id);
        }
        for endpoint in wanted.iter().filter(|w| !registered.contains(w)) {
            let key = Key { secrets: self.secrets.clone(), endpoint: endpoint.clone() };
            if let Err(e) = self.sdk.set_provider(provider_config(endpoint, Arc::new(key))) {
                tracing::warn!(provider = %endpoint.id, error = %e, "a provider could not be set up");
            }
        }
        registered.clone_from(&wanted);
        wanted
    }

    /// Why a session cannot run on `model` now (`None`: it can).
    pub(crate) fn unusable(&self, model: &str) -> Option<String> {
        let all = self.sync();
        let Some((endpoint, _)) = endpoint_of(&all, model) else {
            return Some(format!("no provider for \"{model}\" · add one under Settings › Accounts"));
        };
        key_of(self.secrets.as_ref(), endpoint)
            .is_none()
            .then(|| format!("no key for {} · add one under Settings › Accounts", endpoint.label))
    }

    /// The models `endpoint` lists, read again once the list held is old.
    /// A list that cannot be read is the profile's own model.
    async fn models(&self, endpoint: &ProviderEndpoint) -> Vec<String> {
        let now = self.clock.now_ms();
        let held = self.models.lock().unwrap_or_else(PoisonError::into_inner).get(&endpoint.id).cloned();
        if let Some((at, models)) = held
            && now - at < MODELS_TTL_MS
        {
            return models;
        }
        let mut models = match self.sdk.provider_models(&endpoint.id).await {
            Some(Ok(models)) => models,
            Some(Err(e)) => {
                tracing::warn!(provider = %endpoint.id, error = %e, "a provider's model list could not be read");
                Vec::new()
            }
            None => Vec::new(),
        };
        let read = !models.is_empty();
        // The profile's own model first, listed or not.
        models.retain(|m| *m != endpoint.model);
        models.insert(0, endpoint.model.clone());
        if read {
            self.models
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(endpoint.id.clone(), (now, models.clone()));
        }
        models
    }

    /// Every key-based provider with the models it offers; one without a key lists none.
    pub(crate) async fn listing(&self) -> Vec<ProviderModels> {
        let mut out = Vec::new();
        for endpoint in self.sync() {
            let ready = key_of(self.secrets.as_ref(), &endpoint).is_some();
            let models = if ready { self.models(&endpoint).await } else { Vec::new() };
            out.push(listed(&endpoint, ready, &models));
        }
        out
    }

    /// The models `endpoint` lists with `key`, without keeping either.
    pub(crate) async fn probe(&self, endpoint: &ProviderEndpoint, key: String) -> Result<Vec<String>, String> {
        let mut probe = endpoint.clone();
        probe.id = format!("probe-{}", self.clock.now_ms());
        let auth = Arc::new(eos_agent_core::StaticCredential(Credential::ApiKey(key)));
        self.sdk.set_provider(provider_config(&probe, auth)).map_err(|e| e.to_string())?;
        let models = self.sdk.provider_models(&probe.id).await;
        self.sdk.remove_provider(&probe.id);
        models.unwrap_or_else(|| Ok(Vec::new())).map_err(|e| e.to_string())
    }
}

/// `endpoint` as the model menu lists it.
pub(crate) fn listed(endpoint: &ProviderEndpoint, ready: bool, models: &[String]) -> ProviderModels {
    let efforts: &[&str] = if endpoint.effort { &EFFORTS } else { &[] };
    let model = |name: &String| ProviderModel {
        id: endpoint.model_id(name),
        display_name: name.clone(),
        context_window: Some(endpoint.context_window).filter(|w| *w > 0),
        effort_levels: Some(efforts.iter().map(|e| (*e).to_owned()).collect()),
        default_effort: None,
    };
    ProviderModels {
        id: endpoint.id.clone(),
        label: endpoint.label.clone(),
        ready,
        models: models.iter().map(model).collect(),
    }
}
