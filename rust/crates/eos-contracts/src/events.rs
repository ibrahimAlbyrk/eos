//! Port of `contracts/src/events.ts`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::primitives::{Num, de};
use crate::shared::UnknownRecord;
use crate::validate::{Issues, Validate};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub enum HookEventName {
    SessionStart,
    SessionEnd,
    Stop,
    Notification,
    PostToolUse,
}

impl Validate for HookEventName {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "UPPERCASE")]
pub enum WorkerState {
    Spawning,
    Working,
    Idle,
    Ending,
    Done,
    Killing,
    Suspended,
}

impl Validate for WorkerState {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum JsonlKind {
    AssistantText,
    ToolUse,
    ToolResult,
    Thinking,
}

impl Validate for JsonlKind {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorkerEventType {
    State,
    Hook,
    Jsonl,
    Heartbeat,
    Usage,
    Lifecycle,
    Warning,
    Worktree,
    ToolRunning,
    ToolDone,
    Spawn,
    Exit,
    Policy,
    PermissionPending,
    PermissionTtlDeny,
    UserMessage,
    StateReject,
    WorkerReport,
    OrchestratorMessage,
    ReportReminder,
    PermissionAsk,
    QuestionPending,
    QuestionAnswered,
    PeerConsult,
    PeerRequest,
    ConversationRewound,
    MessageRecalled,
    ConversationCleared,
    CompactionStarted,
    CompactionCompleted,
    CompactionFailed,
    AccountSwitched,
    AccountsExhausted,
    TryApplied,
    TryKept,
    TryDiscarded,
    GitPush,
    GitPull,
    WorkersIntegrated,
    ConflictResolved,
    Terminal,
    AgentEvent,
    BrowserAction,
}

impl Validate for WorkerEventType {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageRecalledPayload {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_msg_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recalled_row_id: Option<Num>,
}

impl Validate for MessageRecalledPayload {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReplyRef {
    pub row_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub msg_id: Option<String>,
    pub role: ReplyRefRole,
    pub excerpt: String,
}

impl Validate for ReplyRef {
    fn validate(&self, cx: &mut Issues) {
        cx.at("rowId", |cx| cx.int_min(self.row_id, 0, false));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ReplyRefRole {
    User,
    Assistant,
    Agent,
    System,
}

impl Validate for ReplyRefRole {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum CompactionTrigger {
    Auto,
    Manual,
}

impl Validate for CompactionTrigger {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CompactionStartedPayload {
    pub trigger: CompactionTrigger,
    pub before_tokens: Num,
    #[serde(deserialize_with = "de::required")]
    pub pct: Option<Num>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
}

impl Validate for CompactionStartedPayload {
    fn validate(&self, cx: &mut Issues) {
        cx.at("beforeTokens", |cx| cx.num_min(self.before_tokens, 0.0, true));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CompactionCompletedPayload {
    pub trigger: CompactionTrigger,
    pub before_tokens: Num,
    pub after_tokens: Num,
    #[serde(deserialize_with = "de::required")]
    pub pct: Option<Num>,
    pub turns: i64,
    pub summary: String,
    pub duration_ms: Num,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
}

impl Validate for CompactionCompletedPayload {
    fn validate(&self, cx: &mut Issues) {
        cx.at("beforeTokens", |cx| cx.num_min(self.before_tokens, 0.0, true));
        cx.at("afterTokens", |cx| cx.num_min(self.after_tokens, 0.0, true));
        cx.at("turns", |cx| cx.int_min(self.turns, 0, true));
        cx.at("durationMs", |cx| cx.num_min(self.duration_ms, 0.0, true));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CompactionFailedPayload {
    pub trigger: CompactionTrigger,
    pub error: String,
}

impl Validate for CompactionFailedPayload {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsagePayload {
    #[serde(default)]
    pub r#in: Num,
    #[serde(default)]
    pub out: Num,
    #[serde(default)]
    pub cache_read: Num,
    #[serde(default)]
    pub cache_create: Num,
    #[serde(default)]
    pub cache_create1h: Num,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta_cost: Option<Num>,
}

impl Validate for UsagePayload {
    fn validate(&self, cx: &mut Issues) {
        cx.at("in", |cx| cx.num_min(self.r#in, 0.0, true));
        cx.at("out", |cx| cx.num_min(self.out, 0.0, true));
        cx.at("cacheRead", |cx| cx.num_min(self.cache_read, 0.0, true));
        cx.at("cacheCreate", |cx| cx.num_min(self.cache_create, 0.0, true));
        cx.at("cacheCreate1h", |cx| cx.num_min(self.cache_create1h, 0.0, true));
        cx.at("deltaCost", |cx| {
            if let Some(v) = &self.delta_cost {
                cx.num_min(*v, 0.0, true);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToolRunningPayload {
    pub tool_name: String,
    #[serde(deserialize_with = "de::required")]
    pub tool_use_id: Option<String>,
    #[serde(default)]
    pub input: UnknownRecord,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_agent_tool_use_id: Option<String>,
}

impl Validate for ToolRunningPayload {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToolDonePayload {
    pub tool_name: String,
    #[serde(deserialize_with = "de::required")]
    pub tool_use_id: Option<String>,
    #[serde(default)]
    pub result: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_agent_tool_use_id: Option<String>,
}

impl Validate for ToolDonePayload {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct JsonlAssistantText {
    pub text: String,
}

impl Validate for JsonlAssistantText {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct JsonlToolUse {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub input: UnknownRecord,
}

impl Validate for JsonlToolUse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct JsonlToolResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
    #[serde(default)]
    pub is_error: bool,
    #[serde(default)]
    pub text: String,
}

impl Validate for JsonlToolResult {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct JsonlThinking {
    pub text: String,
}

impl Validate for JsonlThinking {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum JsonlPayload {
    AssistantText(JsonlAssistantText),
    ToolUse(JsonlToolUse),
    ToolResult(JsonlToolResult),
    Thinking(JsonlThinking),
}

impl Validate for JsonlPayload {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HookPayload {
    pub event: HookEventName,
    #[serde(default)]
    pub body: UnknownRecord,
}

impl Validate for HookPayload {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct StatePayload {
    pub state: WorkerState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<WorkerState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl Validate for StatePayload {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatPayload {
    pub elapsed_ms: Num,
    pub quiet_ms: Num,
}

impl Validate for HeartbeatPayload {
    fn validate(&self, cx: &mut Issues) {
        cx.at("elapsedMs", |cx| cx.num_min(self.elapsed_ms, 0.0, true));
        cx.at("quietMs", |cx| cx.num_min(self.quiet_ms, 0.0, true));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LifecyclePhase {
    ClaudeSpawning,
    PromptSent,
    ReadyNoPrompt,
    ReadyTimeout,
    MessageReceived,
    Interrupted,
    SessionCaptured,
    EchoTimeout,
    DeliveryRetry,
    PromptDelivered,
    DeliveryUnverified,
    DeliveryFailed,
    PtyExit,
    UncaughtException,
    UnhandledRejection,
}

impl Validate for LifecyclePhase {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct LifecyclePayload {
    pub phase: LifecyclePhase,
    /// Keys this version does not know; kept so a round trip loses nothing.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

impl Validate for LifecyclePayload {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WorkerEventPostBody {
    pub r#type: WorkerEventType,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::some")]
    pub payload: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<i64>,
}

impl Validate for WorkerEventPostBody {
    fn validate(&self, cx: &mut Issues) {
        cx.at("seq", |cx| {
            if let Some(v) = &self.seq {
                cx.int_min(*v, 0, true);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WorkerEventRow {
    pub id: Num,
    pub worker_id: String,
    pub ts: Num,
    pub r#type: String,
    #[serde(deserialize_with = "de::required")]
    pub payload: Option<String>,
}

impl Validate for WorkerEventRow {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum FsChangeKind {
    Add,
    Change,
    Unlink,
    AddDir,
    UnlinkDir,
}

impl Validate for FsChangeKind {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FsChangeEvent {
    pub changes: Vec<FsChangeEventChangesItem>,
}

impl Validate for FsChangeEvent {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FsChangeEventChangesItem {
    pub kind: FsChangeKind,
    pub path: String,
    pub dir: String,
    pub ts: Num,
}

impl Validate for FsChangeEventChangesItem {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum GitChangeKind {
    Head,
    Index,
    Refs,
    Stash,
    Worktree,
    Conflict,
}

impl Validate for GitChangeKind {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct GitChangeEvent {
    pub dir: String,
    pub kinds: Vec<GitChangeKind>,
    pub ts: Num,
}

impl Validate for GitChangeEvent {}
