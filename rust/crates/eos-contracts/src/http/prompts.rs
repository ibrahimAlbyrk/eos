//! Port of `contracts/src/http.ts` (prompts).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::primitives::{Num, de};
use crate::prompt::SessionFacts;
use crate::validate::Validate;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PromptDescriptor {
    pub id: String,
    #[serde(deserialize_with = "de::required")]
    pub description: Option<String>,
    #[serde(deserialize_with = "de::required")]
    pub layer: Option<String>,
    #[serde(deserialize_with = "de::required")]
    pub priority: Option<Num>,
    pub conditional: bool,
    pub variables: Vec<String>,
}

impl Validate for PromptDescriptor {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PromptCatalogResponse {
    pub prompts: Vec<PromptDescriptor>,
}

impl Validate for PromptCatalogResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PromptPreviewRequest {
    #[serde(default = "prompt_preview_request_role_default")]
    pub role: PromptPreviewRequestRole,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default = "prompt_preview_request_name_default")]
    pub name: String,
    #[serde(default)]
    pub worker_id: Option<String>,
    #[serde(default = "prompt_preview_request_model_default")]
    pub model: String,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default = "prompt_preview_request_permission_mode_default")]
    pub permission_mode: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub worktree_dir: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub repo_root: Option<String>,
    #[serde(default)]
    pub is_attached: bool,
    #[serde(default)]
    pub has_mcp: bool,
    #[serde(default)]
    pub can_collaborate: bool,
    #[serde(default)]
    pub worker_definition: String,
    #[serde(default)]
    pub worker_definition_catalog: String,
}

fn prompt_preview_request_role_default() -> PromptPreviewRequestRole {
    PromptPreviewRequestRole::Worker
}

fn prompt_preview_request_name_default() -> String {
    "preview".to_owned()
}

fn prompt_preview_request_model_default() -> String {
    "high".to_owned()
}

fn prompt_preview_request_permission_mode_default() -> String {
    "bypassPermissions".to_owned()
}

impl Validate for PromptPreviewRequest {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum PromptPreviewRequestRole {
    Orchestrator,
    Worker,
    Git,
}

impl Validate for PromptPreviewRequestRole {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PromptPreviewResponse {
    pub text: String,
    pub facts: SessionFacts,
    pub active_fragment_ids: Vec<String>,
}

impl Validate for PromptPreviewResponse {}
