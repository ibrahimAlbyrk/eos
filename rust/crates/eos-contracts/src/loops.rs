//! Port of `contracts/src/loop.ts`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::primitives::{Num, de};
use crate::validate::{Issues, Validate};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum LoopStatus {
    Active,
    Passed,
    Exhausted,
    Stopped,
}

impl Validate for LoopStatus {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum LoopStrategy {
    Command,
    Judge,
    Hybrid,
}

impl Validate for LoopStrategy {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct GoalSpec {
    pub summary: String,
    pub criteria: Vec<GoalSpecCriteriaItem>,
}

impl Validate for GoalSpec {
    fn validate(&self, cx: &mut Issues) {
        cx.at("criteria", |cx| cx.arr_min(self.criteria.len(), 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct GoalSpecCriteriaItem {
    pub id: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verify: Option<String>,
}

impl Validate for GoalSpecCriteriaItem {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct GoalVerdict {
    pub met: bool,
    pub criteria: Vec<GoalVerdictCriteriaItem>,
    pub unmet: Vec<String>,
    pub confidence: Num,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub indeterminate: Option<bool>,
}

impl Validate for GoalVerdict {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct GoalVerdictCriteriaItem {
    pub id: String,
    pub met: bool,
    pub evidence: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unverifiable: Option<bool>,
}

impl Validate for GoalVerdictCriteriaItem {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DynamicLoopRequest {
    pub op: DynamicLoopRequestOp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<GoalSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strategy: Option<LoopStrategy>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub limit: Option<Option<i64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loop_id: Option<String>,
}

impl Validate for DynamicLoopRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("goal", |cx| {
            if let Some(v) = &self.goal {
                v.validate(cx);
            }
        });
        cx.at("limit", |cx| {
            if let Some(Some(v)) = &self.limit {
                cx.int_min(*v, 0, false);
            }
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum DynamicLoopRequestOp {
    Attach,
    Amend,
    Stop,
}

impl Validate for DynamicLoopRequestOp {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DynamicLoopResponse {
    pub loop_id: String,
    pub status: LoopStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warnings: Option<Vec<String>>,
}

impl Validate for DynamicLoopResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SpawnLoop {
    pub goal: GoalSpec,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strategy: Option<LoopStrategy>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub limit: Option<Option<i64>>,
}

impl Validate for SpawnLoop {
    fn validate(&self, cx: &mut Issues) {
        cx.at("goal", |cx| self.goal.validate(cx));
        cx.at("limit", |cx| {
            if let Some(Some(v)) = &self.limit {
                cx.int_min(*v, 0, false);
            }
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum LoopCheckPhase {
    Started,
    Verifying,
    Judging,
    Verdict,
}

impl Validate for LoopCheckPhase {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum LoopCheckOutcome {
    Released,
    Continued,
    Exhausted,
    Escalated,
}

impl Validate for LoopCheckOutcome {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LoopCheckProgress {
    pub worker_id: String,
    pub attempt: i64,
    #[serde(deserialize_with = "de::required")]
    pub max_attempts: Option<i64>,
    pub strategy: LoopStrategy,
    pub phase: LoopCheckPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub criterion_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub met: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<LoopCheckOutcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl Validate for LoopCheckProgress {
    fn validate(&self, cx: &mut Issues) {
        cx.at("attempt", |cx| cx.int_min(self.attempt, 0, true));
        cx.at("maxAttempts", |cx| {
            if let Some(v) = &self.max_attempts {
                cx.int_min(*v, 0, false);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LoopCheckEvent {
    pub attempt: i64,
    #[serde(deserialize_with = "de::required")]
    pub max_attempts: Option<i64>,
    pub strategy: LoopStrategy,
    pub met: bool,
    pub outcome: LoopCheckOutcome,
    pub reason: String,
}

impl Validate for LoopCheckEvent {
    fn validate(&self, cx: &mut Issues) {
        cx.at("attempt", |cx| cx.int_min(self.attempt, 0, true));
        cx.at("maxAttempts", |cx| {
            if let Some(v) = &self.max_attempts {
                cx.int_min(*v, 0, false);
            }
        });
    }
}
