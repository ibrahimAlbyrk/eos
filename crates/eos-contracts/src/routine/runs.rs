//! Starting runs, and the topics that say how runs move.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::{ItemRef, RunInput};
use crate::validate::{Issues, Validate};

/// `POST /api/runs`: one run, or one per item.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StartRunRequest {
    pub routine_id: String,
    pub input: RunInput,
    /// Several items, one run each.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items: Option<Vec<ItemRef>>,
    /// The run this one does again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub again_of: Option<String>,
    /// Where the user started it (`home`, `routine_page`, …).
    pub door: String,
    /// Start although the routine handled the same item lately.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_repeat: Option<bool>,
    /// The same id again answers the runs the first request made.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_request_id: Option<String>,
}

impl Validate for StartRunRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("input", |cx| self.input.validate(cx));
        cx.at("items", |cx| self.items.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StartRunResponse {
    pub runs: Vec<StartedRun>,
}

impl Validate for StartRunResponse {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StartedRun {
    pub id: String,
    /// `queued`: a run starts once the supervisor lets it.
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not_before: Option<i64>,
}

impl Validate for StartedRun {}

/// `run:change`: a run moved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunChange {
    pub run_id: String,
    pub routine_id: String,
    pub state: String,
    /// None while it waits in the queue.
    pub station: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub needs_user: Option<bool>,
}

impl Validate for RunChange {}

/// `runs:active`: how many runs work, and how many wait on the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunsActive {
    pub count: i64,
    pub needs_user: i64,
}

impl Validate for RunsActive {}
