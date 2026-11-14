//! Wire types of the config routes.

use indexmap::IndexMap;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::backend::AuthRef;
use crate::canonical::BackendKind;
use crate::primitives::{BoolLit, Num, de};
use crate::provider_capabilities::ProviderCapabilities;
use crate::shared::UnknownRecord;
use crate::validate::{Issues, Validate};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelPrice {
    pub r#in: Num,
    pub out: Num,
    pub cache_read: Num,
    pub cache_create: Num,
    /// Sent by the daemon for models with a one-hour cache tier; the Zod schema does not list it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_create_1h: Option<Num>,
}

impl Validate for ModelPrice {
    fn validate(&self, cx: &mut Issues) {
        cx.at("in", |cx| cx.num_min(self.r#in, 0.0, true));
        cx.at("out", |cx| cx.num_min(self.out, 0.0, true));
        cx.at("cacheRead", |cx| cx.num_min(self.cache_read, 0.0, true));
        cx.at("cacheCreate", |cx| cx.num_min(self.cache_create, 0.0, true));
    }
}

/// One model's price in `GET /api/ui-config`. The Zod schema only describes the
/// flat form, but the daemon also sends prices that step up with the prompt size.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum ModelPricing {
    Flat(ModelPrice),
    Tiered { tiers: Vec<ModelPriceTier> },
}

impl Validate for ModelPricing {
    fn validate(&self, cx: &mut Issues) {
        match self {
            Self::Flat(price) => price.validate(cx),
            Self::Tiered { tiers } => cx.at("tiers", |cx| {
                for (i, tier) in tiers.iter().enumerate() {
                    cx.idx(i, |cx| cx.at("price", |cx| tier.price.validate(cx)));
                }
            }),
        }
    }
}

/// Prompts up to `max_input_tokens` (null = no upper bound) cost `price`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelPriceTier {
    #[serde(deserialize_with = "de::required")]
    pub max_input_tokens: Option<Num>,
    pub price: ModelPrice,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    pub id: String,
    pub display_name: String,
    pub created_at: String,
    #[serde(deserialize_with = "de::required")]
    pub max_input_tokens: Option<i64>,
    #[serde(deserialize_with = "de::required")]
    pub max_tokens: Option<i64>,
    #[serde(default)]
    pub effort_levels: Option<Vec<String>>,
}

