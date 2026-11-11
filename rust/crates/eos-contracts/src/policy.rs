//! Port of `contracts/src/policy.ts`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::primitives::de;
use crate::shared::UnknownRecord;
use crate::validate::{Issues, Validate};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum PolicyBehavior {
    Allow,
    Deny,
    Ask,
    Rewrite,
}

impl Validate for PolicyBehavior {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PolicyRule {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#match: Option<PolicyRuleMatch>,
    pub behavior: PolicyBehavior,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::some")]
    pub rewrite: Option<Value>,
}

impl Validate for PolicyRule {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PolicyRuleMatch {
    pub tool: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
}

impl Validate for PolicyRuleMatch {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PolicyFile {
    #[serde(default = "policy_file_default_default")]
    pub default: PolicyBehavior,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl_ms: Option<i64>,
    #[serde(default)]
    pub rules: Vec<PolicyRule>,
}

fn policy_file_default_default() -> PolicyBehavior {
    PolicyBehavior::Ask
}

impl Validate for PolicyFile {
    fn validate(&self, cx: &mut Issues) {
        cx.at("ttlMs", |cx| {
            if let Some(v) = &self.ttl_ms {
                cx.int_min(*v, 0, false);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AllowVariant {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_input: Option<UnknownRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl Validate for AllowVariant {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DenyVariant {
    pub message: String,
}

impl Validate for DenyVariant {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "behavior", rename_all = "lowercase")]
pub enum Decision {
    Allow(AllowVariant),
    Deny(DenyVariant),
    Ask,
}

impl Validate for Decision {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "behavior", rename_all = "lowercase")]
pub enum ExternalDecision {
    Allow(AllowVariant),
    Deny(DenyVariant),
}

impl Validate for ExternalDecision {}
