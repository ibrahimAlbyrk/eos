use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::validate::Validate;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AnthropicConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_token: Option<String>,
}

impl Validate for AnthropicConfig {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AnthropicConfigStatus {
    pub api_key_set: bool,
    pub auth_token_set: bool,
}

impl Validate for AnthropicConfigStatus {}

/// What the app may write of the Claude credentials (`PUT /api/anthropic/config`):
/// a field that is absent stays, a blank one is cleared.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnthropicConfigPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_token: Option<String>,
}

impl Validate for AnthropicConfigPatch {}
