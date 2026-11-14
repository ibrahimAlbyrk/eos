//! Wire types of the workers routes.

use indexmap::IndexMap;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::attachments::ChatAttachment;
use crate::genui::{UserMessageAction, ViewAction};
use crate::primitives::{BoolLit, Num, de};
use crate::validate::{Issues, Validate};
use crate::worker::{PermissionMode, WorkerRow};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SpawnWorkerRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_template: Option<SpawnWorkerRequestPromptTemplate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub with_gateway: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub definition_owner_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<SpawnWorkerRequestRole>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools_allow: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools_deny: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edit_regex: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_of: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collaborate: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend_kind: Option<String>,
    /// A goal loop for the new worker. The app has none: the route refuses a
    /// request that asks for one, whatever its shape.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#loop: Option<serde_json::Value>,
}

impl Validate for SpawnWorkerRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("prompt", |cx| {
            if let Some(v) = &self.prompt {
                cx.str_min(v, 1);
            }
        });
        cx.at("promptTemplate", |cx| {
            if let Some(v) = &self.prompt_template {
                v.validate(cx);
            }
        });
        // JavaScript truthiness: an empty string counts as absent.
        let given = |v: &Option<String>| v.as_deref().is_some_and(|s| !s.is_empty());
        if !(given(&self.cwd) || given(&self.worktree_from) || given(&self.workspace_of)) {
            cx.push("cwd, worktreeFrom or workspaceOf required");
        }
        if !(given(&self.prompt) || self.prompt_template.is_some()) {
            cx.push("prompt or promptTemplate required");
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SpawnWorkerRequestPromptTemplate {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vars: Option<IndexMap<String, String>>,
}

impl Validate for SpawnWorkerRequestPromptTemplate {
    fn validate(&self, cx: &mut Issues) {
        cx.at("id", |cx| cx.str_min(&self.id, 1));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SpawnWorkerRequestRole {
    Git,
}

impl Validate for SpawnWorkerRequestRole {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SpawnWorkerResponse {
    pub id: String,
    pub port: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub isolation: Option<SpawnWorkerResponseIsolation>,
}

impl Validate for SpawnWorkerResponse {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SpawnWorkerResponseIsolation {
    Worktree,
    Cwd,
}

impl Validate for SpawnWorkerResponseIsolation {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOrchestratorRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scratch: Option<BoolLit<true>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend_profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<SpawnOrchestratorRequestMode>,
}

impl Validate for SpawnOrchestratorRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("cwd", |cx| {
            if let Some(v) = &self.cwd {
                cx.str_min(v, 1);
            }
        });
        if self.cwd.as_deref().is_some_and(|s| !s.is_empty()) == self.scratch.is_some() {
            cx.push("exactly one of cwd or scratch required");
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SpawnOrchestratorRequestMode {
    Orchestrator,
    Focused,
}

impl Validate for SpawnOrchestratorRequestMode {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SpawnOrchestratorResponse {
    pub id: String,
    pub port: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub isolation: Option<SpawnWorkerResponseIsolation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl Validate for SpawnOrchestratorResponse {}

pub type WorkerListResponse = Vec<WorkerRow>;

pub type OrchestratorListResponse = Vec<WorkerRow>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageRequest {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_msg_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue_when_busy: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<MessageRequestReplyTo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<ViewAction>,
}

impl Validate for MessageRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("text", |cx| cx.str_min(&self.text, 1));
        cx.at("clientMsgId", |cx| {
            if let Some(v) = &self.client_msg_id {
                cx.str_min(v, 1);
                cx.str_max(v, 128);
            }
        });
        cx.at("replyTo", |cx| {
            if let Some(v) = &self.reply_to {
                v.validate(cx);
            }
        });
        cx.at("action", |cx| {
            if let Some(v) = &self.action {
                v.validate(cx);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageRequestReplyTo {
    pub row_id: i64,
}

impl Validate for MessageRequestReplyTo {
    fn validate(&self, cx: &mut Issues) {
        cx.at("rowId", |cx| cx.int_min(self.row_id, 0, false));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
/// Zod declares this as a plain union of objects told apart by `as`.
#[serde(tag = "as", rename_all = "snake_case")]
pub enum MessageRecord {
    UserMessage(MessageRecordUserMessage),
    OrchestratorMessage(MessageRecordOrchestratorMessage),
    WorkerReport(MessageRecordWorkerReport),
    PeerRequest(MessageRecordPeerRequest),
    ReportReminder(MessageRecordReportReminder),
    PermissionAsk(MessageRecordPermissionAsk),
}

impl Validate for MessageRecord {
    fn validate(&self, cx: &mut Issues) {
        if let Self::UserMessage(v) = self {
            v.validate(cx);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageRecordUserMessage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_msg_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent_at: Option<Num>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<UserMessageAction>,
}

impl Validate for MessageRecordUserMessage {
    fn validate(&self, cx: &mut Issues) {
        cx.at("action", |cx| {
            if let Some(v) = &self.action {
                v.validate(cx);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageRecordOrchestratorMessage {
    pub from_parent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent_at: Option<Num>,
}

impl Validate for MessageRecordOrchestratorMessage {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageRecordWorkerReport {
    pub from_worker: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent_at: Option<Num>,
}

impl Validate for MessageRecordWorkerReport {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageRecordPeerRequest {
    pub from_worker: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent_at: Option<Num>,
}

impl Validate for MessageRecordPeerRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageRecordReportReminder {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent_at: Option<Num>,
}

impl Validate for MessageRecordReportReminder {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageRecordPermissionAsk {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent_at: Option<Num>,
}

impl Validate for MessageRecordPermissionAsk {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageResponse {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queued: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue_id: Option<Num>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deduped: Option<bool>,
}

impl Validate for MessageResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct QueuedMessage {
    pub id: Num,
    pub text: String,
    pub ts: Num,
}

impl Validate for QueuedMessage {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WorkerQueueResponse {
    pub messages: Vec<QueuedMessage>,
}

impl Validate for WorkerQueueResponse {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum WorkerAction {
    Commit,
    CommitPush,
    Pr,
    DraftPr,
    Verify,
    Review,
}

impl Validate for WorkerAction {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WorkerActionRequest {
    pub action: WorkerAction,
}

impl Validate for WorkerActionRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EventsQuery {
    #[serde(default, deserialize_with = "de::coerce_int")]
    pub since: i64,
    #[serde(default = "events_query_limit_default", deserialize_with = "de::coerce_int")]
    pub limit: i64,
    #[serde(default = "events_query_order_default")]
    pub order: EventsQueryOrder,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::coerce_int_opt")]
    pub before_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::coerce_int_opt")]
    pub after_id: Option<i64>,
}

fn events_query_limit_default() -> i64 {
    500
}

fn events_query_order_default() -> EventsQueryOrder {
    EventsQueryOrder::Desc
}

impl Validate for EventsQuery {
    fn validate(&self, cx: &mut Issues) {
        cx.at("since", |cx| cx.int_min(self.since, 0, true));
        cx.at("limit", |cx| {
            cx.int_min(self.limit, 0, false);
            cx.int_max(self.limit, 5000, true);
        });
        cx.at("beforeId", |cx| {
            if let Some(v) = &self.before_id {
                cx.int_min(*v, 0, false);
            }
        });
        cx.at("afterId", |cx| {
            if let Some(v) = &self.after_id {
                cx.int_min(*v, 0, true);
            }
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum EventsQueryOrder {
    Asc,
    Desc,
}

impl Validate for EventsQueryOrder {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WorkerAttachmentsResponse {
    pub attachments: Vec<ChatAttachment>,
}

impl Validate for WorkerAttachmentsResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SetPermissionRequest {
    pub mode: PermissionMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cascade: Option<bool>,
}

impl Validate for SetPermissionRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SetPermissionResponse {
    pub ok: bool,
    pub mode: PermissionMode,
    pub runtime_applied: bool,
    pub affected: Vec<String>,
}

impl Validate for SetPermissionResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SetModelRequest {
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

impl Validate for SetModelRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("model", |cx| cx.str_min(&self.model, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SetModelResponse {
    pub ok: bool,
    pub model: String,
    #[serde(deserialize_with = "de::required")]
    pub effort: Option<String>,
    pub runtime_applied: bool,
}

impl Validate for SetModelResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SetBackendRequest {
    pub kind: String,
}

impl Validate for SetBackendRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("kind", |cx| cx.str_min(&self.kind, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SetBackendResponse {
    pub ok: bool,
    pub id: String,
    pub kind: String,
    pub port: Num,
}

impl Validate for SetBackendResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct InterruptResponse {
    pub ok: bool,
}

impl Validate for InterruptResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ResumeResponse {
    pub id: String,
    pub port: Num,
}

impl Validate for ResumeResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ReportRequest {
    pub text: String,
}

impl Validate for ReportRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("text", |cx| cx.str_min(&self.text, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ReportResponse {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivered: Option<bool>,
}

impl Validate for ReportResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct NotifyRequest {
    pub title: String,
    pub body: String,
}

impl Validate for NotifyRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("title", |cx| cx.str_min(&self.title, 1));
        cx.at("body", |cx| cx.str_min(&self.body, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SetNameRequest {
    #[serde(deserialize_with = "de::required")]
    pub name: Option<String>,
}

impl Validate for SetNameRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RenameIntentRequest {
    pub active: bool,
}

impl Validate for RenameIntentRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct IntegrateWorkersRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ids: Option<Vec<String>>,
}

impl Validate for IntegrateWorkersRequest {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum IntegrateOutcome {
    Merged,
    Conflicted,
    Pending,
    Skipped,
}

impl Validate for IntegrateOutcome {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IntegrateWorkerResult {
    pub worker_id: String,
    #[serde(deserialize_with = "de::required")]
    pub name: Option<String>,
    #[serde(deserialize_with = "de::required")]
    pub branch: Option<String>,
    pub outcome: IntegrateOutcome,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl Validate for IntegrateWorkerResult {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IntegrateWorkersResponse {
    pub ok: bool,
    pub checkout: String,
    #[serde(deserialize_with = "de::required")]
    pub branch: Option<String>,
    pub workers: Vec<IntegrateWorkerResult>,
    pub merged_files: Vec<String>,
    pub conflicted_files: Vec<String>,
    pub message: String,
}

impl Validate for IntegrateWorkersResponse {}
