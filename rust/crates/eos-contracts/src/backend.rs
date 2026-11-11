//! Port of `contracts/src/backend.ts`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::canonical::BackendKind;
use crate::provider_capabilities::ProviderCapabilities;
use crate::shared::UnknownRecord;
use crate::validate::{Issues, Validate};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AuthRef {
    pub kind: AuthRefKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<String>,
}

impl Validate for AuthRef {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AuthRefKind {
    Subscription,
    Env,
    Keychain,
    None,
}

impl Validate for AuthRefKind {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackendProfile {
    pub kind: BackendKind,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<AuthRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pricing: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_mode: Option<BackendProfileCostMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<UnknownRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<ProviderCapabilities>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tiers: Option<Vec<BackendProfileTiersItem>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_tier: Option<String>,
}

impl Validate for BackendProfile {
    fn validate(&self, cx: &mut Issues) {
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
        cx.at("tiers", |cx| {
            if let Some(v) = &self.tiers {
                cx.arr_min(v.len(), 1);
                v.validate(cx);
            }
        });
        cx.at("defaultTier", |cx| {
            if let Some(v) = &self.default_tier {
                cx.str_min(v, 1);
            }
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum BackendProfileCostMode {
    Billed,
    Included,
}

impl Validate for BackendProfileCostMode {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BackendProfileTiersItem {
    pub name: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

impl Validate for BackendProfileTiersItem {
    fn validate(&self, cx: &mut Issues) {
        cx.at("name", |cx| cx.str_min(&self.name, 1));
        cx.at("model", |cx| cx.str_min(&self.model, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BackendDefaults {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orchestrator: Option<BackendDefaultsOrchestrator>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker: Option<BackendDefaultsWorker>,
}

impl Validate for BackendDefaults {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BackendDefaultsOrchestrator {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
}

impl Validate for BackendDefaultsOrchestrator {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BackendDefaultsWorker {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
}

impl Validate for BackendDefaultsWorker {}
