//! Port of `contracts/src/http.ts` (settings).

use indexmap::IndexMap;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::primitives::Num;
use crate::validate::Validate;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum SettingValue {
    Text(String),
    Number(Num),
    Flag(bool),
    List(Vec<String>),
    Map(IndexMap<String, String>),
}

impl Validate for SettingValue {}

pub type UserSettings = IndexMap<String, SettingValue>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SettingsResponse {
    pub settings: UserSettings,
}

impl Validate for SettingsResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SettingsPatchRequest {
    pub settings: UserSettings,
}

impl Validate for SettingsPatchRequest {}