impl Validate for CatalogModel {
    fn validate(&self, cx: &mut Issues) {
        cx.at("id", |cx| cx.str_min(&self.id, 1));
        cx.at("maxInputTokens", |cx| {
            if let Some(v) = &self.max_input_tokens {
                cx.int_min(*v, 0, false);
            }
        });
        cx.at("maxTokens", |cx| {
            if let Some(v) = &self.max_tokens {
                cx.int_min(*v, 0, false);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UiBackendDescriptor {
    pub kind: String,
    pub label: String,
    pub enabled: bool,
    pub billing: UiBackendDescriptorBilling,
    pub session_store: UiBackendDescriptorSessionStore,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wire_dialect: Option<UiBackendDescriptorWireDialect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog: Option<UiBackendDescriptorCatalog>,
    pub capabilities: UiBackendDescriptorCapabilities,
}

impl Validate for UiBackendDescriptor {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum UiBackendDescriptorBilling {
    Subscription,
    Metered,
}

impl Validate for UiBackendDescriptorBilling {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum UiBackendDescriptorSessionStore {
    ClaudeTranscript,
    None,
    EosConversation,
    CodexThread,
    GeminiSession,
}

impl Validate for UiBackendDescriptorSessionStore {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum UiBackendDescriptorWireDialect {
    Anthropic,
    OpenaiChat,
}

impl Validate for UiBackendDescriptorWireDialect {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum UiBackendDescriptorCatalog {
    Claude,
    Static,
    OpenaiCompatible,
}

impl Validate for UiBackendDescriptorCatalog {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UiBackendDescriptorCapabilities {
    pub interrupt: bool,
    pub keystroke: bool,
    pub rewind: bool,
    pub runtime_model_switch: bool,
    pub runtime_permission_switch: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reports_message_events: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub streaming_thinking: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resumable: Option<bool>,
    // Sent by the daemon for the lanes that have them; the Zod schema does not list these.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_switch: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_clear: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_compaction: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expands_slash_templates: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side_question: Option<bool>,
}

impl Validate for UiBackendDescriptorCapabilities {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UiBackendProfile {
    pub name: String,
    pub kind: String,
    pub model: String,
    pub label: String,
}

impl Validate for UiBackendProfile {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UiConfigResponse {
    pub models: Vec<String>,
    pub model_catalog: Vec<CatalogModel>,
    pub prices: IndexMap<String, ModelPricing>,
    pub permissions: UiConfigResponsePermissions,
    pub sse: UiConfigResponseSse,
    #[serde(default)]
    pub backends: Vec<UiBackendDescriptor>,
    #[serde(default)]
    pub backend_profiles: Vec<UiBackendProfile>,
    #[serde(default = "ui_config_response_features_default")]
    pub features: UiConfigResponseFeatures,
}

fn ui_config_response_features_default() -> UiConfigResponseFeatures {
    UiConfigResponseFeatures { remote: true, posix_shell: true }
}

impl Validate for UiConfigResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("modelCatalog", |cx| self.model_catalog.validate(cx));
        cx.at("prices", |cx| self.prices.validate(cx));
        cx.at("permissions", |cx| self.permissions.validate(cx));
        cx.at("sse", |cx| self.sse.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UiConfigResponsePermissions {
    pub default_ttl_ms: i64,
}

impl Validate for UiConfigResponsePermissions {
    fn validate(&self, cx: &mut Issues) {
        cx.at("defaultTtlMs", |cx| cx.int_min(self.default_ttl_ms, 0, false));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UiConfigResponseSse {
    pub keepalive_ms: i64,
}

impl Validate for UiConfigResponseSse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("keepaliveMs", |cx| cx.int_min(self.keepalive_ms, 0, false));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UiConfigResponseFeatures {
    pub remote: bool,
    pub posix_shell: bool,
}

impl Validate for UiConfigResponseFeatures {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddBackendRequest {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<BackendKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<AuthRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_mode: Option<AddBackendRequestCostMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<UnknownRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<ProviderCapabilities>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price: Option<ModelPrice>,
}

impl Validate for AddBackendRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("name", |cx| cx.str_min(&self.name, 1));
        cx.at("model", |cx| {
            if let Some(v) = &self.model {
                cx.str_min(v, 1);
            }
        });
        cx.at("baseUrl", |cx| {
            if let Some(v) = &self.base_url {
                cx.url(v);
            }
        });
        cx.at("capabilities", |cx| {
            if let Some(v) = &self.capabilities {
                v.validate(cx);
            }
        });
        cx.at("price", |cx| {
            if let Some(v) = &self.price {
                v.validate(cx);
            }
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AddBackendRequestCostMode {
    Billed,
    Included,
}

impl Validate for AddBackendRequestCostMode {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPresetSummary {
    pub id: String,
    pub label: String,
    pub kind: BackendKind,
    pub base_url: String,
    pub default_model: String,
}

impl Validate for ProviderPresetSummary {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BackendPresetsResponse {
    pub presets: Vec<ProviderPresetSummary>,
}

impl Validate for BackendPresetsResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AddBackendResponse {
    pub name: String,
    pub kind: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

impl Validate for AddBackendResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BackendModelsResponse {
    pub models: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prices: Option<IndexMap<String, BackendModelsResponsePricesValue>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Validate for BackendModelsResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BackendModelsResponsePricesValue {
    pub r#in: Num,
    pub out: Num,
}

impl Validate for BackendModelsResponsePricesValue {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestBackendRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<BackendKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<ProviderCapabilities>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
}

impl Validate for TestBackendRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("baseUrl", |cx| {
            if let Some(v) = &self.base_url {
                cx.url(v);
            }
        });
        cx.at("model", |cx| {
            if let Some(v) = &self.model {
                cx.str_min(v, 1);
            }
        });
        cx.at("capabilities", |cx| {
            if let Some(v) = &self.capabilities {
                v.validate(cx);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum TestBackendResponse {
    True(TestBackendResponseTrue),
    False(TestBackendResponseFalse),
}

impl Validate for TestBackendResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TestBackendResponseTrue {
    pub ok: BoolLit<true>,
    pub models: Vec<String>,
}

impl Validate for TestBackendResponseTrue {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TestBackendResponseFalse {
    pub ok: BoolLit<false>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<Num>,
    pub error: String,
}

impl Validate for TestBackendResponseFalse {}
