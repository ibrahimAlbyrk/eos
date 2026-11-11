//! Port of `contracts/src/http.ts` (system).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::primitives::{BoolLit, Num, de};
use crate::remote::LiveBlock;
use crate::validate::{Issues, Validate};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub ok: BoolLit<true>,
    pub pid: i64,
    pub started_at: Num,
    pub source_stamp: String,
    /// Not in the Zod schema, but in every answer: the process's file descriptors.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fds: Option<HealthFds>,
}

impl Validate for HealthResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HealthFds {
    #[serde(deserialize_with = "de::required")]
    pub open: Option<Num>,
    #[serde(deserialize_with = "de::required")]
    pub limit: Option<Num>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ErrorResponse {
    pub error: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    /// A machine-readable reason some routes add (`forbidden`, `plugin_off`, `EMFILE`…).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// What else a route puts beside `error` (`path` on a 404, `limit` on a 413, `problems`…).
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

impl Validate for ErrorResponse {}

impl ErrorResponse {
    pub fn new(error: impl Into<String>) -> Self {
        Self { error: error.into(), request_id: None, code: None, extra: serde_json::Map::new() }
    }
}

/// What a body that failed validation answers: `400 {"error": "invalid request: …"}`.
impl From<&crate::ValidationError> for ErrorResponse {
    fn from(e: &crate::ValidationError) -> Self {
        Self::new(e.message())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CurrentDateTimeResponse {
    pub epoch_ms: i64,
    pub iso: String,
    pub utc: String,
    pub time_zone: String,
    pub utc_offset_minutes: i64,
    pub formatted: String,
}

impl Validate for CurrentDateTimeResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StreamFocusRequest {
    pub client_id: String,
    pub workers: Vec<String>,
    pub ptys: Vec<String>,
}

impl Validate for StreamFocusRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("clientId", |cx| {
            cx.str_min(&self.client_id, 1);
            cx.str_max(&self.client_id, 128);
        });
        cx.at("workers", |cx| cx.arr_max(self.workers.len(), 64));
        cx.at("ptys", |cx| cx.arr_max(self.ptys.len(), 64));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct StreamFocusResponse {
    pub live: Vec<LiveBlock>,
}

impl Validate for StreamFocusResponse {}
