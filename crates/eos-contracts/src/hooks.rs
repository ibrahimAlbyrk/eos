use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::primitives::{de, str_lit};
use crate::shared::UnknownRecord;
use crate::validate::Validate;

str_lit!(pub PermissionRequestLit = "PermissionRequest");
str_lit!(pub AllowLit = "allow");
str_lit!(pub DenyLit = "deny");

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PermissionRequestHookInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hook_event_name: Option<PermissionRequestLit>,
    pub tool_name: String,
    #[serde(default)]
    pub tool_input: UnknownRecord,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub tool_use_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Keys this version does not know; kept so a round trip loses nothing.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

impl Validate for PermissionRequestHookInput {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum HookDecision {
    Allow(HookDecisionAllow),
    Deny(HookDecisionDeny),
}

impl Validate for HookDecision {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HookDecisionAllow {
    pub behavior: AllowLit,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl Validate for HookDecisionAllow {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HookDecisionDeny {
    pub behavior: DenyLit,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl Validate for HookDecisionDeny {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequestHookOutput {
    pub hook_specific_output: PermissionRequestHookOutputHookSpecificOutput,
}

impl Validate for PermissionRequestHookOutput {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequestHookOutputHookSpecificOutput {
    pub hook_event_name: PermissionRequestLit,
    pub decision: HookDecision,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_input: Option<UnknownRecord>,
}

impl Validate for PermissionRequestHookOutputHookSpecificOutput {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HttpHookEventQuery {
    pub event: String,
}

impl Validate for HttpHookEventQuery {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HttpHookEventBody {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    /// Keys this version does not know; kept so a round trip loses nothing.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

impl Validate for HttpHookEventBody {}
