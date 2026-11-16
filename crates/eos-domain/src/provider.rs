//! The model providers reached with an API key: every `config.json` backend
//! that speaks the Chat Completions API (the OpenAI preset's sessions go on
//! its Responses API). A model of one is named `<provider>/<model>`.

use eos_contracts::{
    AuthRefKind, BackendKind, BackendProfile, ProviderCapabilitiesAuthStyle, ProviderCapabilitiesMaxTokensParam,
    ProviderCapabilitiesReasoning, ProviderCapabilitiesReasoningRoundTrip, ProviderCapabilitiesWire,
    ProviderPresetSummary,
};
use serde_json::json;

use crate::accounts::{PROVIDER_PRESETS, ProviderPreset};
use crate::config::Config;

/// Where chat completions are under a base URL that names no other place.
const CHAT_PATH: &str = "/v1/chat/completions";
/// Names the engine keeps for its own providers: a profile of one goes by `<name>-api`.
const TAKEN: &[&str] = &["openai", "anthropic"];

/// The levels a server that says it takes an effort, and names none, is offered.
const ANY_EFFORT: &[ModelEffort] =
    &[ModelEffort { models: "", style: Some(EffortStyle::Levels(&["low", "medium", "high"])) }];

/// How a model takes an effort.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffortStyle {
    /// `reasoning_effort`, one of these levels.
    Levels(&'static [&'static str]),
    /// A thinking budget in tokens for each level (`None`: none is sent,
    /// the model thinks as long as it may).
    Budgets(&'static [(&'static str, Option<u32>)]),
}

impl EffortStyle {
    pub fn levels(&self) -> Vec<&'static str> {
        match self {
            Self::Levels(levels) => levels.to_vec(),
            Self::Budgets(budgets) => budgets.iter().map(|(level, _)| *level).collect(),
        }
    }
}

/// The effort the models whose ids open with `models` take (`None`: none).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelEffort {
    pub models: &'static str,
    pub style: Option<EffortStyle>,
}

/// Where an endpoint's key is kept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EndpointKey {
    /// A Keychain service.
    Keychain(String),
    /// An environment variable.
    Env(String),
    /// The server asks for none (a local one).
    None,
}

/// One provider as sessions reach it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderEndpoint {
    /// What its models' ids open with.
    pub id: String,
    /// Its `config.json` backend.
    pub profile: String,
    pub label: String,
    pub base_url: String,
    pub chat_path: String,
    /// The header the key goes in (`None`: `Authorization: Bearer`).
    pub key_header: Option<&'static str>,
    pub key: EndpointKey,
    /// How its models take an effort: the first whose `models` a model opens with.
    pub efforts: &'static [ModelEffort],
    /// Sessions reach it on OpenAI's Responses API, at [`ProviderEndpoint::api_root`].
    pub responses: bool,
    /// A reply's reasoning goes back with it.
    pub replay_reasoning: bool,
    /// The reply's length is limited by `max_completion_tokens`.
    pub max_completion_tokens: bool,
    pub context_window: i64,
    pub max_tokens: Option<i64>,
    /// The model the profile names.
    pub model: String,
}

impl ProviderEndpoint {
    /// The id sessions know `model` (as the provider names it) by.
    pub fn model_id(&self, model: &str) -> String {
        format!("{}/{model}", self.id)
    }

    /// How `model` (as the provider names it) takes an effort.
    pub fn effort(&self, model: &str) -> Option<EffortStyle> {
        self.efforts.iter().find(|e| model.starts_with(e.models)).and_then(|e| e.style)
    }

    /// The API root its chat path sits under (`https://api.openai.com/v1`).
    pub fn api_root(&self) -> String {
        let beside = self.chat_path.strip_suffix("/chat/completions").unwrap_or_default();
        format!("{}{beside}", self.base_url)
    }
}

fn endpoint(name: &str, profile: &BackendProfile) -> Option<ProviderEndpoint> {
    let capabilities = profile.capabilities.as_ref()?;
    let chat = profile.kind == BackendKind::Openai && capabilities.wire == ProviderCapabilitiesWire::OpenaiChat;
    let base_url = profile.base_url.as_deref().filter(|_| chat)?;
    let auth = profile.auth.as_ref();
    let reference = auth.and_then(|a| a.r#ref.clone());
    let key = match (auth.map(|a| a.kind), reference) {
        (Some(AuthRefKind::Keychain), Some(service)) => EndpointKey::Keychain(service),
        (Some(AuthRefKind::Env), Some(variable)) => EndpointKey::Env(variable),
        (Some(AuthRefKind::None) | None, _) => EndpointKey::None,
        _ => return None,
    };
    let preset = match &key {
        EndpointKey::Keychain(service) => PROVIDER_PRESETS.iter().find(|p| p.auth_ref == service),
        _ => None,
    };
    Some(ProviderEndpoint {
        id: if TAKEN.contains(&name) { format!("{name}-api") } else { name.to_owned() },
        profile: name.to_owned(),
        label: preset.map_or(name, |p| p.label).to_owned(),
        base_url: base_url.trim_end_matches('/').to_owned(),
        chat_path: capabilities.chat_completions_path.clone().unwrap_or_else(|| CHAT_PATH.to_owned()),
        key_header: (capabilities.auth_style == Some(ProviderCapabilitiesAuthStyle::XGoogApiKey))
            .then_some("x-goog-api-key"),
        key,
        efforts: match preset {
            Some(preset) => preset.efforts,
            // An agent always has tools: a server that takes no effort with them gets none.
            None if capabilities.reasoning == ProviderCapabilitiesReasoning::OpenaiEffort
                && !capabilities.drop_reasoning_effort_with_tools =>
            {
                ANY_EFFORT
            }
            None => &[],
        },
        responses: preset.is_some_and(|p| p.responses),
        replay_reasoning: capabilities.reasoning_round_trip == ProviderCapabilitiesReasoningRoundTrip::PreserveSigned,
        max_completion_tokens: capabilities.max_tokens_param == ProviderCapabilitiesMaxTokensParam::MaxCompletionTokens,
        context_window: capabilities.context_window,
        max_tokens: capabilities.max_tokens,
        model: profile.model.clone(),
    })
}

/// Every provider `config` reaches with a key, in the file's order.
pub fn endpoints(config: &Config) -> Vec<ProviderEndpoint> {
    config.backends.iter().filter_map(|(name, profile)| endpoint(name, profile)).collect()
}

/// The endpoint a model id (`<provider>/<model>`) is one of, and the model as the provider names it.
pub fn endpoint_of<'a>(endpoints: &'a [ProviderEndpoint], model: &'a str) -> Option<(&'a ProviderEndpoint, &'a str)> {
    let (id, name) = model.split_once('/')?;
    endpoints.iter().find(|e| e.id == id).map(|e| (e, name))
}

