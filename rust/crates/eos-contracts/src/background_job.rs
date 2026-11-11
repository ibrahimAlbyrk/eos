//! Port of `contracts/src/background-job.ts`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::primitives::{Num, de};
use crate::validate::{Issues, Validate, re};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct BackgroundJobKind(pub String);

impl Validate for BackgroundJobKind {
    fn validate(&self, cx: &mut Issues) {
        cx.regex(&self.0, re!(r"^[a-z][a-z0-9-]{0,39}$"), None);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum BackgroundJobStatus {
    Running,
    Completed,
    Failed,
    Stopped,
}

impl Validate for BackgroundJobStatus {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundJob {
    pub id: String,
    pub kind: BackgroundJobKind,
    pub status: BackgroundJobStatus,
    #[serde(deserialize_with = "de::required")]
    pub worker_id: Option<String>,
    pub title: String,
    #[serde(deserialize_with = "de::required")]
    pub command: Option<String>,
    #[serde(deserialize_with = "de::required")]
    pub detail: Option<String>,
    pub started_at: Num,
    #[serde(deserialize_with = "de::required")]
    pub ended_at: Option<Num>,
    #[serde(deserialize_with = "de::required")]
    pub progress: Option<BackgroundJobProgress>,
    #[serde(deserialize_with = "de::required")]
    pub exit_code: Option<i64>,
    #[serde(deserialize_with = "de::required")]
    pub call_id: Option<String>,
    pub has_output: bool,
    pub can_stop: bool,
}

impl Validate for BackgroundJob {
    fn validate(&self, cx: &mut Issues) {
        cx.at("kind", |cx| self.kind.validate(cx));
        cx.at("progress", |cx| {
            if let Some(v) = &self.progress {
                v.validate(cx);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BackgroundJobProgress {
    pub done: Num,
    pub total: Num,
}

impl Validate for BackgroundJobProgress {
    fn validate(&self, cx: &mut Issues) {
        cx.at("done", |cx| cx.num_min(self.done, 0.0, true));
        cx.at("total", |cx| cx.num_min(self.total, 0.0, true));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BackgroundJobList {
    pub jobs: Vec<BackgroundJob>,
}

impl Validate for BackgroundJobList {
    fn validate(&self, cx: &mut Issues) {
        cx.at("jobs", |cx| self.jobs.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BackgroundJobOutput {
    pub text: String,
    pub next: i64,
    pub truncated: bool,
    pub reset: bool,
}

impl Validate for BackgroundJobOutput {
    fn validate(&self, cx: &mut Issues) {
        cx.at("next", |cx| cx.int_min(self.next, 0, true));
    }
}

pub const BACKGROUND_JOB_OUTPUT_MAX: i64 = 65536;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BackgroundJobChange {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job: Option<BackgroundJob>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed: Option<Vec<String>>,
}

impl Validate for BackgroundJobChange {
    fn validate(&self, cx: &mut Issues) {
        cx.at("job", |cx| {
            if let Some(v) = &self.job {
                v.validate(cx);
            }
        });
    }
}

/// Bus topic: one job's new state, or ids dropped from the list.
pub const BACKGROUND_JOB_CHANGE_TOPIC: &str = "jobs:change";
