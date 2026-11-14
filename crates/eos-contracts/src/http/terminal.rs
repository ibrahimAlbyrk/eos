//! Wire types of the terminal routes.

use indexmap::IndexMap;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::primitives::{BoolLit, Num, de};
use crate::validate::{Issues, Validate};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TerminalRunRequest {
    pub command: String,
}

impl Validate for TerminalRunRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("command", |cx| cx.str_min(&self.command, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRunResponse {
    pub run_id: String,
}

impl Validate for TerminalRunResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WorkspaceTerminalRunRequest {
    pub cwd: String,
    pub command: String,
}

impl Validate for WorkspaceTerminalRunRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("cwd", |cx| cx.str_min(&self.cwd, 1));
        cx.at("command", |cx| cx.str_min(&self.command, 1));
    }
}

pub const CLAUDE_COMMAND: &str = "claude --model opus --dangerously-skip-permissions";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PtyCreateRequest {
    pub cols: i64,
    pub rows: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude: Option<PtyCreateRequestClaude>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
}

impl Validate for PtyCreateRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("cols", |cx| {
            cx.int_min(self.cols, 0, false);
            cx.int_max(self.cols, 1000, true);
        });
        cx.at("rows", |cx| {
            cx.int_min(self.rows, 0, false);
            cx.int_max(self.rows, 1000, true);
        });
        cx.at("cwd", |cx| {
            if let Some(v) = &self.cwd {
                cx.str_min(v, 1);
            }
        });
        cx.at("command", |cx| {
            if let Some(v) = &self.command {
                cx.str_min(v, 1);
                cx.str_max(v, 2000);
            }
        });
        cx.at("claude", |cx| {
            if let Some(v) = &self.claude {
                v.validate(cx);
            }
        });
        cx.at("owner", |cx| {
            if let Some(v) = &self.owner {
                cx.str_min(v, 1);
                cx.str_max(v, 64);
            }
        });
        if self.command.as_deref().is_some_and(|c| !c.is_empty()) && self.claude.is_some() {
            cx.push("command and claude are mutually exclusive");
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PtyCreateRequestClaude {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<String>,
}

impl Validate for PtyCreateRequestClaude {
    fn validate(&self, cx: &mut Issues) {
        cx.at("resume", |cx| {
            if let Some(v) = &self.resume {
                cx.uuid(v);
            }
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum PtyKind {
    Claude,
    Shell,
}

impl Validate for PtyKind {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PtySession {
    pub session_id: String,
    pub number: i64,
    pub cwd: String,
    pub cols: i64,
    pub rows: i64,
    pub alive: bool,
    pub kind: PtyKind,
    #[serde(deserialize_with = "de::required")]
    pub claude_session_id: Option<String>,
    #[serde(deserialize_with = "de::required")]
    pub title: Option<String>,
    pub remote: bool,
    #[serde(deserialize_with = "de::required")]
    pub owner: Option<String>,
}

impl Validate for PtySession {
    fn validate(&self, cx: &mut Issues) {
        cx.at("number", |cx| cx.int_min(self.number, 0, false));
        cx.at("cols", |cx| cx.int_min(self.cols, 0, false));
        cx.at("rows", |cx| cx.int_min(self.rows, 0, false));
    }
}

pub type PtyCreateResponse = PtySession;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PtyListResponse {
    pub sessions: Vec<PtySession>,
}

impl Validate for PtyListResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("sessions", |cx| self.sessions.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PtyInputRequest {
    pub data: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<i64>,
}

impl Validate for PtyInputRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("stream", |cx| {
            if let Some(v) = &self.stream {
                cx.str_min(v, 1);
                cx.str_max(v, 64);
            }
        });
        cx.at("seq", |cx| {
            if let Some(v) = &self.seq {
                cx.int_min(*v, 0, false);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PtyResizeRequest {
    pub cols: i64,
    pub rows: i64,
}

impl Validate for PtyResizeRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("cols", |cx| {
            cx.int_min(self.cols, 0, false);
            cx.int_max(self.cols, 1000, true);
        });
        cx.at("rows", |cx| {
            cx.int_min(self.rows, 0, false);
            cx.int_max(self.rows, 1000, true);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PtyBufferResponse {
    pub seq: i64,
    pub data: String,
}

impl Validate for PtyBufferResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("seq", |cx| cx.int_min(self.seq, 0, true));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PtyConversationRow {
    pub id: i64,
    pub ts: Num,
    pub r#type: String,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::some")]
    pub payload: Option<Value>,
}

impl Validate for PtyConversationRow {
    fn validate(&self, cx: &mut Issues) {
        cx.at("id", |cx| cx.int_min(self.id, 0, false));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PtyPending {
    pub tool_use_id: String,
    pub name: PtyPendingName,
    pub input: IndexMap<String, Value>,
}

impl Validate for PtyPending {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub enum PtyPendingName {
    AskUserQuestion,
    ExitPlanMode,
}

impl Validate for PtyPendingName {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PtyConversationResponse {
    #[serde(deserialize_with = "de::required")]
    pub claude_session_id: Option<String>,
    pub rows: Vec<PtyConversationRow>,
    pub running: bool,
    #[serde(deserialize_with = "de::required")]
    pub pending: Option<PtyPending>,
}

impl Validate for PtyConversationResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("rows", |cx| self.rows.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PtyMessageRequest {
    pub text: String,
}

impl Validate for PtyMessageRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("text", |cx| {
            cx.str_min(&self.text, 1);
            cx.str_max(&self.text, 100000);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum PtyQuestionAnswer {
    Options(PtyQuestionAnswerOptions),
    Text(PtyQuestionAnswerText),
}

impl Validate for PtyQuestionAnswer {
    fn validate(&self, cx: &mut Issues) {
        match self {
            Self::Options(v) => v.validate(cx),
            Self::Text(v) => v.validate(cx),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PtyQuestionAnswerOptions {
    pub options: Vec<i64>,
}

impl Validate for PtyQuestionAnswerOptions {
    fn validate(&self, cx: &mut Issues) {
        cx.at("options", |cx| {
            cx.arr_min(self.options.len(), 1);
            for (i, v) in self.options.iter().enumerate() {
                cx.idx(i, |cx| {
                    cx.int_min(*v, 0, true);
                });
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PtyQuestionAnswerText {
    pub text: String,
}

impl Validate for PtyQuestionAnswerText {
    fn validate(&self, cx: &mut Issues) {
        cx.at("text", |cx| {
            cx.str_min(&self.text, 1);
            cx.str_max(&self.text, 10000);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PtyAnswerRequest {
    pub tool_use_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answers: Option<Vec<PtyQuestionAnswer>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approve: Option<BoolLit<true>>,
}

impl Validate for PtyAnswerRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("toolUseId", |cx| cx.str_min(&self.tool_use_id, 1));
        cx.at("answers", |cx| {
            if let Some(v) = &self.answers {
                v.validate(cx);
            }
        });
    }
}
