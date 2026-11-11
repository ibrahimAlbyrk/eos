//! Port of `contracts/src/canonical.ts`.

use indexmap::IndexMap;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::primitives::{BoolLit, Num, de};
use crate::shared::UnknownRecord;
use crate::validate::{Issues, Validate};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum BackendKind {
    Claude,
    AnthropicApi,
    Openai,
    Codex,
    CodexCli,
    GeminiCli,
}

impl Validate for BackendKind {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TextBlock {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub msg_id: Option<String>,
}

impl Validate for TextBlock {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningBlock {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redacted: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interrupted: Option<bool>,
}

impl Validate for ReasoningBlock {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallBlock {
    pub call_id: String,
    pub name: String,
    #[serde(default)]
    pub input: UnknownRecord,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub parent_call_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawns_subagent: Option<BoolLit<true>>,
}

impl Validate for ToolCallBlock {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PatchHunk {
    pub old_start: Num,
    pub new_start: Num,
    pub lines: Vec<String>,
}

impl Validate for PatchHunk {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToolResultBlock {
    pub call_id: String,
    #[serde(default)]
    pub is_error: bool,
    #[serde(default)]
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub patch: Option<Vec<PatchHunk>>,
}

impl Validate for ToolResultBlock {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillBlock {
    pub call_id: String,
    #[serde(default)]
    pub text: String,
}

impl Validate for SkillBlock {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text(TextBlock),
    Reasoning(ReasoningBlock),
    ToolCall(ToolCallBlock),
    ToolResult(ToolResultBlock),
    Skill(SkillBlock),
}

impl Validate for ContentBlock {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalUsage {
    #[serde(default)]
    pub input_tokens: Num,
    #[serde(default)]
    pub output_tokens: Num,
    #[serde(default)]
    pub cache_read_tokens: Num,
    #[serde(default)]
    pub cache_write_tokens: IndexMap<String, Num>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub model: Option<Option<String>>,
}

impl Validate for CanonicalUsage {
    fn validate(&self, cx: &mut Issues) {
        cx.at("inputTokens", |cx| cx.num_min(self.input_tokens, 0.0, true));
        cx.at("outputTokens", |cx| cx.num_min(self.output_tokens, 0.0, true));
        cx.at("cacheReadTokens", |cx| cx.num_min(self.cache_read_tokens, 0.0, true));
        cx.at("cacheWriteTokens", |cx| {
            for (k, v) in &self.cache_write_tokens {
                cx.at(k, |cx| {
                    cx.num_min(*v, 0.0, true);
                });
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AgentMessageEvent {
    pub role: AgentMessageEventRole,
    pub blocks: Vec<ContentBlock>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub model: Option<Option<String>>,
}

impl Validate for AgentMessageEvent {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AgentMessageEventRole {
    Assistant,
    User,
    Tool,
}

impl Validate for AgentMessageEventRole {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TurnEvent {
    pub phase: TurnEventPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl Validate for TurnEvent {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum TurnEventPhase {
    Started,
    Ended,
    Aborted,
    Error,
}

impl Validate for TurnEventPhase {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEvent {
    pub kind: ActivityEventKind,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub call_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<UnknownRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub parent_call_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
}

impl Validate for ActivityEvent {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ActivityEventKind {
    ToolStarted,
    ToolFinished,
    Alive,
}

impl Validate for ActivityEventKind {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentStartedEvent {
    pub call_id: String,
    pub agent_id: String,
    pub background: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resumes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_file: Option<String>,
}

impl Validate for SubagentStartedEvent {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<Num>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_uses: Option<Num>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<Num>,
}

impl Validate for SubagentUsage {
    fn validate(&self, cx: &mut Issues) {
        cx.at("totalTokens", |cx| {
            if let Some(v) = &self.total_tokens {
                cx.num_min(*v, 0.0, true);
            }
        });
        cx.at("toolUses", |cx| {
            if let Some(v) = &self.tool_uses {
                cx.num_min(*v, 0.0, true);
            }
        });
        cx.at("durationMs", |cx| {
            if let Some(v) = &self.duration_ms {
                cx.num_min(*v, 0.0, true);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentCompletedEvent {
    pub agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub call_id: Option<Option<String>>,
    pub status: SubagentCompletedEventStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<SubagentUsage>,
}

impl Validate for SubagentCompletedEvent {
    fn validate(&self, cx: &mut Issues) {
        cx.at("usage", |cx| {
            if let Some(v) = &self.usage {
                v.validate(cx);
            }
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SubagentCompletedEventStatus {
    Completed,
    Failed,
    Stopped,
}

impl Validate for SubagentCompletedEventStatus {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentProfileEvent {
    pub call_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

impl Validate for SubagentProfileEvent {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WorkflowPhase {
    pub index: i64,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl Validate for WorkflowPhase {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowAgentState {
    Queued,
    Running,
    Done,
    Error,
    Cancelled,
}

impl Validate for WorkflowAgentState {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowAgent {
    pub index: i64,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase_index: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub state: WorkflowAgentState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queued_at: Option<Num>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<Num>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_progress_at: Option<Num>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<Num>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_tool_summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<Num>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Num>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached: Option<bool>,
}

impl Validate for WorkflowAgent {
    fn validate(&self, cx: &mut Issues) {
        cx.at("durationMs", |cx| {
            if let Some(v) = &self.duration_ms {
                cx.num_min(*v, 0.0, true);
            }
        });
        cx.at("tokens", |cx| {
            if let Some(v) = &self.tokens {
                cx.num_min(*v, 0.0, true);
            }
        });
        cx.at("toolCalls", |cx| {
            if let Some(v) = &self.tool_calls {
                cx.num_min(*v, 0.0, true);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WorkflowRunSnapshot {
    pub phases: Vec<WorkflowPhase>,
    pub agents: Vec<WorkflowAgent>,
    pub logs: Vec<String>,
}

impl Validate for WorkflowRunSnapshot {
    fn validate(&self, cx: &mut Issues) {
        cx.at("agents", |cx| self.agents.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStartedEvent {
    pub call_id: String,
    pub task_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_dir: Option<String>,
}

impl Validate for WorkflowStartedEvent {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowCompletedEvent {
    pub call_id: String,
    pub task_id: String,
    pub status: WorkflowCompletedEventStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<SubagentUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<WorkflowRunSnapshot>,
}

impl Validate for WorkflowCompletedEvent {
    fn validate(&self, cx: &mut Issues) {
        cx.at("usage", |cx| {
            if let Some(v) = &self.usage {
                v.validate(cx);
            }
        });
        cx.at("snapshot", |cx| {
            if let Some(v) = &self.snapshot {
                v.validate(cx);
            }
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowCompletedEventStatus {
    Completed,
    Failed,
    Stopped,
}

impl Validate for WorkflowCompletedEventStatus {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UsageEvent {
    pub usage: CanonicalUsage,
}

impl Validate for UsageEvent {
    fn validate(&self, cx: &mut Issues) {
        cx.at("usage", |cx| self.usage.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ContextEvent {
    pub tokens: Num,
}

impl Validate for ContextEvent {
    fn validate(&self, cx: &mut Issues) {
        cx.at("tokens", |cx| cx.num_min(self.tokens, 0.0, true));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub phase: SessionEventPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<SessionEventOutcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

impl Validate for SessionEvent {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SessionEventPhase {
    Started,
    Ready,
    Ended,
    Cleared,
}

impl Validate for SessionEventPhase {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SessionEventOutcome {
    Success,
    Killed,
    Crashed,
}

impl Validate for SessionEventOutcome {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequestEvent {
    #[serde(deserialize_with = "de::required")]
    pub call_id: Option<String>,
    pub tool_name: String,
    #[serde(default)]
    pub input: UnknownRecord,
}

impl Validate for PermissionRequestEvent {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QuestionRequestEvent {
    #[serde(deserialize_with = "de::required")]
    pub call_id: Option<String>,
    pub questions: Vec<UnknownRecord>,
}

impl Validate for QuestionRequestEvent {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeltaEvent {
    pub channel: DeltaEventChannel,
    pub phase: DeltaEventPhase,
    pub block_id: String,
    #[serde(default)]
    pub text: String,
}

impl Validate for DeltaEvent {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum DeltaEventChannel {
    Reasoning,
    Text,
}

impl Validate for DeltaEventChannel {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum DeltaEventPhase {
    Start,
    Append,
    Stop,
}

impl Validate for DeltaEventPhase {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    Message(AgentMessageEvent),
    Delta(DeltaEvent),
    Turn(TurnEvent),
    Activity(ActivityEvent),
    SubagentStarted(SubagentStartedEvent),
    SubagentCompleted(SubagentCompletedEvent),
    SubagentProfile(SubagentProfileEvent),
    WorkflowStarted(WorkflowStartedEvent),
    WorkflowCompleted(WorkflowCompletedEvent),
    Usage(UsageEvent),
    Context(ContextEvent),
    Session(SessionEvent),
    PermissionRequest(PermissionRequestEvent),
    QuestionRequest(QuestionRequestEvent),
}

impl Validate for AgentEvent {
    fn validate(&self, cx: &mut Issues) {
        match self {
            Self::SubagentCompleted(v) => v.validate(cx),
            Self::WorkflowCompleted(v) => v.validate(cx),
            Self::Usage(v) => v.validate(cx),
            Self::Context(v) => v.validate(cx),
            _ => {}
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventEnvelope {
    pub backend: BackendKind,
    pub worker_id: String,
    #[serde(default)]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<i64>,
    pub ts: Num,
    pub event: AgentEvent,
}

impl Validate for AgentEventEnvelope {
    fn validate(&self, cx: &mut Issues) {
        cx.at("seq", |cx| {
            if let Some(v) = &self.seq {
                cx.int_min(*v, 0, true);
            }
        });
        cx.at("event", |cx| self.event.validate(cx));
    }
}

/// Slims a `structuredPatch` sidecar down to the fields the diff view needs.
/// `None` for absent, empty or malformed input, so a caller attaches `patch`
/// only when it parsed to hunks.
pub fn parse_structured_patch(sp: &Value) -> Option<Vec<PatchHunk>> {
    let hunks: Vec<PatchHunk> = sp
        .as_array()?
        .iter()
        .filter_map(|h| {
            let old_start = h.get("oldStart")?.as_f64()?;
            let new_start = h.get("newStart")?.as_f64()?;
            let lines = h
                .get("lines")?
                .as_array()?
                .iter()
                .map(|l| l.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()?;
            Some(PatchHunk { old_start: Num(old_start), new_start: Num(new_start), lines })
        })
        .collect();
    (!hunks.is_empty()).then_some(hunks)
}

/// Context-window occupancy of one request: uncached input + cache reads +
/// every cache-write tier. Not the billing total.
pub fn context_tokens_of(u: &CanonicalUsage) -> Num {
    let writes: f64 = u.cache_write_tokens.values().map(|v| v.0).sum();
    Num(u.input_tokens.0 + u.cache_read_tokens.0 + writes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn structured_patch_keeps_only_well_formed_hunks() {
        assert_eq!(parse_structured_patch(&json!(null)), None);
        assert_eq!(parse_structured_patch(&json!([])), None);
        assert_eq!(parse_structured_patch(&json!([{"oldStart": "1"}, 5])), None);
        let hunks = parse_structured_patch(&json!([
            {"oldStart": 1, "oldLines": 2, "newStart": 1, "newLines": 3, "lines": [" a", "+b"]},
            {"oldStart": 9, "newStart": 9, "lines": [1]},
        ]))
        .unwrap();
        assert_eq!(
            serde_json::to_value(&hunks).unwrap(),
            json!([{"oldStart": 1, "newStart": 1, "lines": [" a", "+b"]}])
        );
    }

    #[test]
    fn context_tokens_sum_the_prompt_footprint() {
        let u: CanonicalUsage = serde_json::from_value(json!({
            "inputTokens": 10, "outputTokens": 99, "cacheReadTokens": 5, "cacheWriteTokens": {"5m": 2, "1h": 3},
        }))
        .unwrap();
        assert_eq!(context_tokens_of(&u), Num(20.0));
    }
}
