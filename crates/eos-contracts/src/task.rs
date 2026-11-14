use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::primitives::de;
use crate::validate::Validate;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    InProgress,
    Completed,
}

impl Validate for TaskStatus {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub content: String,
    pub status: TaskStatus,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub active_form: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted: Option<bool>,
}

impl Validate for Task {}
