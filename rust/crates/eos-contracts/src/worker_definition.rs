//! Port of `contracts/src/worker-definition.ts`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::shared::Effort;
use crate::validate::{Issues, Validate};
use crate::worker::PermissionMode;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkerDefinition {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub when_to_use: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<Effort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend_profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persistent: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collaborate: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub isolation: Option<WorkerIsolation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools_allow: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools_deny: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edit_regex: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extends: Option<String>,
    #[serde(default)]
    pub body: String,
}

impl Validate for WorkerDefinition {
    fn validate(&self, cx: &mut Issues) {
        cx.at("name", |cx| cx.str_min(&self.name, 1));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum WorkerIsolation {
    Worktree,
    Cwd,
}

impl Validate for WorkerIsolation {}

pub const DEFAULT_WORKER_DEFINITION: &str = "general-purpose";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToolScope {
    #[serde(default)]
    pub allow: Vec<String>,
    #[serde(default)]
    pub deny: Vec<String>,
    #[serde(default)]
    pub edit_regex: Option<String>,
}

impl Validate for ToolScope {}

pub const WORKER_DEFINITION_SOURCES: &[&str] = &["builtin", "user", "project", "runtime"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum WorkerDefinitionSource {
    Builtin,
    User,
    Project,
    Runtime,
}

impl Validate for WorkerDefinitionSource {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkerDefinitionRecord {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub when_to_use: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<Effort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend_profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persistent: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collaborate: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub isolation: Option<WorkerIsolation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools_allow: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools_deny: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edit_regex: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extends: Option<String>,
    #[serde(default)]
    pub body: String,
    pub source: WorkerDefinitionSource,
}

impl Validate for WorkerDefinitionRecord {
    fn validate(&self, cx: &mut Issues) {
        cx.at("name", |cx| cx.str_min(&self.name, 1));
    }
}
