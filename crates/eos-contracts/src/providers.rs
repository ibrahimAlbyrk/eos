//! The model providers a chat can run on besides the Claude catalog of
//! `ui-config` (`GET /api/providers`), each with its own models. A route of
//! the Rust core only.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::validate::Validate;

/// One model as its provider's catalog describes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    /// What a spawn or a model change names.
    pub id: String,
    pub display_name: String,
    /// In tokens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<i64>,
    /// The effort levels it takes (`None`: unknown).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort_levels: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<String>,
}

impl Validate for ProviderModel {}

/// One provider and the models it offers the user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModels {
    /// The provider as Settings › Accounts names it (`openai`).
    pub id: String,
    pub label: String,
    /// A sign-in or key a new session can start on is there.
    pub ready: bool,
    /// Empty while not ready, or before the provider's list was read.
    pub models: Vec<ProviderModel>,
}

impl Validate for ProviderModels {}

/// `GET /api/providers`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProvidersResponse {
    pub providers: Vec<ProviderModels>,
}

impl Validate for ProvidersResponse {}
