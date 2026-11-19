//! Changing a routine by hand.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::validate::Validate;

/// The states a routine is set to by hand; a draft starts from its draft,
/// and deleting has its own route.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum RoutineHandState {
    Active,
    Paused,
    Archived,
}

impl Validate for RoutineHandState {}

/// `PUT /api/routines/:id/state`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoutineStateRequest {
    pub state: RoutineHandState,
}

impl Validate for RoutineStateRequest {}
