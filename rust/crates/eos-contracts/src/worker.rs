//! Port of `contracts/src/worker.ts`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::events::WorkerState;
use crate::primitives::{Num, de};
use crate::validate::Validate;

pub const FOCUSED_ROLE: &str = "focused";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum NameSource {
    Default,
    Auto,
    User,
}

impl Validate for NameSource {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WorkerContext {
    pub used: Num,
    #[serde(deserialize_with = "de::required")]
    pub limit: Option<Num>,
    #[serde(deserialize_with = "de::required")]
    pub pct: Option<Num>,
}

impl Validate for WorkerContext {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WorkerRow {
    pub id: String,
    pub state: WorkerState,
    #[serde(deserialize_with = "de::required")]
    pub cwd: Option<String>,
    #[serde(deserialize_with = "de::required")]
    pub worktree_from: Option<String>,
    #[serde(deserialize_with = "de::required")]
    pub branch: Option<String>,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_clipped: Option<bool>,
    #[serde(deserialize_with = "de::required")]
    pub name: Option<String>,
    #[serde(deserialize_with = "de::required")]
    pub name_source: Option<NameSource>,
    #[serde(deserialize_with = "de::required")]
    pub pid: Option<Num>,
    #[serde(deserialize_with = "de::required")]
    pub port: Option<Num>,
    pub started_at: Num,
    #[serde(deserialize_with = "de::required")]
    pub ended_at: Option<Num>,
    #[serde(deserialize_with = "de::required")]
    pub exit_code: Option<Num>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub parent_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub model: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub tokens_in: Option<Option<Num>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub tokens_out: Option<Option<Num>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub tokens_cache_read: Option<Option<Num>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub tokens_cache_create: Option<Option<Num>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub tokens_cache_create_1h: Option<Option<Num>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub cost_usd: Option<Option<Num>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub last_context_tokens: Option<Option<Num>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub tasks: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<WorkerContext>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub awaiting_question: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub is_orchestrator: Option<Option<Num>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub tool_calls: Option<Option<Num>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub permission_mode: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub effort: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub backend_kind: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub backend_profile: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub agent_role: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub worker_definition: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub tool_scope: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub worktree_dir: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub turn_started_at: Option<Option<Num>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub session_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub fork_base_sha: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub with_gateway: Option<Option<Num>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub collaborate: Option<Option<Num>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub workspace_owner_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub workspace_ready: Option<Option<Num>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub archived_at: Option<Option<Num>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub scratch: Option<Option<Num>>,
}

impl Validate for WorkerRow {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    AcceptEdits,
    BypassPermissions,
}

impl Validate for PermissionMode {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PendingPermissionRow {
    pub id: String,
    pub worker_id: String,
    pub tool_name: String,
    pub input: String,
    pub created_at: Num,
    pub expires_at: Num,
    pub resolved: Num,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub decision: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub reason: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub tool_use_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub updated_input: Option<Option<String>>,
}

impl Validate for PendingPermissionRow {}
