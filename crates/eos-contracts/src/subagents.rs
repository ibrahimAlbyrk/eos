//! The conversation-wide lists of a chat as summaries: its subagents and the
//! claude.ai artifacts it published (`GET /workers/:id/subagents`,
//! `GET /workers/:id/artifacts`). Routes of the Rust core only; today's daemon
//! sends the rows they are built from (`/workers/:id/subagent-events`) and
//! the dashboard derives them itself (`collectSubagents`, `collectArtifacts`
//! in `app/ui/src/lib`). These are what those yield, without the bodies the
//! lists never show: a subagent's prompt, its report and its tools' inputs
//! and outputs come with its own rows (`/workers/:id/subagents/:callId/events`).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::primitives::Num;
use crate::validate::Validate;

/// One time a subagent worked: the dashboard's `agentRun` block in brief.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRun {
    /// The call that started this run (the subagent's own call for its first).
    pub tool_use_id: String,
    /// The subagent's first run's description.
    pub description: String,
    /// The run of the same subagent this one continues.
    pub resume_of: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub subagent_type: Option<String>,
    /// `running`, or how it ended (`completed`, `failed`, `stopped`, …).
    pub status: String,
    pub background: bool,
    /// The lane's own figures (`totalTokens`, `toolUses`, `durationMs`) as reported.
    pub usage: Value,
    pub end_ts: Option<Num>,
    pub ts: Num,
    /// How many tools the run started.
    pub tool_count: u32,
    /// When its last tool started.
    pub last_tool_ts: Option<Num>,
    /// While it runs: the tool it is on (or ran last).
    pub activity: Option<SubagentActivity>,
}

impl Validate for SubagentRun {}

/// The tool a running subagent is on, enough to word it: its name and the
/// plain values of its input (texts cut to [`ACTIVITY_TEXT_MAX`] UTF-16 units,
/// numbers, booleans; nested values left out).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SubagentActivity {
    pub name: String,
    pub input: Value,
}

impl Validate for SubagentActivity {}

/// The longest text an activity's input keeps, in UTF-16 units.
pub const ACTIVITY_TEXT_MAX: usize = 200;

/// One subagent: its latest run's fields under its first run's id, type and
/// description, and every run in the order they started.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SubagentSummary {
    #[serde(flatten)]
    pub latest: SubagentRun,
    pub runs: Vec<SubagentRun>,
}

impl Validate for SubagentSummary {}

/// Every subagent of a conversation, in the order they were started.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WorkerSubagentsResponse {
    pub subagents: Vec<SubagentSummary>,
}

impl Validate for WorkerSubagentsResponse {}

/// A claude.ai artifact a conversation published or opened, its own or a subagent's.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ChatArtifact {
    pub url: String,
    /// The artifact's uuid; `null` when the URL's id does not decode.
    pub slug: Option<String>,
    /// The first title it was given.
    pub title: Option<String>,
    /// Its latest activity.
    pub ts: Num,
}

impl Validate for ChatArtifact {}

/// Every artifact of a conversation, newest activity first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WorkerArtifactsResponse {
    pub artifacts: Vec<ChatArtifact>,
}

impl Validate for WorkerArtifactsResponse {}
