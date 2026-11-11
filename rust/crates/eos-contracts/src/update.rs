//! Port of `contracts/src/update.ts`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::primitives::{IntLit, Num, de, str_lit};
use crate::validate::{Issues, Validate, re};

str_lit!(pub StableLit = "stable");

pub const UPDATE_FEED_URL: &str = "https://updates.ibrahimalbyrk.dev";

pub const UPDATE_PUBLIC_KEYS: &[&str] = &["XsyucF535SwQU0iA6UMdq52Pp7DEEL267ily0GBldQY"];

pub const UPDATE_MANIFEST_FORMAT: i64 = 1;

pub const UPDATE_PLATFORMS: &[&str] = &["darwin-arm64", "win32-x64", "win32-arm64"];

/// A path inside the feed never climbs (`FeedPathSchema`'s refinement).
fn no_dot_segments(cx: &mut Issues, p: &str) {
    if p.split('/').any(|s| s == "." || s == "..") {
        cx.push("no dot segments");
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum UpdatePlatform {
    DarwinArm64,
    Win32X64,
    Win32Arm64,
}

impl Validate for UpdatePlatform {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct AppVersion(pub String);

impl Validate for AppVersion {
    fn validate(&self, cx: &mut Issues) {
        cx.regex(&self.0, re!(r"^\d+\.\d+\.\d+$"), None);
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePointer {
    pub version: AppVersion,
    pub platform: UpdatePlatform,
    pub manifest: UpdatePointerManifest,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    pub released_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feed_url: Option<String>,
}

impl Validate for UpdatePointer {
    fn validate(&self, cx: &mut Issues) {
        cx.at("version", |cx| self.version.validate(cx));
        cx.at("manifest", |cx| self.manifest.validate(cx));
        cx.at("notes", |cx| {
            if let Some(v) = &self.notes {
                cx.str_min(v, 1);
                cx.str_max(v, 512);
                cx.regex(v, re!(r"^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$"), None);
                no_dot_segments(cx, v);
            }
        });
        cx.at("releasedAt", |cx| cx.datetime(&self.released_at));
        cx.at("feedUrl", |cx| {
            if let Some(v) = &self.feed_url {
                cx.url(v);
                cx.starts_with(v, "https://");
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UpdatePointerManifest {
    pub path: String,
    pub sha256: String,
    pub size: i64,
}

impl Validate for UpdatePointerManifest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("path", |cx| {
            cx.str_min(&self.path, 1);
            cx.str_max(&self.path, 512);
            cx.regex(&self.path, re!(r"^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$"), None);
            no_dot_segments(cx, &self.path);
        });
        cx.at("sha256", |cx| cx.regex(&self.sha256, re!(r"^[0-9a-f]{64}$"), None));
        cx.at("size", |cx| cx.int_min(self.size, 0, false));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SignedUpdatePointer {
    pub payload: String,
    pub signature: String,
}

impl Validate for SignedUpdatePointer {
    fn validate(&self, cx: &mut Issues) {
        cx.at("payload", |cx| {
            cx.str_min(&self.payload, 2);
            cx.str_max(&self.payload, 16384);
        });
        cx.at("signature", |cx| cx.regex(&self.signature, re!(r"^[A-Za-z0-9+/]{86}==$"), None));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PackSpan {
    pub pack: i64,
    pub offset: i64,
    pub zsize: i64,
}

impl Validate for PackSpan {
    fn validate(&self, cx: &mut Issues) {
        cx.at("pack", |cx| cx.int_min(self.pack, 0, true));
        cx.at("offset", |cx| cx.int_min(self.offset, 0, true));
        cx.at("zsize", |cx| cx.int_min(self.zsize, 0, false));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UpdateChunk {
    pub pack: i64,
    pub offset: i64,
    pub zsize: i64,
    pub id: String,
    pub size: i64,
}

impl Validate for UpdateChunk {
    fn validate(&self, cx: &mut Issues) {
        cx.at("pack", |cx| cx.int_min(self.pack, 0, true));
        cx.at("offset", |cx| cx.int_min(self.offset, 0, true));
        cx.at("zsize", |cx| cx.int_min(self.zsize, 0, false));
        cx.at("id", |cx| cx.regex(&self.id, re!(r"^[0-9a-f]{64}$"), None));
        cx.at("size", |cx| cx.int_min(self.size, 0, false));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum UpdateEntry {
    Dir(UpdateEntryDir),
    Link(UpdateEntryLink),
    File(UpdateEntryFile),
}

impl Validate for UpdateEntry {
    fn validate(&self, cx: &mut Issues) {
        match self {
            Self::Dir(v) => v.validate(cx),
            Self::Link(v) => v.validate(cx),
            Self::File(v) => v.validate(cx),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UpdateEntryDir {
    pub path: String,
    pub mode: i64,
}

impl Validate for UpdateEntryDir {
    fn validate(&self, cx: &mut Issues) {
        cx.at("path", |cx| {
            cx.str_min(&self.path, 1);
            cx.str_max(&self.path, 4096);
        });
        cx.at("mode", |cx| {
            cx.int_min(self.mode, 0, true);
            cx.int_max(self.mode, 511, true);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UpdateEntryLink {
    pub path: String,
    pub target: String,
}

impl Validate for UpdateEntryLink {
    fn validate(&self, cx: &mut Issues) {
        cx.at("path", |cx| {
            cx.str_min(&self.path, 1);
            cx.str_max(&self.path, 4096);
        });
        cx.at("target", |cx| {
            cx.str_min(&self.target, 1);
            cx.str_max(&self.target, 4096);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UpdateEntryFile {
    pub path: String,
    pub mode: i64,
    pub size: i64,
    pub sha256: String,
    pub chunks: Vec<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub whole: Option<PackSpan>,
}

impl Validate for UpdateEntryFile {
    fn validate(&self, cx: &mut Issues) {
        cx.at("path", |cx| {
            cx.str_min(&self.path, 1);
            cx.str_max(&self.path, 4096);
        });
        cx.at("mode", |cx| {
            cx.int_min(self.mode, 0, true);
            cx.int_max(self.mode, 511, true);
        });
        cx.at("size", |cx| cx.int_min(self.size, 0, true));
        cx.at("sha256", |cx| cx.regex(&self.sha256, re!(r"^[0-9a-f]{64}$"), None));
        cx.at("chunks", |cx| {
            for (i, v) in self.chunks.iter().enumerate() {
                cx.idx(i, |cx| {
                    cx.int_min(*v, 0, true);
                });
            }
        });
        cx.at("whole", |cx| {
            if let Some(v) = &self.whole {
                v.validate(cx);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UpdateManifest {
    pub format: IntLit<1>,
    pub version: AppVersion,
    pub platform: UpdatePlatform,
    pub packs: Vec<String>,
    pub chunks: Vec<UpdateChunk>,
    pub entries: Vec<UpdateEntry>,
}

impl Validate for UpdateManifest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("version", |cx| self.version.validate(cx));
        cx.at("packs", |cx| {
            for (i, v) in self.packs.iter().enumerate() {
                cx.idx(i, |cx| {
                    cx.str_min(v, 1);
                    cx.str_max(v, 512);
                    cx.regex(v, re!(r"^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$"), None);
                    no_dot_segments(cx, v);
                });
            }
        });
        cx.at("chunks", |cx| self.chunks.validate(cx));
        cx.at("entries", |cx| self.entries.validate(cx));
    }
}

pub const UPDATE_PHASES: &[&str] =
    &["off", "idle", "checking", "available", "downloading", "staging", "ready", "waiting", "applying", "error"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum UpdatePhase {
    Off,
    Idle,
    Checking,
    Available,
    Downloading,
    Staging,
    Ready,
    Waiting,
    Applying,
    Error,
}

impl Validate for UpdatePhase {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateOffReason {
    DevBuild,
    Platform,
    ReadOnly,
}

impl Validate for UpdateOffReason {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UpdateStatus {
    pub phase: UpdatePhase,
    #[serde(deserialize_with = "de::required")]
    pub off: Option<UpdateOffReason>,
    #[serde(deserialize_with = "de::required")]
    pub version: Option<AppVersion>,
    #[serde(deserialize_with = "de::required")]
    pub bytes: Option<i64>,
    #[serde(deserialize_with = "de::required")]
    pub done: Option<i64>,
    #[serde(deserialize_with = "de::required")]
    pub full: Option<i64>,
    #[serde(deserialize_with = "de::required")]
    pub agents: Option<i64>,
    #[serde(deserialize_with = "de::required")]
    pub error: Option<String>,
}

impl Validate for UpdateStatus {
    fn validate(&self, cx: &mut Issues) {
        cx.at("version", |cx| {
            if let Some(v) = &self.version {
                v.validate(cx);
            }
        });
        cx.at("bytes", |cx| {
            if let Some(v) = &self.bytes {
                cx.int_min(*v, 0, true);
            }
        });
        cx.at("done", |cx| {
            if let Some(v) = &self.done {
                cx.int_min(*v, 0, true);
            }
        });
        cx.at("full", |cx| {
            if let Some(v) = &self.full {
                cx.int_min(*v, 0, true);
            }
        });
        cx.at("agents", |cx| {
            if let Some(v) = &self.agents {
                cx.int_min(*v, 0, true);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UpdateNotice {
    pub kind: UpdateNoticeKind,
    pub version: AppVersion,
    pub from: AppVersion,
}

impl Validate for UpdateNotice {
    fn validate(&self, cx: &mut Issues) {
        cx.at("version", |cx| self.version.validate(cx));
        cx.at("from", |cx| self.from.validate(cx));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateNoticeKind {
    Updated,
    RolledBack,
}

impl Validate for UpdateNoticeKind {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    #[serde(deserialize_with = "de::required")]
    pub current: Option<AppVersion>,
    pub status: UpdateStatus,
    #[serde(deserialize_with = "de::required")]
    pub last_checked_at: Option<Num>,
    pub auto_download: bool,
    #[serde(deserialize_with = "de::required")]
    pub notes: Option<String>,
    #[serde(deserialize_with = "de::required")]
    pub notice: Option<UpdateNotice>,
}

impl Validate for UpdateState {
    fn validate(&self, cx: &mut Issues) {
        cx.at("current", |cx| {
            if let Some(v) = &self.current {
                v.validate(cx);
            }
        });
        cx.at("status", |cx| self.status.validate(cx));
        cx.at("notice", |cx| {
            if let Some(v) = &self.notice {
                v.validate(cx);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UpdateApply {
    pub version: AppVersion,
    pub from: AppVersion,
    pub staged: String,
    pub target: String,
}

impl Validate for UpdateApply {
    fn validate(&self, cx: &mut Issues) {
        cx.at("version", |cx| self.version.validate(cx));
        cx.at("from", |cx| self.from.validate(cx));
        cx.at("staged", |cx| cx.str_min(&self.staged, 1));
        cx.at("target", |cx| cx.str_min(&self.target, 1));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum UpdateCheckTrigger {
    Manual,
    Opened,
    Woke,
}

impl Validate for UpdateCheckTrigger {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdateCheckRequest {
    #[serde(default = "update_check_request_trigger_default")]
    pub trigger: UpdateCheckTrigger,
}

fn update_check_request_trigger_default() -> UpdateCheckTrigger {
    UpdateCheckTrigger::Manual
}

impl Validate for UpdateCheckRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdateRestartRequest {
    pub when: UpdateRestartRequestWhen,
}

impl Validate for UpdateRestartRequest {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum UpdateRestartRequestWhen {
    Now,
    Idle,
}

impl Validate for UpdateRestartRequestWhen {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_download: Option<bool>,
}

impl Validate for UpdateSettingsPatch {}

pub const UPDATE_BUILD_INFO_FILE: &str = "update.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UpdateBuildInfo {
    pub version: AppVersion,
    pub channel: StableLit,
    pub platform: UpdatePlatform,
}

impl Validate for UpdateBuildInfo {
    fn validate(&self, cx: &mut Issues) {
        cx.at("version", |cx| self.version.validate(cx));
    }
}

pub mod update_topics {
    pub const CHANGE: &str = "update:change";
    pub const APPLY: &str = "update:apply";
}

/// What the applier and the new app leave in `~/.eos/updates` for each other.
pub mod update_files {
    /// The applier is waiting for this version to come up.
    pub const PENDING: &str = "apply.json";
    /// The new app came up (its version inside).
    pub const BOOT_OK: &str = "boot-ok";
    /// How the last swap ended (`UpdateNotice` + `dismissed`).
    pub const RESULT: &str = "result.json";
}
