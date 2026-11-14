use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::primitives::Num;
use crate::validate::Validate;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MemorySource {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_paths: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_filenames: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<Num>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assume_native_for: Option<Vec<String>>,
}

impl Validate for MemorySource {}
