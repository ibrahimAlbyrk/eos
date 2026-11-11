//! Port of `contracts/src/anthropic.ts`.

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
