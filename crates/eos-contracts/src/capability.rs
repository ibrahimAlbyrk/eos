//! What the capability routes take and answer, and what
//! `capabilities:change` carries. States, origins and the other closed sets
//! travel as the words `eos_domain::capability` stores; an action's class is
//! Freedom's `ActionClass`. Settings values and account labels are the
//! user's: these types are never logged.

use indexmap::IndexMap;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::freedom::ActionClass;
use crate::validate::Validate;

/// A row of `GET /api/capabilities`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityRow {
    pub id: String,
    pub name: String,
    pub summary: String,
    /// `builtin`, `forge`, `registry` or `synced`.
    pub origin: String,
    /// `ready`, `degraded`, `needs_sign_in`, `needs_setup`, `broken`,
    /// `disabled` or `available`.
    pub state: String,
    /// Why it is in its state (`client_id_missing`, `secret_missing:<name>`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_code: Option<String>,
    /// The active version; none for a built-in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// `this_mac` or `any_mac`.
    pub works: String,
    pub action_count: i64,
    /// The ids of the routines that use it.
    pub used_by: Vec<String>,
    /// The account it is signed in to (a GitHub login).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_label: Option<String>,
}

impl Validate for CapabilityRow {}

/// `GET /api/capabilities/{id}`: the row and what it is made of.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityDetail {
    #[serde(flatten)]
    pub row: CapabilityRow,
    pub actions: Vec<CapabilityAction>,
    pub reach: CapabilityReach,
    pub secrets: Vec<CapabilitySecret>,
    pub settings: Vec<CapabilitySetting>,
    /// Newest first.
    pub versions: Vec<CapabilityVersion>,
    /// Newest first.
    pub recent_calls: Vec<CapabilityCall>,
}

impl Validate for CapabilityDetail {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct CapabilityAction {
    pub name: String,
    pub summary: String,
    pub class: ActionClass,
    /// The action that takes this one back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub undo: Option<String>,
}

impl Validate for CapabilityAction {}

/// What its code may reach.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct CapabilityReach {
    pub hosts: Vec<String>,
    /// Bundle ids of the apps it sends Apple Events to.
    pub apps: Vec<String>,
    /// Paths it may read.
    pub files: Vec<String>,
}

impl Validate for CapabilityReach {}

/// A secret it asks for: whether it was entered, never its value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct CapabilitySecret {
    pub name: String,
    pub label: String,
    pub set: bool,
}

impl Validate for CapabilitySecret {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct CapabilitySetting {
    pub name: String,
    pub label: String,
    /// `text`, `phone`, `email` or `choice`.
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

impl Validate for CapabilitySetting {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityVersion {
    pub version: String,
    /// `proposed`, `installed`, `retired` or `rejected`.
    pub status: String,
    pub created_at: i64,
    /// Where it came from: a Forge run's id, or a pinned package
    /// (`npm:pkg@1.2.3#sha512-…`).
    pub source: String,
}

impl Validate for CapabilityVersion {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityCall {
    pub action: String,
    /// `ok`, `error`, `denied`, `timeout` or `busy`.
    pub outcome: String,
    pub at: i64,
    pub duration_ms: i64,
}

impl Validate for CapabilityCall {}

/// One item a capability lists for the user to pick (`GET
/// /api/capabilities/candidates`): a pull request, a mail.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityItem {
    /// Names the item for runs and signals (`github:pr:acme/game#482`).
    pub key: String,
    /// `github.pull_request`.
    pub kind: String,
    /// Text from outside.
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub updated_at: i64,
    /// What else the capability says of it.
    pub data: Value,
}

impl Validate for CapabilityItem {}

/// `capabilities:change`: a capability's state or version changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitiesChange {
    pub id: String,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

impl Validate for CapabilitiesChange {}

/// What `POST /api/capabilities/{id}/sign-in` answers: the code the user
/// enters at the address.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitySignIn {
    /// What the user types on the service's page; a browser sign-in has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_code: Option<String>,
    pub verification_uri: String,
    pub expires_at: i64,
}

impl Validate for CapabilitySignIn {}

/// What `GET /api/capabilities/{id}/sign-in` answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitySignInStatus {
    pub state: CapabilitySignInState,
    /// The account it signed in to, once it has.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_label: Option<String>,
}

impl Validate for CapabilitySignInStatus {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CapabilitySignInState {
    /// Waiting for the user to enter the code.
    Pending,
    SignedIn,
    /// The code ran out before the user entered it.
    Expired,
    /// The user turned it down.
    Denied,
    /// It could not finish (the service refused Eos's client, or the token
    /// could not be kept); starting again may work.
    Failed,
}

impl Validate for CapabilitySignInState {}

/// `PUT /api/capabilities/{id}/settings`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct CapabilitySettings {
    /// By setting name.
    pub values: IndexMap<String, String>,
}

impl Validate for CapabilitySettings {}

/// `POST /api/capabilities/{id}/rollback`: make an earlier version the
/// active one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RollbackRequest {
    pub version: String,
}

impl Validate for RollbackRequest {}

/// What the `github` channel sends for a review result: the input of its
/// `post_review` and `approve_pull_request` actions. The user's text: never
/// logged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PrReview {
    /// `owner/name`.
    pub repo: String,
    pub number: u64,
    /// The head commit the review was drafted on.
    pub commit_id: String,
    /// `COMMENT`, `REQUEST_CHANGES` or `APPROVE`.
    pub event: String,
    pub body: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub comments: Vec<PrReviewComment>,
}

impl Validate for PrReview {}

/// One line comment of a [`PrReview`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PrReviewComment {
    pub path: String,
    pub line: u64,
    /// `LEFT` or `RIGHT`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u64>,
    pub body: String,
}

impl Validate for PrReviewComment {}

#[cfg(test)]
mod tests;
