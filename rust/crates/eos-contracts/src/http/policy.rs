//! Port of `contracts/src/http.ts` (policy).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::policy::{Decision, ExternalDecision};
use crate::primitives::de;
use crate::shared::UnknownRecord;
use crate::validate::{Issues, Validate};
use crate::worker::PendingPermissionRow;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PolicyDecideRequest {
    pub worker_id: String,
    pub tool_name: String,
    pub input: UnknownRecord,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub tool_use_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub agent_id: Option<Option<String>>,
}

impl Validate for PolicyDecideRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PolicyRuleRequest {
    pub tool: String,
    pub behavior: String,
}

impl Validate for PolicyRuleRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("tool", |cx| cx.str_min(&self.tool, 1));
        cx.at("behavior", |cx| cx.str_min(&self.behavior, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PolicyRuleResponse {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub existed: Option<bool>,
}

impl Validate for PolicyRuleResponse {}

pub type PendingListResponse = Vec<PendingPermissionRow>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PendingDecisionRequest {
    pub decision: PendingDecisionRequestDecision,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_input: Option<UnknownRecord>,
}

impl Validate for PendingDecisionRequest {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum PendingDecisionRequestDecision {
    Allow,
    Deny,
}

impl Validate for PendingDecisionRequestDecision {}

pub type PolicyDecideResponse = ExternalDecision;

pub type InternalDecision = Decision;
