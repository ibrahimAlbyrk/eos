//! Port of `contracts/src/http.ts` (settings).

use indexmap::IndexMap;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::primitives::Num;
use crate::validate::{Issues, Validate};

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

/// `config.archive.retention`: how long archived chats are kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ArchiveRetentionSetting {
    Off,
    Daily,
    Weekly,
    Monthly,
}

impl Validate for ArchiveRetentionSetting {}

/// `config.archive.cmdW`: what closing a chat's tab does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum CloseTabSetting {
    Archive,
    Delete,
}

impl Validate for CloseTabSetting {}

/// `PUT /api/settings/archive`: the fields of `config.archive` to change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retention: Option<ArchiveRetentionSetting>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purge_on_app_close: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cmd_w: Option<CloseTabSetting>,
}

impl Validate for ArchiveSettingsPatch {}

/// `PUT /api/settings/compaction`: the fields of `config.compaction` to change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompactionSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub threshold: Option<Num>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<i64>,
}

impl Validate for CompactionSettingsPatch {
    fn validate(&self, cx: &mut Issues) {
        cx.at("threshold", |cx| {
            if let Some(v) = self.threshold {
                cx.num_min(v, 0.1, true);
                cx.num_max(v, 0.99, true);
            }
        });
        cx.at("timeoutMs", |cx| {
            if let Some(v) = self.timeout_ms {
                cx.int_min(v, 0, false);
            }
        });
    }
}
