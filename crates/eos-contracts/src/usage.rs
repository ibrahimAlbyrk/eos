use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::primitives::{Num, de};
use crate::validate::Validate;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub utilization: Num,
    #[serde(deserialize_with = "de::required")]
    pub resets_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub severity: Option<String>,
}

impl Validate for UsageWindow {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsageWindow {
    pub utilization: Num,
    #[serde(deserialize_with = "de::required")]
    pub resets_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub severity: Option<String>,
    pub model: String,
}

impl Validate for ModelUsageWindow {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    pub windows: ProviderUsageWindows,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_usage: Option<ProviderUsageExtraUsage>,
    pub fetched_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stale: Option<bool>,
}

impl Validate for ProviderUsage {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsageWindows {
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub five_hour: Option<Option<UsageWindow>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub seven_day: Option<Option<UsageWindow>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weekly_by_model: Option<Vec<ModelUsageWindow>>,
}

impl Validate for ProviderUsageWindows {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsageExtraUsage {
    pub is_enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub used_credits: Option<Option<Num>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub monthly_limit: Option<Option<Num>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
}

impl Validate for ProviderUsageExtraUsage {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UsageError {
    pub provider: String,
    pub reason: String,
}

impl Validate for UsageError {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UsageResponse {
    pub providers: Vec<ProviderUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub errors: Option<Vec<UsageError>>,
}

impl Validate for UsageResponse {}
