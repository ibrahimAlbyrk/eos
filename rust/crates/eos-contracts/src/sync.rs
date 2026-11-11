//! Port of `contracts/src/sync.ts`.

use indexmap::IndexMap;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::primitives::{BoolLit, IntLit, Num, de};
use crate::validate::{Issues, Validate, re};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SyncDomainName {
    Profile,
    Avatar,
    Memory,
    Page,
    Template,
    Worker,
}

impl Validate for SyncDomainName {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SyncEnvelope {
    pub v: IntLit<1>,
    pub domain: SyncDomainName,
    pub id: String,
    pub changed_at: Num,
    pub device: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted: Option<BoolLit<true>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::some")]
    pub data: Option<Value>,
}

impl Validate for SyncEnvelope {
    fn validate(&self, cx: &mut Issues) {
        cx.at("id", |cx| {
            cx.str_min(&self.id, 1);
            cx.str_max(&self.id, 200);
        });
        cx.at("device", |cx| cx.str_max(&self.device, 200));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct VaultEntryWire {
    pub key: String,
    pub seq: i64,
    pub data: String,
}

impl Validate for VaultEntryWire {
    fn validate(&self, cx: &mut Issues) {
        cx.at("key", |cx| cx.regex(&self.key, re!(r"^[a-f0-9]{64}$"), None));
        cx.at("seq", |cx| cx.int_min(self.seq, 0, false));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct VaultChangesWire {
    pub head: i64,
    pub entries: Vec<VaultEntryWire>,
    pub more: bool,
}

impl Validate for VaultChangesWire {
    fn validate(&self, cx: &mut Issues) {
        cx.at("head", |cx| cx.int_min(self.head, 0, true));
        cx.at("entries", |cx| self.entries.validate(cx));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SyncPhase {
    Off,
    Idle,
    Syncing,
    Error,
}

impl Validate for SyncPhase {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusResponse {
    pub phase: SyncPhase,
    #[serde(deserialize_with = "de::required")]
    pub relay: Option<String>,
    #[serde(deserialize_with = "de::required")]
    pub last_sync_at: Option<Num>,
    #[serde(deserialize_with = "de::required")]
    pub error: Option<String>,
    pub counts: IndexMap<String, i64>,
}

impl Validate for SyncStatusResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("counts", |cx| {
            for (k, v) in &self.counts {
                cx.at(k, |cx| {
                    cx.int_min(*v, 0, true);
                });
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SyncJoinRequest {
    #[serde(deserialize_with = "de::trimmed")]
    pub key: String,
}

impl Validate for SyncJoinRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("key", |cx| {
            cx.str_min(&self.key, 10);
            cx.str_max(&self.key, 2000);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SyncKeyResponse {
    pub key: String,
}

impl Validate for SyncKeyResponse {}
