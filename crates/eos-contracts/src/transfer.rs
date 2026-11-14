use indexmap::IndexMap;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::primitives::{Num, de, str_lit};
use crate::validate::{Issues, Validate, re};

str_lit!(pub LocalLit = "local");

pub const TRANSFER_ID_RE: &str = r"^tr-[a-z0-9]{8,32}$";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct TransferId(pub String);

impl Validate for TransferId {
    fn validate(&self, cx: &mut Issues) {
        cx.regex(&self.0, re!(r"^tr-[a-z0-9]{8,32}$"), None);
    }
}

pub const TRANSFER_MAX_CHUNK: i64 = 16777216;

pub const TRANSFER_MAX_ITEMS: i64 = 100000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum MachineRef {
    Local(LocalLit),
    Text(String),
}

impl Validate for MachineRef {
    fn validate(&self, cx: &mut Issues) {
        if let Self::Text(v) = self {
            cx.regex(v, re!(r"^[0-9a-f]{64}$"), None);
        }
    }
}

/// An absolute path on the Mac that reads it (`AbsPathSchema`'s refinement).
fn abs_path(cx: &mut Issues, p: &str) {
    if !p.starts_with('/') || p.contains('\0') {
        cx.push("absolute path required");
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum TransferErrorCode {
    BadPath,
    NotFound,
    ForbiddenDest,
    DuplicateName,
    TooMany,
    SourceChanged,
    OffsetMismatch,
    NoSpace,
    ConflictUnresolved,
    Incomplete,
    Unreachable,
    NeedsUpdate,
    Forbidden,
}

impl Validate for TransferErrorCode {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TransferErrorBody {
    pub error: String,
    pub code: TransferErrorCode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub have: Option<i64>,
}

impl Validate for TransferErrorBody {
    fn validate(&self, cx: &mut Issues) {
        cx.at("have", |cx| {
            if let Some(v) = &self.have {
                cx.int_min(*v, 0, true);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TransferListEntry {
    pub name: String,
    pub path: String,
    pub r#type: TransferListEntryType,
    pub is_symlink: bool,
    #[serde(deserialize_with = "de::required")]
    pub size: Option<i64>,
    pub mtime_ms: Num,
}

impl Validate for TransferListEntry {
    fn validate(&self, cx: &mut Issues) {
        cx.at("size", |cx| {
            if let Some(v) = &self.size {
                cx.int_min(*v, 0, true);
            }
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum TransferListEntryType {
    File,
    Directory,
}

impl Validate for TransferListEntryType {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TransferListing {
    pub path: String,
    #[serde(deserialize_with = "de::required")]
    pub parent: Option<String>,
    pub home: String,
    pub entries: Vec<TransferListEntry>,
}

impl Validate for TransferListing {
    fn validate(&self, cx: &mut Issues) {
        cx.at("entries", |cx| self.entries.validate(cx));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ManifestItemType {
    File,
    Dir,
    Link,
}

impl Validate for ManifestItemType {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ManifestItem {
    pub rel: String,
    pub r#type: ManifestItemType,
    pub size: i64,
    pub mtime_ms: Num,
    pub mode: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

impl Validate for ManifestItem {
    fn validate(&self, cx: &mut Issues) {
        cx.at("rel", |cx| {
            cx.str_min(&self.rel, 1);
            cx.str_max(&self.rel, 4096);
        });
        cx.at("size", |cx| cx.int_min(self.size, 0, true));
        cx.at("mode", |cx| {
            cx.int_min(self.mode, 0, true);
            cx.int_max(self.mode, 511, true);
        });
        cx.at("target", |cx| {
            if let Some(v) = &self.target {
                cx.str_max(v, 4096);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TransferRoot {
    pub name: String,
    pub r#type: ManifestItemType,
    pub size: i64,
    pub mtime_ms: Num,
}

impl Validate for TransferRoot {
    fn validate(&self, cx: &mut Issues) {
        cx.at("size", |cx| cx.int_min(self.size, 0, true));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TransferManifest {
    pub roots: Vec<TransferRoot>,
    pub items: Vec<ManifestItem>,
    pub total_bytes: i64,
    pub file_count: i64,
}

impl Validate for TransferManifest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("roots", |cx| self.roots.validate(cx));
        cx.at("items", |cx| {
            cx.arr_max(self.items.len(), 100000);
            self.items.validate(cx);
        });
        cx.at("totalBytes", |cx| cx.int_min(self.total_bytes, 0, true));
        cx.at("fileCount", |cx| cx.int_min(self.file_count, 0, true));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TransferScanRequest {
    pub paths: Vec<String>,
}

impl Validate for TransferScanRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("paths", |cx| {
            cx.arr_min(self.paths.len(), 1);
            cx.arr_max(self.paths.len(), 500);
            for (i, v) in self.paths.iter().enumerate() {
                cx.idx(i, |cx| {
                    cx.str_min(v, 1);
                    cx.str_max(v, 4096);
                    abs_path(cx, v);
                });
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TransferPrepareRequest {
    pub id: TransferId,
    pub dest_dir: String,
    pub items: Vec<ManifestItem>,
}

impl Validate for TransferPrepareRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("id", |cx| self.id.validate(cx));
        cx.at("destDir", |cx| {
            cx.str_min(&self.dest_dir, 1);
            cx.str_max(&self.dest_dir, 4096);
            abs_path(cx, &self.dest_dir);
        });
        cx.at("items", |cx| {
            cx.arr_min(self.items.len(), 1);
            cx.arr_max(self.items.len(), 100000);
            self.items.validate(cx);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TransferExisting {
    pub name: String,
    pub r#type: ManifestItemType,
    #[serde(deserialize_with = "de::required")]
    pub size: Option<i64>,
    pub mtime_ms: Num,
}

impl Validate for TransferExisting {
    fn validate(&self, cx: &mut Issues) {
        cx.at("size", |cx| {
            if let Some(v) = &self.size {
                cx.int_min(*v, 0, true);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TransferPrepareResult {
    pub existing: Vec<TransferExisting>,
    pub staged: IndexMap<String, i64>,
    pub free_bytes: Num,
}

impl Validate for TransferPrepareResult {
    fn validate(&self, cx: &mut Issues) {
        cx.at("existing", |cx| self.existing.validate(cx));
        cx.at("staged", |cx| {
            for (k, v) in &self.staged {
                cx.at(k, |cx| {
                    cx.int_min(*v, 0, true);
                });
            }
        });
        cx.at("freeBytes", |cx| cx.num_min(self.free_bytes, 0.0, true));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum TransferDecision {
    Replace,
    Keep,
    Skip,
}

impl Validate for TransferDecision {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TransferCommitRequest {
    pub id: TransferId,
    pub dest_dir: String,
    pub decisions: IndexMap<String, TransferDecision>,
}

impl Validate for TransferCommitRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("id", |cx| self.id.validate(cx));
        cx.at("destDir", |cx| {
            cx.str_min(&self.dest_dir, 1);
            cx.str_max(&self.dest_dir, 4096);
            abs_path(cx, &self.dest_dir);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TransferPlaced {
    pub name: String,
    pub path: String,
}

impl Validate for TransferPlaced {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TransferCommitResult {
    pub placed: Vec<TransferPlaced>,
    pub skipped: Vec<String>,
}

impl Validate for TransferCommitResult {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TransferAbortRequest {
    pub id: TransferId,
    pub dest_dir: String,
}

impl Validate for TransferAbortRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("id", |cx| self.id.validate(cx));
        cx.at("destDir", |cx| {
            cx.str_min(&self.dest_dir, 1);
            cx.str_max(&self.dest_dir, 4096);
            abs_path(cx, &self.dest_dir);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TransferKeyRequest {
    pub path: String,
}

impl Validate for TransferKeyRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("path", |cx| {
            cx.str_min(&self.path, 1);
            cx.str_max(&self.path, 4096);
            abs_path(cx, &self.path);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TransferKeyResponse {
    #[serde(deserialize_with = "de::required")]
    pub key: Option<String>,
}

impl Validate for TransferKeyResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TransferLocateRequest {
    pub key: String,
}

impl Validate for TransferLocateRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("key", |cx| {
            cx.str_min(&self.key, 1);
            cx.str_max(&self.key, 2000);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TransferLocateResponse {
    #[serde(deserialize_with = "de::required")]
    pub path: Option<String>,
}

impl Validate for TransferLocateResponse {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum TransferStatus {
    Queued,
    Scanning,
    Copying,
    Conflict,
    Committing,
    Paused,
    Interrupted,
    Done,
    Failed,
    Cancelled,
}

impl Validate for TransferStatus {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum TransferRoute {
    Local,
    Direct,
    Relay,
    Reverse,
}

impl Validate for TransferRoute {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TransferConflict {
    pub name: String,
    pub existing: TransferConflictExisting,
    pub incoming: TransferConflictIncoming,
}

impl Validate for TransferConflict {
    fn validate(&self, cx: &mut Issues) {
        cx.at("existing", |cx| self.existing.validate(cx));
        cx.at("incoming", |cx| self.incoming.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TransferConflictExisting {
    pub r#type: ManifestItemType,
    #[serde(deserialize_with = "de::required")]
    pub size: Option<i64>,
    pub mtime_ms: Num,
}

impl Validate for TransferConflictExisting {
    fn validate(&self, cx: &mut Issues) {
        cx.at("size", |cx| {
            if let Some(v) = &self.size {
                cx.int_min(*v, 0, true);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TransferConflictIncoming {
    pub r#type: ManifestItemType,
    pub size: i64,
    pub mtime_ms: Num,
}

impl Validate for TransferConflictIncoming {
    fn validate(&self, cx: &mut Issues) {
        cx.at("size", |cx| cx.int_min(self.size, 0, true));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TransferOrigin {
    pub kind: TransferOriginKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
}

impl Validate for TransferOrigin {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum TransferOriginKind {
    User,
    Agent,
}

impl Validate for TransferOriginKind {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TransferRecord {
    pub id: TransferId,
    pub from: MachineRef,
    pub to: MachineRef,
    pub origin: TransferOrigin,
    pub sources: Vec<String>,
    pub dest_dir: String,
    pub dest_reason: TransferRecordDestReason,
    pub status: TransferStatus,
    #[serde(deserialize_with = "de::required")]
    pub error: Option<TransferRecordError>,
    pub roots: Vec<TransferRoot>,
    pub file_count: i64,
    pub total_bytes: i64,
    pub done_bytes: i64,
    pub rate: Num,
    #[serde(deserialize_with = "de::required")]
    pub route: Option<TransferRoute>,
    pub conflicts: Vec<TransferConflict>,
    pub decisions: IndexMap<String, TransferDecision>,
    pub placed: Vec<TransferPlaced>,
    pub created_at: Num,
    #[serde(deserialize_with = "de::required")]
    pub started_at: Option<Num>,
    #[serde(deserialize_with = "de::required")]
    pub finished_at: Option<Num>,
}

impl Validate for TransferRecord {
    fn validate(&self, cx: &mut Issues) {
        cx.at("id", |cx| self.id.validate(cx));
        cx.at("from", |cx| self.from.validate(cx));
        cx.at("to", |cx| self.to.validate(cx));
        cx.at("roots", |cx| self.roots.validate(cx));
        cx.at("fileCount", |cx| cx.int_min(self.file_count, 0, true));
        cx.at("totalBytes", |cx| cx.int_min(self.total_bytes, 0, true));
        cx.at("doneBytes", |cx| cx.int_min(self.done_bytes, 0, true));
        cx.at("rate", |cx| cx.num_min(self.rate, 0.0, true));
        cx.at("conflicts", |cx| self.conflicts.validate(cx));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum TransferRecordDestReason {
    Project,
    Default,
    Chosen,
}

impl Validate for TransferRecordDestReason {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TransferRecordError {
    pub code: String,
    pub message: String,
}

impl Validate for TransferRecordError {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TransferStartRequest {
    pub from: MachineRef,
    pub to: MachineRef,
    pub paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub dest_dir: Option<Option<String>>,
}

impl Validate for TransferStartRequest {
    fn validate(&self, cx: &mut Issues) {
        if self.from == self.to {
            cx.push("pick two different computers");
        }
        cx.at("from", |cx| self.from.validate(cx));
        cx.at("to", |cx| self.to.validate(cx));
        cx.at("paths", |cx| {
            cx.arr_min(self.paths.len(), 1);
            cx.arr_max(self.paths.len(), 500);
            for (i, v) in self.paths.iter().enumerate() {
                cx.idx(i, |cx| {
                    cx.str_min(v, 1);
                    cx.str_max(v, 4096);
                    abs_path(cx, v);
                });
            }
        });
        cx.at("destDir", |cx| {
            if let Some(Some(v)) = &self.dest_dir {
                cx.str_min(v, 1);
                cx.str_max(v, 4096);
                abs_path(cx, v);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TransferDecideRequest {
    pub decisions: IndexMap<String, TransferDecision>,
}

impl Validate for TransferDecideRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TransferDestinationRequest {
    pub from: MachineRef,
    pub to: MachineRef,
    pub paths: Vec<String>,
}

impl Validate for TransferDestinationRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("from", |cx| self.from.validate(cx));
        cx.at("to", |cx| self.to.validate(cx));
        cx.at("paths", |cx| {
            cx.arr_min(self.paths.len(), 1);
            cx.arr_max(self.paths.len(), 500);
            for (i, v) in self.paths.iter().enumerate() {
                cx.idx(i, |cx| {
                    cx.str_min(v, 1);
                    cx.str_max(v, 4096);
                    abs_path(cx, v);
                });
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TransferDestinationResponse {
    pub dest_dir: String,
    pub reason: TransferDestinationResponseReason,
}

impl Validate for TransferDestinationResponse {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum TransferDestinationResponseReason {
    Project,
    Default,
}

impl Validate for TransferDestinationResponseReason {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TransferListResponse {
    pub transfers: Vec<TransferRecord>,
}

impl Validate for TransferListResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("transfers", |cx| self.transfers.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TransferChangeEvent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transfer: Option<TransferRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed: Option<Vec<String>>,
}

impl Validate for TransferChangeEvent {
    fn validate(&self, cx: &mut Issues) {
        cx.at("transfer", |cx| {
            if let Some(v) = &self.transfer {
                v.validate(cx);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AgentTransferRequest {
    #[serde(deserialize_with = "de::trimmed")]
    pub machine: String,
    pub paths: Vec<String>,
}

impl Validate for AgentTransferRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("machine", |cx| {
            cx.str_min(&self.machine, 1);
            cx.str_max(&self.machine, 200);
        });
        cx.at("paths", |cx| {
            cx.arr_min(self.paths.len(), 1);
            cx.arr_max(self.paths.len(), 100);
            for (i, v) in self.paths.iter().enumerate() {
                cx.idx(i, |cx| {
                    cx.str_min(v, 1);
                    cx.str_max(v, 4096);
                });
            }
        });
    }
}
