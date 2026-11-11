//! Port of `contracts/src/prompt.ts`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::primitives::de;
use crate::validate::{Issues, Validate};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct VariableName(pub String);

impl Validate for VariableName {
    fn validate(&self, cx: &mut Issues) {
        cx.str_min(&self.0, 1);
    }
}

/// A condition over the session facts: one fact with one operator, or a
/// combination. Tried in this order, as the Zod union does.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Condition {
    All { all: Vec<Condition> },
    Any { any: Vec<Condition> },
    Not { not: Box<Condition> },
    Leaf(ConditionLeaf),
}

impl Validate for Condition {
    fn validate(&self, cx: &mut Issues) {
        match self {
            Self::All { all } => cx.at("all", |cx| all.validate(cx)),
            Self::Any { any } => cx.at("any", |cx| any.validate(cx)),
            Self::Not { not } => cx.at("not", |cx| not.validate(cx)),
            Self::Leaf(leaf) => cx.at("fact", |cx| cx.str_min(&leaf.fact, 1)),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ConditionLeaf {
    pub fact: String,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::some")]
    pub eq: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::some")]
    pub ne: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#in: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nin: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exists: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truthy: Option<bool>,
}

pub const PROMPT_LAYERS: &[&str] = &["core", "environment", "role", "tool", "safety", "custom"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum PromptLayer {
    Core,
    Environment,
    Role,
    Tool,
    Safety,
    Custom,
}

impl Validate for PromptLayer {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DpiMeta {
    #[serde(default = "dpi_meta_layer_default")]
    pub layer: PromptLayer,
    #[serde(default = "dpi_meta_priority_default")]
    pub priority: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<Condition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overrides: Option<Vec<String>>,
}

fn dpi_meta_layer_default() -> PromptLayer {
    PromptLayer::Custom
}

fn dpi_meta_priority_default() -> i64 {
    100
}

impl Validate for DpiMeta {
    fn validate(&self, cx: &mut Issues) {
        cx.at("when", |cx| {
            if let Some(v) = &self.when {
                v.validate(cx);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PromptFrontmatter {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub variables: Vec<VariableName>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::some")]
    pub dpi: Option<Value>,
    /// Keys this version does not know; kept so a round trip loses nothing.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

impl Validate for PromptFrontmatter {
    fn validate(&self, cx: &mut Issues) {
        cx.at("variables", |cx| self.variables.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionFacts {
    pub role: SessionFactsRole,
    pub is_subagent: bool,
    pub is_git_repo: bool,
    pub is_worktree: bool,
    pub is_attached: bool,
    pub model: String,
    #[serde(deserialize_with = "de::required")]
    pub effort: Option<String>,
    pub permission_mode: String,
    pub os: String,
    pub shell: String,
    pub has_mcp: bool,
    pub can_collaborate: bool,
    #[serde(default)]
    pub worker_definition: String,
    /// Keys this version does not know; kept so a round trip loses nothing.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

impl Validate for SessionFacts {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SessionFactsRole {
    Orchestrator,
    Worker,
    Git,
    Focused,
}

impl Validate for SessionFactsRole {}
