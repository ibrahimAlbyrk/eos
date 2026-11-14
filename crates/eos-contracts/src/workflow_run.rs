use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::canonical::{SubagentUsage, WorkflowRunSnapshot};
use crate::http::terminal::PtyConversationRow;
use crate::primitives::Num;
use crate::validate::{Issues, Validate};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowRunStatus {
    Running,
    Completed,
    Failed,
    Stopped,
}

impl Validate for WorkflowRunStatus {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunProgress {
    pub worker_id: String,
    pub call_id: String,
    pub task_id: String,
    pub status: WorkflowRunStatus,
    pub snapshot: WorkflowRunSnapshot,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<SubagentUsage>,
    pub updated_at: Num,
}

impl Validate for WorkflowRunProgress {
    fn validate(&self, cx: &mut Issues) {
        cx.at("snapshot", |cx| self.snapshot.validate(cx));
        cx.at("usage", |cx| {
            if let Some(v) = &self.usage {
                v.validate(cx);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunDetail {
    pub call_id: String,
    pub task_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub status: WorkflowRunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<Num>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<Num>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<SubagentUsage>,
    pub snapshot: WorkflowRunSnapshot,
    pub can_stop: bool,
}

impl Validate for WorkflowRunDetail {
    fn validate(&self, cx: &mut Issues) {
        cx.at("usage", |cx| {
            if let Some(v) = &self.usage {
                v.validate(cx);
            }
        });
        cx.at("snapshot", |cx| self.snapshot.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WorkflowRunList {
    pub runs: Vec<WorkflowRunDetail>,
}

impl Validate for WorkflowRunList {
    fn validate(&self, cx: &mut Issues) {
        cx.at("runs", |cx| self.runs.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WorkflowAgentRows {
    pub rows: Vec<PtyConversationRow>,
}

impl Validate for WorkflowAgentRows {
    fn validate(&self, cx: &mut Issues) {
        cx.at("rows", |cx| self.rows.validate(cx));
    }
}

pub const WORKFLOW_AGENT_ROWS_MAX: i64 = 200;

pub const WORKFLOW_AGENT_ID_RE: &str = r"^[a-z0-9]{6,40}$";

/// Bus topic: the latest snapshot of a running Workflow, and once more with its end status.
pub const WORKFLOW_RUN_PROGRESS_TOPIC: &str = "workflow:progress";
