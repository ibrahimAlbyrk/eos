//! Port of `contracts/src/provider-capabilities.ts`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::primitives::yes;
use crate::validate::{Issues, Validate};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderCapabilities {
    pub wire: ProviderCapabilitiesWire,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_style: Option<ProviderCapabilitiesAuthStyle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_completions_path: Option<String>,
    #[serde(default = "yes")]
    pub supports_streaming: bool,
    #[serde(default = "yes")]
    pub supports_tools: bool,
    #[serde(default = "yes")]
    pub supports_parallel_tool_calls: bool,
    #[serde(default = "provider_capabilities_reasoning_default")]
    pub reasoning: ProviderCapabilitiesReasoning,
    #[serde(default = "provider_capabilities_reasoning_round_trip_default")]
    pub reasoning_round_trip: ProviderCapabilitiesReasoningRoundTrip,
    #[serde(default = "provider_capabilities_cache_default")]
    pub cache: ProviderCapabilitiesCache,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_min_tokens: Option<i64>,
    #[serde(default = "provider_capabilities_structured_output_default")]
    pub structured_output: ProviderCapabilitiesStructuredOutput,
    pub context_window: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_idle_timeout_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<i64>,
    #[serde(default = "provider_capabilities_max_tokens_param_default")]
    pub max_tokens_param: ProviderCapabilitiesMaxTokensParam,
    #[serde(default)]
    pub drop_reasoning_effort_with_tools: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<ProviderCapabilitiesRetry>,
}

fn provider_capabilities_reasoning_default() -> ProviderCapabilitiesReasoning {
    ProviderCapabilitiesReasoning::None
}

fn provider_capabilities_reasoning_round_trip_default() -> ProviderCapabilitiesReasoningRoundTrip {
    ProviderCapabilitiesReasoningRoundTrip::Drop
}

fn provider_capabilities_cache_default() -> ProviderCapabilitiesCache {
    ProviderCapabilitiesCache::Automatic
}

fn provider_capabilities_structured_output_default() -> ProviderCapabilitiesStructuredOutput {
    ProviderCapabilitiesStructuredOutput::None
}

fn provider_capabilities_max_tokens_param_default() -> ProviderCapabilitiesMaxTokensParam {
    ProviderCapabilitiesMaxTokensParam::MaxTokens
}

impl Validate for ProviderCapabilities {
    fn validate(&self, cx: &mut Issues) {
        cx.at("cacheMinTokens", |cx| {
            if let Some(v) = &self.cache_min_tokens {
                cx.int_min(*v, 0, true);
            }
        });
        cx.at("contextWindow", |cx| cx.int_min(self.context_window, 0, false));
        cx.at("streamIdleTimeoutMs", |cx| {
            if let Some(v) = &self.stream_idle_timeout_ms {
                cx.int_min(*v, 0, false);
            }
        });
        cx.at("maxTokens", |cx| {
            if let Some(v) = &self.max_tokens {
                cx.int_min(*v, 0, false);
            }
        });
        cx.at("retry", |cx| {
            if let Some(v) = &self.retry {
                v.validate(cx);
            }
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderCapabilitiesWire {
    Anthropic,
    OpenaiChat,
}

impl Validate for ProviderCapabilitiesWire {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderCapabilitiesAuthStyle {
    Bearer,
    XGoogApiKey,
}

impl Validate for ProviderCapabilitiesAuthStyle {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub enum ProviderCapabilitiesReasoning {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "openai-effort")]
    OpenaiEffort,
    #[serde(rename = "anthropic-thinking")]
    AnthropicThinking,
    #[serde(rename = "reasoning_content")]
    ReasoningContent,
}

impl Validate for ProviderCapabilitiesReasoning {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderCapabilitiesReasoningRoundTrip {
    Drop,
    PreserveSigned,
    None,
}

impl Validate for ProviderCapabilitiesReasoningRoundTrip {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderCapabilitiesCache {
    None,
    AnthropicExplicit,
    Automatic,
}

impl Validate for ProviderCapabilitiesCache {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub enum ProviderCapabilitiesStructuredOutput {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "openai-response_format")]
    OpenaiResponseFormat,
    #[serde(rename = "anthropic-output_config")]
    AnthropicOutputConfig,
    #[serde(rename = "vllm-guided_json")]
    VllmGuidedJson,
    #[serde(rename = "ollama-format")]
    OllamaFormat,
}

impl Validate for ProviderCapabilitiesStructuredOutput {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProviderCapabilitiesMaxTokensParam {
    MaxTokens,
    MaxCompletionTokens,
}

impl Validate for ProviderCapabilitiesMaxTokensParam {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderCapabilitiesRetry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_retries: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cap_ms: Option<i64>,
}

impl Validate for ProviderCapabilitiesRetry {
    fn validate(&self, cx: &mut Issues) {
        cx.at("maxRetries", |cx| {
            if let Some(v) = &self.max_retries {
                cx.int_min(*v, 0, true);
            }
        });
        cx.at("baseMs", |cx| {
            if let Some(v) = &self.base_ms {
                cx.int_min(*v, 0, false);
            }
        });
        cx.at("capMs", |cx| {
            if let Some(v) = &self.cap_ms {
                cx.int_min(*v, 0, false);
            }
        });
    }
}
