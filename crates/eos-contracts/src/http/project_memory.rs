//! Wire types of the project memory routes.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::primitives::{Num, de};
use crate::validate::{Issues, Validate, re};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct MemoryName(pub String);

impl Validate for MemoryName {
    fn validate(&self, cx: &mut Issues) {
        cx.str_min(&self.0, 1);
        cx.str_max(&self.0, 64);
        cx.regex(
            &self.0,
            re!(r"^[a-z0-9][a-z0-9-_]*$"),
            Some("lowercase letters, digits, dashes and underscores only"),
        );
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum MemoryType {
    User,
    Feedback,
    Project,
    Reference,
}

impl Validate for MemoryType {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub name: MemoryName,
    pub description: String,
    pub r#type: MemoryType,
    pub path: String,
    pub updated_at: Num,
}

impl Validate for MemoryEntry {
    fn validate(&self, cx: &mut Issues) {
        cx.at("name", |cx| self.name.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MemoryListResponse {
    #[serde(deserialize_with = "de::required")]
    pub dir: Option<String>,
    pub entries: Vec<MemoryEntry>,
}

impl Validate for MemoryListResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("entries", |cx| self.entries.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MemoryMutationResponse {
    pub ok: bool,
}

impl Validate for MemoryMutationResponse {}
