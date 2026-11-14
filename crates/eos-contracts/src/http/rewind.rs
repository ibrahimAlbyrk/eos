//! Wire types of the rewind routes.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::primitives::Num;
use crate::validate::{Issues, Validate};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RewindTarget {
    pub uuid: String,
    pub text: String,
    pub display: String,
    pub ts: String,
    pub up_count: i64,
}

impl Validate for RewindTarget {
    fn validate(&self, cx: &mut Issues) {
        cx.at("upCount", |cx| cx.int_min(self.up_count, 0, false));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RewindTargetsResponse {
    pub targets: Vec<RewindTarget>,
}

impl Validate for RewindTargetsResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("targets", |cx| self.targets.validate(cx));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum RewindMode {
    Conversation,
    Code,
    Both,
}

impl Validate for RewindMode {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RewindRequest {
    pub uuid: String,
    #[serde(default = "rewind_request_mode_default")]
    pub mode: RewindMode,
}

fn rewind_request_mode_default() -> RewindMode {
    RewindMode::Conversation
}

impl Validate for RewindRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RewindResponse {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Validate for RewindResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("index", |cx| {
            if let Some(v) = &self.index {
                cx.int_min(*v, 0, true);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ActiveTry {
    pub worker_id: String,
    pub branch: String,
    pub base_head: String,
    pub files: Vec<String>,
    pub lockfile_changed: bool,
    pub created_at: Num,
}

impl Validate for ActiveTry {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TryPreviewResponse {
    pub supported: bool,
    pub ahead: i64,
    pub behind: i64,
    pub conflicts: Vec<String>,
    pub files: Vec<String>,
    pub lockfile_changed: bool,
    pub active_tries: Vec<ActiveTry>,
}

impl Validate for TryPreviewResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("ahead", |cx| cx.int_min(self.ahead, 0, true));
        cx.at("behind", |cx| cx.int_min(self.behind, 0, true));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TryApplyResponse {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lockfile_changed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl Validate for TryApplyResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TryTargetRequest {
    pub worker_id: String,
}

impl Validate for TryTargetRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TryDiscardResponse {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl Validate for TryDiscardResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TryKeepResponse {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl Validate for TryKeepResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TryStateResponse {
    pub active_tries: Vec<ActiveTry>,
    pub kept: bool,
    pub syncable: bool,
    pub sync_files: Vec<String>,
}

impl Validate for TryStateResponse {}
