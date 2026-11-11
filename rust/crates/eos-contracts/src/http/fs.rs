//! Port of `contracts/src/http.ts` (fs).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::primitives::{BoolLit, Num, de};
use crate::validate::{Issues, Validate, re};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct OpenInRequest {
    pub target: OpenInRequestTarget,
}

impl Validate for OpenInRequest {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum OpenInRequestTarget {
    Vscode,
    Finder,
}

impl Validate for OpenInRequestTarget {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FsOpenInRequest {
    pub path: String,
    pub target: FsOpenInRequestTarget,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<i64>,
}

impl Validate for FsOpenInRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("path", |cx| cx.str_min(&self.path, 1));
        cx.at("line", |cx| {
            if let Some(v) = &self.line {
                cx.int_min(*v, 0, false);
            }
        });
        cx.at("column", |cx| {
            if let Some(v) = &self.column {
                cx.int_min(*v, 0, false);
            }
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum FsOpenInRequestTarget {
    Finder,
    Vscode,
    Cursor,
    Zed,
    Sublime,
    Xcode,
}

impl Validate for FsOpenInRequestTarget {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum PickDirectoryResponse {
    Picked(PickedDirectory),
    Cancelled(PickCancelled),
}

impl Validate for PickDirectoryResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PickedDirectory {
    pub path: String,
}

impl Validate for PickedDirectory {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PickCancelled {
    pub cancelled: BoolLit<true>,
}

impl Validate for PickCancelled {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum PickFileResponse {
    Picked(PickedFiles),
    Cancelled(PickCancelled),
}

impl Validate for PickFileResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PickedFiles {
    pub paths: Vec<String>,
}

impl Validate for PickedFiles {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FsOpenRequest {
    pub path: String,
}

impl Validate for FsOpenRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DefaultAppResponse {
    #[serde(deserialize_with = "de::required")]
    pub app: Option<DefaultAppResponseApp>,
}

impl Validate for DefaultAppResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DefaultAppResponseApp {
    pub bundle_id: String,
    pub bundle_path: String,
    pub app_name: String,
    #[serde(deserialize_with = "de::required")]
    pub icon_url: Option<String>,
}

impl Validate for DefaultAppResponseApp {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RecentsResponse {
    pub paths: Vec<String>,
}

impl Validate for RecentsResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RecentRemoveRequest {
    pub path: String,
}

impl Validate for RecentRemoveRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("path", |cx| cx.str_min(&self.path, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ProjectIcon {
    pub kind: ProjectIconKind,
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

impl Validate for ProjectIcon {
    fn validate(&self, cx: &mut Issues) {
        cx.at("value", |cx| {
            cx.str_min(&self.value, 1);
            cx.str_max(&self.value, 64);
        });
        cx.at("color", |cx| {
            if let Some(v) = &self.color {
                cx.str_max(v, 32);
            }
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ProjectIconKind {
    Emoji,
    Icon,
}

impl Validate for ProjectIconKind {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Project {
    pub id: String,
    #[serde(deserialize_with = "de::trimmed")]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub icon: Option<Option<ProjectIcon>>,
    pub folders: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
}

impl Validate for Project {
    fn validate(&self, cx: &mut Issues) {
        cx.at("id", |cx| cx.str_min(&self.id, 1));
        cx.at("name", |cx| {
            cx.str_min(&self.name, 1);
            cx.str_max(&self.name, 200);
        });
        cx.at("icon", |cx| {
            if let Some(Some(v)) = &self.icon {
                v.validate(cx);
            }
        });
        cx.at("folders", |cx| {
            cx.arr_min(self.folders.len(), 1);
            for (i, v) in self.folders.iter().enumerate() {
                cx.idx(i, |cx| {
                    cx.str_min(v, 1);
                });
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ProjectsResponse {
    pub projects: Vec<Project>,
}

impl Validate for ProjectsResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("projects", |cx| self.projects.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ProjectUpsertRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(deserialize_with = "de::trimmed")]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub icon: Option<Option<ProjectIcon>>,
    pub folders: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
}

impl Validate for ProjectUpsertRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("id", |cx| {
            if let Some(v) = &self.id {
                cx.str_min(v, 1);
            }
        });
        cx.at("name", |cx| {
            cx.str_min(&self.name, 1);
            cx.str_max(&self.name, 200);
        });
        cx.at("icon", |cx| {
            if let Some(Some(v)) = &self.icon {
                v.validate(cx);
            }
        });
        cx.at("folders", |cx| {
            cx.arr_min(self.folders.len(), 1);
            for (i, v) in self.folders.iter().enumerate() {
                cx.idx(i, |cx| {
                    cx.str_min(v, 1);
                });
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ProjectDeleteRequest {
    pub id: String,
}

impl Validate for ProjectDeleteRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("id", |cx| cx.str_min(&self.id, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FsRevealRequest {
    pub path: String,
}

impl Validate for FsRevealRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FsReadQuery {
    pub path: String,
}

impl Validate for FsReadQuery {
    fn validate(&self, cx: &mut Issues) {
        cx.at("path", |cx| cx.str_min(&self.path, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FsReadResponse {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lines: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub large: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<i64>,
}

impl Validate for FsReadResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("lines", |cx| {
            if let Some(v) = &self.lines {
                cx.int_min(*v, 0, true);
            }
        });
        cx.at("size", |cx| {
            if let Some(v) = &self.size {
                cx.int_min(*v, 0, true);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsListQuery {
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
    #[serde(default = "fs_list_query_limit_default", deserialize_with = "de::coerce_int")]
    pub limit: i64,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::coerce_bool_opt")]
    pub include_hidden: Option<bool>,
}

fn fs_list_query_limit_default() -> i64 {
    50
}

impl Validate for FsListQuery {
    fn validate(&self, cx: &mut Issues) {
        cx.at("cwd", |cx| cx.str_min(&self.cwd, 1));
        cx.at("limit", |cx| {
            cx.int_min(self.limit, 0, false);
            cx.int_max(self.limit, 200, true);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub absolute_path: String,
    pub relative_path: String,
    pub r#type: FsEntryType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_symlink: Option<bool>,
}

impl Validate for FsEntry {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum FsEntryType {
    File,
    Directory,
}

impl Validate for FsEntryType {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FsListResponse {
    pub entries: Vec<FsEntry>,
}

impl Validate for FsListResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FsImageQuery {
    pub path: String,
}

impl Validate for FsImageQuery {
    fn validate(&self, cx: &mut Issues) {
        cx.at("path", |cx| cx.str_min(&self.path, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FsWriteRequest {
    pub path: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mkdirp: Option<bool>,
}

impl Validate for FsWriteRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsPasteB64Request {
    pub name: String,
    pub data_b64: String,
}

impl Validate for FsPasteB64Request {
    fn validate(&self, cx: &mut Issues) {
        cx.at("name", |cx| cx.str_min(&self.name, 1));
        cx.at("dataB64", |cx| cx.str_min(&self.data_b64, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FsPasteB64Response {
    pub path: String,
}

impl Validate for FsPasteB64Response {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FsStatQuery {
    pub path: String,
}

impl Validate for FsStatQuery {
    fn validate(&self, cx: &mut Issues) {
        cx.at("path", |cx| cx.str_min(&self.path, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsStatResponse {
    pub absolute_path: String,
    pub r#type: FsStatResponseType,
    pub size: i64,
    pub mtime_ms: Num,
    pub is_symlink: bool,
    pub readonly: bool,
}

impl Validate for FsStatResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("size", |cx| cx.int_min(self.size, 0, true));
        cx.at("mtimeMs", |cx| cx.num_min(self.mtime_ms, 0.0, true));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum FsStatResponseType {
    File,
    Directory,
}

impl Validate for FsStatResponseType {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FsMutationResponse {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Validate for FsMutationResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FsCreateRequest {
    pub root: String,
    pub path: String,
    pub r#type: FsCreateRequestType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

impl Validate for FsCreateRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("root", |cx| cx.str_min(&self.root, 1));
        cx.at("path", |cx| cx.str_min(&self.path, 1));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum FsCreateRequestType {
    File,
    Directory,
}

impl Validate for FsCreateRequestType {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsRenameRequest {
    pub root: String,
    pub path: String,
    pub new_name: String,
}

impl Validate for FsRenameRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("root", |cx| cx.str_min(&self.root, 1));
        cx.at("path", |cx| cx.str_min(&self.path, 1));
        cx.at("newName", |cx| {
            cx.str_min(&self.new_name, 1);
            cx.regex(&self.new_name, re!(r"^[^/\0]+$"), Some("name cannot contain '/' or null"));
            if self.new_name == "." || self.new_name == ".." {
                cx.push("invalid name");
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsMoveRequest {
    pub root: String,
    pub paths: Vec<String>,
    pub dest_dir: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overwrite: Option<bool>,
}

impl Validate for FsMoveRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("root", |cx| cx.str_min(&self.root, 1));
        cx.at("paths", |cx| {
            cx.arr_min(self.paths.len(), 1);
            cx.arr_max(self.paths.len(), 500);
            for (i, v) in self.paths.iter().enumerate() {
                cx.idx(i, |cx| {
                    cx.str_min(v, 1);
                });
            }
        });
        cx.at("destDir", |cx| cx.str_min(&self.dest_dir, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FsMoveResponse {
    pub ok: bool,
    pub results: Vec<FsMoveResponseResultsItem>,
}

impl Validate for FsMoveResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FsMoveResponseResultsItem {
    pub from: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Validate for FsMoveResponseResultsItem {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FsTrashRequest {
    pub root: String,
    pub paths: Vec<String>,
}

impl Validate for FsTrashRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("root", |cx| cx.str_min(&self.root, 1));
        cx.at("paths", |cx| {
            cx.arr_min(self.paths.len(), 1);
            cx.arr_max(self.paths.len(), 500);
            for (i, v) in self.paths.iter().enumerate() {
                cx.idx(i, |cx| {
                    cx.str_min(v, 1);
                });
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FsTrashResponse {
    pub ok: bool,
    pub trashed: Vec<String>,
    pub failed: Vec<FsTrashResponseFailedItem>,
}

impl Validate for FsTrashResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FsTrashResponseFailedItem {
    pub path: String,
    pub error: String,
}

impl Validate for FsTrashResponseFailedItem {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsWatchRequest {
    pub root: String,
    pub dir: String,
    pub client_id: String,
}

impl Validate for FsWatchRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("root", |cx| cx.str_min(&self.root, 1));
        cx.at("dir", |cx| cx.str_min(&self.dir, 1));
        cx.at("clientId", |cx| cx.str_min(&self.client_id, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsUnwatchRequest {
    pub client_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub all: Option<bool>,
}

impl Validate for FsUnwatchRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("clientId", |cx| cx.str_min(&self.client_id, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FsWatchResponse {
    pub ok: bool,
}

impl Validate for FsWatchResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitWatchRequest {
    pub dir: String,
    pub client_id: String,
}

impl Validate for GitWatchRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("dir", |cx| cx.str_min(&self.dir, 1));
        cx.at("clientId", |cx| cx.str_min(&self.client_id, 1));
    }
}

/// Editor id → macOS app name (`open -a <name>`), in the order `GET /fs/editors` lists them.
pub const EDITOR_APPS: &[(&str, &str)] = &[
    ("vscode", "Visual Studio Code"),
    ("cursor", "Cursor"),
    ("zed", "Zed"),
    ("sublime", "Sublime Text"),
    ("xcode", "Xcode"),
];
