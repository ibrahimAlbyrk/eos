//! Port of `contracts/src/http.ts` (git).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::primitives::{Num, de};
use crate::validate::{Issues, Validate, re};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum PushOutcome {
    PushedNew,
    Pushed,
    PushedForce,
    UpToDate,
    BehindOnly,
    Detached,
    NoRemote,
    Rejected,
    LeaseStale,
    Auth,
    Failed,
}

impl Validate for PushOutcome {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PushResult {
    pub outcome: PushOutcome,
    pub ok: bool,
    #[serde(deserialize_with = "de::required")]
    pub branch: Option<String>,
    #[serde(deserialize_with = "de::required")]
    pub remote: Option<String>,
    pub ahead: i64,
    pub behind: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl Validate for PushResult {
    fn validate(&self, cx: &mut Issues) {
        cx.at("ahead", |cx| cx.int_min(self.ahead, 0, true));
        cx.at("behind", |cx| cx.int_min(self.behind, 0, true));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum PullOutcome {
    Pulled,
    UpToDate,
    Diverged,
    Detached,
    NoUpstream,
    Conflict,
    Failed,
}

impl Validate for PullOutcome {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PullResult {
    pub outcome: PullOutcome,
    pub ok: bool,
    #[serde(deserialize_with = "de::required")]
    pub branch: Option<String>,
    pub ahead: i64,
    pub behind: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl Validate for PullResult {
    fn validate(&self, cx: &mut Issues) {
        cx.at("ahead", |cx| cx.int_min(self.ahead, 0, true));
        cx.at("behind", |cx| cx.int_min(self.behind, 0, true));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum PullPlanKind {
    FastForward,
    Noop,
    Diverged,
    Blocked,
}

impl Validate for PullPlanKind {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum PushPlanKind {
    SetUpstream,
    FastForward,
    ForceWithLease,
    Noop,
    Blocked,
}

impl Validate for PushPlanKind {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PushStateResponse {
    #[serde(deserialize_with = "de::required")]
    pub branch: Option<String>,
    #[serde(deserialize_with = "de::required")]
    pub remote: Option<String>,
    pub has_upstream: bool,
    pub ahead: i64,
    pub behind: i64,
    pub kind: PushPlanKind,
    pub pushable: bool,
    pub has_uncommitted: bool,
    pub pullable: bool,
    pub pull_kind: PullPlanKind,
}

impl Validate for PushStateResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("ahead", |cx| cx.int_min(self.ahead, 0, true));
        cx.at("behind", |cx| cx.int_min(self.behind, 0, true));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BranchesQuery {
    pub cwd: String,
}

impl Validate for BranchesQuery {
    fn validate(&self, cx: &mut Issues) {
        cx.at("cwd", |cx| cx.str_min(&self.cwd, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BranchesResponse {
    pub branches: Vec<String>,
    #[serde(deserialize_with = "de::required")]
    pub current: Option<String>,
    pub is_git: bool,
    #[serde(deserialize_with = "de::required")]
    pub remote_url: Option<String>,
    #[serde(deserialize_with = "de::required")]
    pub ahead: Option<i64>,
    #[serde(deserialize_with = "de::required")]
    pub behind: Option<i64>,
    pub stash: i64,
    pub conflicts: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_branches: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remotes: Option<Vec<String>>,
}

impl Validate for BranchesResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("ahead", |cx| {
            if let Some(v) = &self.ahead {
                cx.int_min(*v, 0, true);
            }
        });
        cx.at("behind", |cx| {
            if let Some(v) = &self.behind {
                cx.int_min(*v, 0, true);
            }
        });
        cx.at("stash", |cx| cx.int_min(self.stash, 0, true));
        cx.at("conflicts", |cx| cx.int_min(self.conflicts, 0, true));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UnpushedCommit {
    pub sha: String,
    pub author: String,
    pub ts: Num,
    pub subject: String,
}

impl Validate for UnpushedCommit {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UnpushedResponse {
    pub commits: Vec<UnpushedCommit>,
}

impl Validate for UnpushedResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: CommitFileStatus,
    #[serde(deserialize_with = "de::required")]
    pub insertions: Option<i64>,
    #[serde(deserialize_with = "de::required")]
    pub deletions: Option<i64>,
}

impl Validate for CommitFile {
    fn validate(&self, cx: &mut Issues) {
        cx.at("insertions", |cx| {
            if let Some(v) = &self.insertions {
                cx.int_min(*v, 0, true);
            }
        });
        cx.at("deletions", |cx| {
            if let Some(v) = &self.deletions {
                cx.int_min(*v, 0, true);
            }
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "UPPERCASE")]
pub enum CommitFileStatus {
    M,
    A,
    D,
    R,
}

impl Validate for CommitFileStatus {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CommitDetail {
    pub sha: String,
    pub author: String,
    pub ts: Num,
    pub subject: String,
    pub body: String,
    pub insertions: i64,
    pub deletions: i64,
    pub files: Vec<CommitFile>,
}

impl Validate for CommitDetail {
    fn validate(&self, cx: &mut Issues) {
        cx.at("insertions", |cx| cx.int_min(self.insertions, 0, true));
        cx.at("deletions", |cx| cx.int_min(self.deletions, 0, true));
        cx.at("files", |cx| self.files.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FsLogQuery {
    pub cwd: String,
    #[serde(default = "fs_log_query_limit_default", deserialize_with = "de::coerce_int")]
    pub limit: i64,
    #[serde(default, deserialize_with = "de::coerce_int")]
    pub skip: i64,
}

fn fs_log_query_limit_default() -> i64 {
    30
}

impl Validate for FsLogQuery {
    fn validate(&self, cx: &mut Issues) {
        cx.at("cwd", |cx| cx.str_min(&self.cwd, 1));
        cx.at("limit", |cx| {
            cx.int_min(self.limit, 0, false);
            cx.int_max(self.limit, 100, true);
        });
        cx.at("skip", |cx| cx.int_min(self.skip, 0, true));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsLogResponse {
    pub commits: Vec<UnpushedCommit>,
    pub has_more: bool,
}

impl Validate for FsLogResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct GitRef(pub String);

impl Validate for GitRef {
    fn validate(&self, cx: &mut Issues) {
        cx.str_min(&self.0, 1);
        cx.str_max(&self.0, 256);
        cx.regex(&self.0, re!(r"^[A-Za-z0-9_][A-Za-z0-9._/@-]*$"), Some("invalid ref"));
        if self.0.contains("..") {
            cx.push("invalid ref");
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FsChangesQuery {
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<GitRef>,
}

impl Validate for FsChangesQuery {
    fn validate(&self, cx: &mut Issues) {
        cx.at("cwd", |cx| cx.str_min(&self.cwd, 1));
        cx.at("sha", |cx| {
            if let Some(v) = &self.sha {
                cx.regex(v, re!(r"^[0-9a-f]{4,40}$", "i"), None);
            }
        });
        cx.at("base", |cx| {
            if let Some(v) = &self.base {
                v.validate(cx);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsChangesFileQuery {
    pub cwd: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<GitRef>,
}

impl Validate for FsChangesFileQuery {
    fn validate(&self, cx: &mut Issues) {
        cx.at("cwd", |cx| cx.str_min(&self.cwd, 1));
        cx.at("path", |cx| cx.str_min(&self.path, 1));
        cx.at("sha", |cx| {
            if let Some(v) = &self.sha {
                cx.regex(v, re!(r"^[0-9a-f]{4,40}$", "i"), None);
            }
        });
        cx.at("base", |cx| {
            if let Some(v) = &self.base {
                v.validate(cx);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FsStashesQuery {
    pub cwd: String,
}

impl Validate for FsStashesQuery {
    fn validate(&self, cx: &mut Issues) {
        cx.at("cwd", |cx| cx.str_min(&self.cwd, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FsStashEntry {
    pub index: i64,
    pub sha: String,
    pub subject: String,
    pub ts: Num,
    #[serde(deserialize_with = "de::required")]
    pub branch: Option<String>,
}

impl Validate for FsStashEntry {
    fn validate(&self, cx: &mut Issues) {
        cx.at("index", |cx| cx.int_min(self.index, 0, true));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FsStashesResponse {
    pub stashes: Vec<FsStashEntry>,
}

impl Validate for FsStashesResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("stashes", |cx| self.stashes.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FsStashApplyRequest {
    pub cwd: String,
    pub index: i64,
}

impl Validate for FsStashApplyRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("cwd", |cx| cx.str_min(&self.cwd, 1));
        cx.at("index", |cx| cx.int_min(self.index, 0, true));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FsStashDropRequest {
    pub cwd: String,
    pub index: i64,
}

impl Validate for FsStashDropRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("cwd", |cx| cx.str_min(&self.cwd, 1));
        cx.at("index", |cx| cx.int_min(self.index, 0, true));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FsBlobQuery {
    pub cwd: String,
    pub r#ref: String,
    pub path: String,
}

impl Validate for FsBlobQuery {
    fn validate(&self, cx: &mut Issues) {
        cx.at("cwd", |cx| cx.str_min(&self.cwd, 1));
        cx.at("ref", |cx| cx.regex(&self.r#ref, re!(r"^[0-9a-f]{4,40}$", "i"), None));
        cx.at("path", |cx| cx.str_min(&self.path, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FsCheckoutRequest {
    pub cwd: String,
    pub branch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stash: Option<bool>,
}

impl Validate for FsCheckoutRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("cwd", |cx| cx.str_min(&self.cwd, 1));
        cx.at("branch", |cx| cx.str_min(&self.branch, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FsCheckoutResponse {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dirty: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Validate for FsCheckoutResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BranchCreateRequest {
    pub cwd: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_point: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkout: Option<bool>,
}

impl Validate for BranchCreateRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("cwd", |cx| cx.str_min(&self.cwd, 1));
        cx.at("name", |cx| cx.str_min(&self.name, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BranchRenameRequest {
    pub cwd: String,
    pub from: String,
    pub to: String,
}

impl Validate for BranchRenameRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("cwd", |cx| cx.str_min(&self.cwd, 1));
        cx.at("from", |cx| cx.str_min(&self.from, 1));
        cx.at("to", |cx| cx.str_min(&self.to, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BranchOpResponse {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Validate for BranchOpResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BranchDeleteRequest {
    pub cwd: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub force: Option<bool>,
}

impl Validate for BranchDeleteRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("cwd", |cx| cx.str_min(&self.cwd, 1));
        cx.at("name", |cx| cx.str_min(&self.name, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BranchDeleteResponse {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not_merged: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Validate for BranchDeleteResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FetchRequest {
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prune: Option<bool>,
}

impl Validate for FetchRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("cwd", |cx| cx.str_min(&self.cwd, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FetchResponse {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Validate for FetchResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RemoteBranchDeleteRequest {
    pub cwd: String,
    pub remote: String,
    pub branch: String,
}

impl Validate for RemoteBranchDeleteRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("cwd", |cx| cx.str_min(&self.cwd, 1));
        cx.at("remote", |cx| cx.str_min(&self.remote, 1));
        cx.at("branch", |cx| cx.str_min(&self.branch, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RemoteBranchDeleteResponse {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Validate for RemoteBranchDeleteResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WorkerDiffResponse {
    pub insertions: i64,
    pub deletions: i64,
    pub files: i64,
}

impl Validate for WorkerDiffResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("insertions", |cx| cx.int_min(self.insertions, 0, true));
        cx.at("deletions", |cx| cx.int_min(self.deletions, 0, true));
        cx.at("files", |cx| cx.int_min(self.files, 0, true));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: ChangedFileStatus,
    #[serde(deserialize_with = "de::required")]
    pub insertions: Option<i64>,
    #[serde(deserialize_with = "de::required")]
    pub deletions: Option<i64>,
    pub untracked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub patch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

impl Validate for ChangedFile {
    fn validate(&self, cx: &mut Issues) {
        cx.at("insertions", |cx| {
            if let Some(v) = &self.insertions {
                cx.int_min(*v, 0, true);
            }
        });
        cx.at("deletions", |cx| {
            if let Some(v) = &self.deletions {
                cx.int_min(*v, 0, true);
            }
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "UPPERCASE")]
pub enum ChangedFileStatus {
    M,
    A,
    D,
    R,
}

impl Validate for ChangedFileStatus {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WorkerChangesResponse {
    pub files: Vec<ChangedFile>,
    pub insertions: i64,
    pub deletions: i64,
}

impl Validate for WorkerChangesResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("files", |cx| self.files.validate(cx));
        cx.at("insertions", |cx| cx.int_min(self.insertions, 0, true));
        cx.at("deletions", |cx| cx.int_min(self.deletions, 0, true));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsChangesResponse {
    pub files: Vec<ChangedFile>,
    pub insertions: i64,
    pub deletions: i64,
    #[serde(deserialize_with = "de::required")]
    pub base_sha: Option<String>,
    #[serde(deserialize_with = "de::required")]
    pub head_sha: Option<String>,
    #[serde(deserialize_with = "de::required")]
    pub base_label: Option<String>,
    pub head_label: String,
    #[serde(deserialize_with = "de::required")]
    pub repo_label: Option<String>,
}

impl Validate for FsChangesResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("files", |cx| self.files.validate(cx));
        cx.at("insertions", |cx| cx.int_min(self.insertions, 0, true));
        cx.at("deletions", |cx| cx.int_min(self.deletions, 0, true));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileDiffQuery {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
}

impl Validate for FileDiffQuery {
    fn validate(&self, cx: &mut Issues) {
        cx.at("path", |cx| cx.str_min(&self.path, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FileDiffResponse {
    pub path: String,
    pub patch: String,
    pub binary: bool,
    pub truncated: bool,
}

impl Validate for FileDiffResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WorkerChangesDiscardRequest {
    pub path: String,
}

impl Validate for WorkerChangesDiscardRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("path", |cx| cx.str_min(&self.path, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WorkerChangesDiscardResponse {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Validate for WorkerChangesDiscardResponse {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ConflictKind {
    Content,
    OursDeleted,
    TheirsDeleted,
    OursAdded,
    TheirsAdded,
    BothDeleted,
}

impl Validate for ConflictKind {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ConflictFile {
    pub path: String,
    pub xy: String,
    pub kind: ConflictKind,
}

impl Validate for ConflictFile {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ConflictListResponse {
    pub files: Vec<ConflictFile>,
}

impl Validate for ConflictListResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ConflictSegment {
    Context(ConflictSegmentContext),
    Conflict(ConflictSegmentConflict),
}

impl Validate for ConflictSegment {
    fn validate(&self, cx: &mut Issues) {
        if let Self::Conflict(v) = self {
            v.validate(cx);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ConflictSegmentContext {
    pub lines: Vec<String>,
}

impl Validate for ConflictSegmentContext {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ConflictSegmentConflict {
    pub id: i64,
    pub ours: Vec<String>,
    #[serde(deserialize_with = "de::required")]
    pub base: Option<Vec<String>>,
    pub theirs: Vec<String>,
}

impl Validate for ConflictSegmentConflict {
    fn validate(&self, cx: &mut Issues) {
        cx.at("id", |cx| cx.int_min(self.id, 0, true));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConflictDocumentResponse {
    pub path: String,
    pub kind: ConflictKind,
    pub style: ConflictDocumentResponseStyle,
    pub segments: Vec<ConflictSegment>,
    pub conflict_count: i64,
    pub fingerprint: String,
}

impl Validate for ConflictDocumentResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("segments", |cx| self.segments.validate(cx));
        cx.at("conflictCount", |cx| cx.int_min(self.conflict_count, 0, true));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ConflictDocumentResponseStyle {
    Merge,
    Diff3,
    None,
    Unparseable,
}

impl Validate for ConflictDocumentResponseStyle {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum HunkResolution {
    Choice(HunkResolutionChoice),
    Manual(HunkResolutionManual),
}

impl Validate for HunkResolution {
    fn validate(&self, cx: &mut Issues) {
        match self {
            Self::Choice(v) => v.validate(cx),
            Self::Manual(v) => v.validate(cx),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HunkResolutionChoice {
    pub id: i64,
    pub choice: HunkResolutionV1Choice,
}

impl Validate for HunkResolutionChoice {
    fn validate(&self, cx: &mut Issues) {
        cx.at("id", |cx| cx.int_min(self.id, 0, true));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum HunkResolutionV1Choice {
    Ours,
    Theirs,
}

impl Validate for HunkResolutionV1Choice {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HunkResolutionManual {
    pub id: i64,
    pub manual: Vec<String>,
}

impl Validate for HunkResolutionManual {
    fn validate(&self, cx: &mut Issues) {
        cx.at("id", |cx| cx.int_min(self.id, 0, true));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ResolveConflictRequest {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolutions: Option<Vec<HunkResolution>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side: Option<ResolveConflictRequestSide>,
}

impl Validate for ResolveConflictRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("path", |cx| cx.str_min(&self.path, 1));
        cx.at("resolutions", |cx| {
            if let Some(v) = &self.resolutions {
                v.validate(cx);
            }
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ResolveConflictRequestSide {
    Ours,
    Theirs,
}

impl Validate for ResolveConflictRequestSide {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ResolveConflictResponse {
    pub ok: bool,
    pub staged: bool,
    pub unresolved: Vec<i64>,
    pub remaining: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl Validate for ResolveConflictResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("unresolved", |cx| {
            for (i, v) in self.unresolved.iter().enumerate() {
                cx.idx(i, |cx| {
                    cx.int_min(*v, 0, true);
                });
            }
        });
        cx.at("remaining", |cx| cx.int_min(self.remaining, 0, true));
    }
}