pub fn preset_summary(preset: &ProviderPreset) -> ProviderPresetSummary {
    ProviderPresetSummary {
        id: preset.id.to_owned(),
        label: preset.label.to_owned(),
        kind: BackendKind::Openai,
        base_url: preset.base_url.to_owned(),
        default_model: preset.default_model.to_owned(),
    }
}

/// The `config.json` backend a preset is added as.
pub fn preset_profile(preset: &ProviderPreset) -> serde_json::Value {
    let mut capabilities = json!({
        "wire": "openai-chat",
        "supportsStreaming": true,
        "supportsTools": true,
        "supportsParallelToolCalls": true,
        "reasoning": preset.reasoning.0,
        "reasoningRoundTrip": preset.reasoning.1,
        "cache": "automatic",
        "structuredOutput": "none",
        "contextWindow": preset.context_window,
    });
    let optional = [
        ("chatCompletionsPath", preset.chat_path.map(serde_json::Value::from)),
        ("maxTokens", preset.max_tokens.map(serde_json::Value::from)),
        ("maxTokensParam", preset.max_tokens_param.map(serde_json::Value::from)),
        ("dropReasoningEffortWithTools", preset.drop_effort_with_tools.map(serde_json::Value::from)),
    ];
    for (key, value) in optional {
        if let Some(value) = value {
            capabilities[key] = value;
        }
    }
    json!({
        "kind": "openai",
        "model": preset.default_model,
        "baseUrl": preset.base_url,
        "auth": {"kind": "keychain", "ref": preset.auth_ref},
        "costMode": "billed",
        "capabilities": capabilities,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_preset_is_a_backend_the_file_takes_and_an_endpoint() {
        for preset in PROVIDER_PRESETS {
            let profile: BackendProfile = serde_json::from_value(preset_profile(preset)).expect("a backend profile");
            let endpoint = endpoint(preset.id, &profile).expect("an endpoint");
            assert_eq!(endpoint.label, preset.label);
            assert_eq!(endpoint.key, EndpointKey::Keychain(preset.auth_ref.to_owned()));
            assert_eq!(endpoint.context_window, preset.context_window);
        }
        let of = |id: &str| {
            let preset = PROVIDER_PRESETS.iter().find(|p| p.id == id).expect("the preset");
            endpoint(id, &serde_json::from_value(preset_profile(preset)).expect("a profile")).expect("an endpoint")
        };
        let openai = of("openai");
        assert_eq!(openai.id, "openai-api", "the engine's own ChatGPT provider keeps `openai`");
        assert!(openai.max_completion_tokens && openai.responses);
        assert_eq!(openai.api_root(), "https://api.openai.com/v1");
        assert_eq!(openai.model_id("gpt-5.5"), "openai-api/gpt-5.5");
        assert_eq!(openai.effort("gpt-5.5").map(|e| e.levels()), Some(vec!["low", "medium", "high", "xhigh"]));
        let gemini = of("gemini");
        assert_eq!(gemini.chat_path, "/chat/completions");
        assert_eq!(of("deepseek").chat_path, "/v1/chat/completions");
        assert!(!gemini.responses);
        let levels = |id: &str, model: &str| of(id).effort(model).map(|e| e.levels());
        assert_eq!(levels("deepseek", "deepseek-v4-flash"), Some(vec!["low", "high", "max"]));
        assert_eq!(levels("moonshot", "kimi-k2.6"), None, "K2 takes no effort");
        assert_eq!(levels("qwen", "qwen3.7-max"), Some(vec!["low", "medium", "high"]));
        assert_eq!(levels("xai", "grok-4.20-reasoning"), None);
        let all = [openai, gemini];
        assert_eq!(
            endpoint_of(&all, "gemini/gemini-3.1-pro-preview").map(|(e, m)| (e.id.as_str(), m)),
            Some(("gemini", "gemini-3.1-pro-preview"))
        );
        assert!(endpoint_of(&all, "claude-opus-5-5").is_none());
    }
}
