//! What memory's routes take and answer, and what `memory:change` and
//! `memory:recalled` carry. Note text is the user's: these types are never
//! logged.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::validate::Validate;

/// `memory:change`: notes were learned, changed or forgotten, or only their
/// counts moved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceChange {
    pub ids: Vec<String>,
    /// `learned`, `changed`, `forgotten` or `counts`.
    pub action: String,
}

impl Validate for ExperienceChange {}

/// `memory:recalled`: notes went in front of a chat's or a run's model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceRecalledEvent {
    pub worker_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub note_ids: Vec<String>,
    /// `pack`, `reminder` or `tool`.
    pub how: String,
}

impl Validate for ExperienceRecalledEvent {}

/// `GET`/`PUT /api/memory/settings`: whether Eos learns, and whether it
/// reminds agents of what it learned.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceSettings {
    pub learning: bool,
    pub reminders: bool,
}

impl Validate for ExperienceSettings {}

#[cfg(test)]
mod tests;
