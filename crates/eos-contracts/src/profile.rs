use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::primitives::{Num, de};
use crate::validate::{Issues, Validate, re};

pub const PROFILE_NAME_MAX: i64 = 120;

pub const PROFILE_CALL_NAME_MAX: i64 = 60;

pub const PROFILE_HANDLE_MAX: i64 = 40;

pub const PROFILE_STACK_MAX: i64 = 40;

pub const PROFILE_INSTRUCTIONS_MAX: i64 = 4000;

pub const PROFILE_BUDGET_MIN: i64 = 200;

pub const PROFILE_BUDGET_MAX: i64 = 4000;

pub const PROFILE_BUDGET_DEFAULT: i64 = 800;

pub const USER_MEMORY_TEXT_MAX: i64 = 500;

pub const USER_MEMORY_WHY_MAX: i64 = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum WorkRole {
    Engineering,
    Design,
    Product,
    Research,
    Data,
    Writing,
}

impl Validate for WorkRole {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ExpertiseLevel {
    Learning,
    Practitioner,
    Expert,
}

impl Validate for ExpertiseLevel {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ReplyStyle {
    Terse,
    Balanced,
    Thorough,
}

impl Validate for ReplyStyle {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Autonomy {
    Ask,
    Balanced,
    Run,
}

impl Validate for Autonomy {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum WhenUnclear {
    Ask,
    Decide,
}

impl Validate for WhenUnclear {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum CommitPolicy {
    OnRequest,
    Milestones,
}

impl Validate for CommitPolicy {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct ProfileLanguage(pub String);

impl Validate for ProfileLanguage {
    fn validate(&self, cx: &mut Issues) {
        cx.regex(&self.0, re!(r"^(mirror|[a-z]{2,3}(-[A-Za-z0-9]{2,8})*)$"), Some("invalid language"));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AvatarExt {
    Png,
    Jpeg,
    Webp,
}

impl Validate for AvatarExt {}

pub const AVATAR_MAX_BYTES: i64 = 5242880;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum DreamSchedule {
    Nightly,
    Away,
    Manual,
}

impl Validate for DreamSchedule {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum DreamModel {
    Opus,
    Sonnet,
    Haiku,
}

impl Validate for DreamModel {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DreamingSettings {
    pub enabled: bool,
    pub schedule: DreamSchedule,
    pub nightly_at: String,
    pub away_minutes: i64,
    pub model: DreamModel,
    pub max_chats: i64,
    pub usage_ceiling: Num,
    pub excluded_projects: Vec<String>,
    pub include_no_folder: bool,
    pub morning_note: bool,
}

impl Validate for DreamingSettings {
    fn validate(&self, cx: &mut Issues) {
        cx.at("nightlyAt", |cx| cx.regex(&self.nightly_at, re!(r"^([01]\d|2[0-3]):[0-5]\d$"), Some("HH:MM")));
        cx.at("awayMinutes", |cx| {
            cx.int_min(self.away_minutes, 5, true);
            cx.int_max(self.away_minutes, 240, true);
        });
        cx.at("maxChats", |cx| {
            cx.int_min(self.max_chats, 1, true);
            cx.int_max(self.max_chats, 60, true);
        });
        cx.at("usageCeiling", |cx| {
            cx.num_min(self.usage_ceiling, 0.1, true);
            cx.num_max(self.usage_ceiling, 1.0, true);
        });
        cx.at("excludedProjects", |cx| {
            cx.arr_max(self.excluded_projects.len(), 200);
            for (i, v) in self.excluded_projects.iter().enumerate() {
                cx.idx(i, |cx| {
                    cx.str_min(v, 1);
                });
            }
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum DreamProposalKind {
    New,
    Update,
    Merge,
    Promote,
    Retire,
}

impl Validate for DreamProposalKind {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DreamEvidence {
    pub quote: String,
    pub worker_id: String,
    pub chat: String,
    #[serde(deserialize_with = "de::required")]
    pub event_id: Option<i64>,
    pub by: DreamEvidenceBy,
}

impl Validate for DreamEvidence {
    fn validate(&self, cx: &mut Issues) {
        cx.at("quote", |cx| cx.str_max(&self.quote, 400));
        cx.at("workerId", |cx| cx.str_min(&self.worker_id, 1));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum DreamEvidenceBy {
    User,
    Agent,
}

impl Validate for DreamEvidenceBy {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UserProfile {
    pub rev: i64,
    pub updated_at: Num,
    pub identity: UserProfileIdentity,
    pub language: UserProfileLanguage,
    pub work: UserProfileWork,
    pub style: UserProfileStyle,
    pub instructions: String,
    pub sharing: UserProfileSharing,
    pub budget_tokens: i64,
    #[serde(deserialize_with = "de::required")]
    pub onboarded_at: Option<Num>,
    #[serde(default = "default_dreaming")]
    pub dreaming: DreamingSettings,
}

/// `DEFAULT_DREAMING`: dreaming off, nightly at 03:00 on Opus.
pub fn default_dreaming() -> DreamingSettings {
    DreamingSettings {
        enabled: false,
        schedule: DreamSchedule::Nightly,
        nightly_at: "03:00".to_owned(),
        away_minutes: 20,
        model: DreamModel::Opus,
        max_chats: 20,
        usage_ceiling: Num(0.7),
        excluded_projects: Vec::new(),
        include_no_folder: true,
        morning_note: true,
    }
}

impl Validate for UserProfile {
    fn validate(&self, cx: &mut Issues) {
        cx.at("rev", |cx| cx.int_min(self.rev, 0, true));
        cx.at("identity", |cx| self.identity.validate(cx));
        cx.at("language", |cx| self.language.validate(cx));
        cx.at("work", |cx| self.work.validate(cx));
        cx.at("instructions", |cx| cx.str_max(&self.instructions, 4000));
        cx.at("sharing", |cx| self.sharing.validate(cx));
        cx.at("budgetTokens", |cx| {
            cx.int_min(self.budget_tokens, 200, true);
            cx.int_max(self.budget_tokens, 4000, true);
        });
        cx.at("dreaming", |cx| self.dreaming.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UserProfileIdentity {
    pub full_name: String,
    pub call_name: String,
    pub handle: String,
    #[serde(deserialize_with = "de::required")]
    pub avatar: Option<AvatarExt>,
}

impl Validate for UserProfileIdentity {
    fn validate(&self, cx: &mut Issues) {
        cx.at("fullName", |cx| cx.str_max(&self.full_name, 120));
        cx.at("callName", |cx| cx.str_max(&self.call_name, 60));
        cx.at("handle", |cx| cx.str_max(&self.handle, 40));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UserProfileLanguage {
    #[serde(deserialize_with = "de::required")]
    pub chat: Option<ProfileLanguage>,
    #[serde(deserialize_with = "de::required")]
    pub code: Option<ProfileLanguage>,
}

impl Validate for UserProfileLanguage {
    fn validate(&self, cx: &mut Issues) {
        cx.at("chat", |cx| {
            if let Some(v) = &self.chat {
                v.validate(cx);
            }
        });
        cx.at("code", |cx| {
            if let Some(v) = &self.code {
                v.validate(cx);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UserProfileWork {
    pub roles: Vec<WorkRole>,
    pub stack: Vec<String>,
    #[serde(deserialize_with = "de::required")]
    pub level: Option<ExpertiseLevel>,
}

impl Validate for UserProfileWork {
    fn validate(&self, cx: &mut Issues) {
        cx.at("roles", |cx| cx.arr_max(self.roles.len(), 6));
        cx.at("stack", |cx| {
            cx.arr_max(self.stack.len(), 40);
            for (i, v) in self.stack.iter().enumerate() {
                cx.idx(i, |cx| {
                    cx.str_min(v, 1);
                    cx.str_max(v, 40);
                });
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UserProfileStyle {
    #[serde(deserialize_with = "de::required")]
    pub replies: Option<ReplyStyle>,
    #[serde(deserialize_with = "de::required")]
    pub autonomy: Option<Autonomy>,
    #[serde(deserialize_with = "de::required")]
    pub when_unclear: Option<WhenUnclear>,
    #[serde(deserialize_with = "de::required")]
    pub commits: Option<CommitPolicy>,
}

impl Validate for UserProfileStyle {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UserProfileSharing {
    pub withhold_from: Vec<String>,
}

impl Validate for UserProfileSharing {
    fn validate(&self, cx: &mut Issues) {
        cx.at("withholdFrom", |cx| {
            cx.arr_max(self.withhold_from.len(), 32);
            for (i, v) in self.withhold_from.iter().enumerate() {
                cx.idx(i, |cx| {
                    cx.str_min(v, 1);
                });
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserProfilePatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<UserProfilePatchIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<UserProfilePatchLanguage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work: Option<UserProfilePatchWork>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<UserProfilePatchStyle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sharing: Option<UserProfilePatchSharing>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub onboarded_at: Option<Option<Num>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dreaming: Option<UserProfilePatchDreaming>,
}

impl Validate for UserProfilePatch {
    fn validate(&self, cx: &mut Issues) {
        cx.at("identity", |cx| {
            if let Some(v) = &self.identity {
                v.validate(cx);
            }
        });
        cx.at("language", |cx| {
            if let Some(v) = &self.language {
                v.validate(cx);
            }
        });
        cx.at("work", |cx| {
            if let Some(v) = &self.work {
                v.validate(cx);
            }
        });
        cx.at("instructions", |cx| {
            if let Some(v) = &self.instructions {
                cx.str_max(v, 4000);
            }
        });
        cx.at("sharing", |cx| {
            if let Some(v) = &self.sharing {
                v.validate(cx);
            }
        });
        cx.at("budgetTokens", |cx| {
            if let Some(v) = &self.budget_tokens {
                cx.int_min(*v, 200, true);
                cx.int_max(*v, 4000, true);
            }
        });
        cx.at("dreaming", |cx| {
            if let Some(v) = &self.dreaming {
                v.validate(cx);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserProfilePatchIdentity {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub call_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
}

impl Validate for UserProfilePatchIdentity {
    fn validate(&self, cx: &mut Issues) {
        cx.at("fullName", |cx| {
            if let Some(v) = &self.full_name {
                cx.str_max(v, 120);
            }
        });
        cx.at("callName", |cx| {
            if let Some(v) = &self.call_name {
                cx.str_max(v, 60);
            }
        });
        cx.at("handle", |cx| {
            if let Some(v) = &self.handle {
                cx.str_max(v, 40);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UserProfilePatchLanguage {
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub chat: Option<Option<ProfileLanguage>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub code: Option<Option<ProfileLanguage>>,
}

impl Validate for UserProfilePatchLanguage {
    fn validate(&self, cx: &mut Issues) {
        cx.at("chat", |cx| {
            if let Some(Some(v)) = &self.chat {
                v.validate(cx);
            }
        });
        cx.at("code", |cx| {
            if let Some(Some(v)) = &self.code {
                v.validate(cx);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UserProfilePatchWork {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roles: Option<Vec<WorkRole>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub level: Option<Option<ExpertiseLevel>>,
}

impl Validate for UserProfilePatchWork {
    fn validate(&self, cx: &mut Issues) {
        cx.at("roles", |cx| {
            if let Some(v) = &self.roles {
                cx.arr_max(v.len(), 6);
            }
        });
        cx.at("stack", |cx| {
            if let Some(v) = &self.stack {
                cx.arr_max(v.len(), 40);
                for (i, v) in v.iter().enumerate() {
                    cx.idx(i, |cx| {
                        cx.str_min(v, 1);
                        cx.str_max(v, 40);
                    });
                }
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserProfilePatchStyle {
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub replies: Option<Option<ReplyStyle>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub autonomy: Option<Option<Autonomy>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub when_unclear: Option<Option<WhenUnclear>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub commits: Option<Option<CommitPolicy>>,
}

impl Validate for UserProfilePatchStyle {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserProfilePatchSharing {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub withhold_from: Option<Vec<String>>,
}

impl Validate for UserProfilePatchSharing {
    fn validate(&self, cx: &mut Issues) {
        cx.at("withholdFrom", |cx| {
            if let Some(v) = &self.withhold_from {
                cx.arr_max(v.len(), 32);
                for (i, v) in v.iter().enumerate() {
                    cx.idx(i, |cx| {
                        cx.str_min(v, 1);
                    });
                }
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserProfilePatchDreaming {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<DreamSchedule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nightly_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub away_minutes: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<DreamModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_chats: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_ceiling: Option<Num>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excluded_projects: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_no_folder: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub morning_note: Option<bool>,
}

impl Validate for UserProfilePatchDreaming {
    fn validate(&self, cx: &mut Issues) {
        cx.at("nightlyAt", |cx| {
            if let Some(v) = &self.nightly_at {
                cx.regex(v, re!(r"^([01]\d|2[0-3]):[0-5]\d$"), Some("HH:MM"));
            }
        });
        cx.at("awayMinutes", |cx| {
            if let Some(v) = &self.away_minutes {
                cx.int_min(*v, 5, true);
                cx.int_max(*v, 240, true);
            }
        });
        cx.at("maxChats", |cx| {
            if let Some(v) = &self.max_chats {
                cx.int_min(*v, 1, true);
                cx.int_max(*v, 60, true);
            }
        });
        cx.at("usageCeiling", |cx| {
            if let Some(v) = &self.usage_ceiling {
                cx.num_min(*v, 0.1, true);
                cx.num_max(*v, 1.0, true);
            }
        });
        cx.at("excludedProjects", |cx| {
            if let Some(v) = &self.excluded_projects {
                cx.arr_max(v.len(), 200);
                for (i, v) in v.iter().enumerate() {
                    cx.idx(i, |cx| {
                        cx.str_min(v, 1);
                    });
                }
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UserProfileUpdateRequest {
    pub patch: UserProfilePatch,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_rev: Option<i64>,
}

impl Validate for UserProfileUpdateRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("patch", |cx| self.patch.validate(cx));
        cx.at("baseRev", |cx| {
            if let Some(v) = &self.base_rev {
                cx.int_min(*v, 0, true);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UserProfileResponse {
    pub profile: UserProfile,
}

impl Validate for UserProfileResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("profile", |cx| self.profile.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UserProfilePreview {
    pub text: String,
    pub tokens: i64,
    pub budget_tokens: i64,
    pub included_memory_ids: Vec<String>,
    pub overflow: i64,
    pub withheld: bool,
}

impl Validate for UserProfilePreview {
    fn validate(&self, cx: &mut Issues) {
        cx.at("tokens", |cx| cx.int_min(self.tokens, 0, true));
        cx.at("overflow", |cx| cx.int_min(self.overflow, 0, true));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ClaudeMdImportResponse {
    #[serde(deserialize_with = "de::required")]
    pub path: Option<String>,
    pub text: String,
}

impl Validate for ClaudeMdImportResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UserProfileChangeEvent {
    pub rev: i64,
}

impl Validate for UserProfileChangeEvent {
    fn validate(&self, cx: &mut Issues) {
        cx.at("rev", |cx| cx.int_min(self.rev, 0, true));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct UserMemoryId(pub String);

impl Validate for UserMemoryId {
    fn validate(&self, cx: &mut Issues) {
        cx.regex(&self.0, re!(r"^um-[a-z0-9]{8,32}$"), Some("invalid memory id"));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum UserMemoryCategory {
    About,
    WorkStyle,
    Stack,
    Other,
}

impl Validate for UserMemoryCategory {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum UserMemoryDomain {
    Communication,
    Planning,
    Code,
    Ui,
    Testing,
    Debugging,
    Git,
    Tools,
    About,
}

impl Validate for UserMemoryDomain {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum UserMemoryScope {
    Global,
    Project(UserMemoryScopeProject),
}

impl Validate for UserMemoryScope {
    fn validate(&self, cx: &mut Issues) {
        if let Self::Project(v) = self {
            v.validate(cx);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UserMemoryScopeProject {
    pub path: String,
}

impl Validate for UserMemoryScopeProject {
    fn validate(&self, cx: &mut Issues) {
        cx.at("path", |cx| cx.str_min(&self.path, 1));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum UserMemoryTier {
    Always,
    OnDemand,
}

impl Validate for UserMemoryTier {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum UserMemoryStatus {
    Active,
    Suggested,
    Dismissed,
}

impl Validate for UserMemoryStatus {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum UserMemorySource {
    User,
    Agent(UserMemorySourceAgent),
    Import(UserMemorySourceImport),
    Dream(UserMemorySourceDream),
}

impl Validate for UserMemorySource {
    fn validate(&self, cx: &mut Issues) {
        match self {
            Self::Agent(v) => v.validate(cx),
            Self::Import(v) => v.validate(cx),
            Self::Dream(v) => v.validate(cx),
            _ => {}
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UserMemorySourceAgent {
    pub agent_id: String,
    pub agent_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
}

impl Validate for UserMemorySourceAgent {
    fn validate(&self, cx: &mut Issues) {
        cx.at("agentId", |cx| cx.str_min(&self.agent_id, 1));
        cx.at("why", |cx| {
            if let Some(v) = &self.why {
                cx.str_max(v, 300);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UserMemorySourceImport {
    pub from: String,
}

impl Validate for UserMemorySourceImport {
    fn validate(&self, cx: &mut Issues) {
        cx.at("from", |cx| cx.str_min(&self.from, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UserMemorySourceDream {
    pub dream_id: String,
    pub evidence: Vec<DreamEvidence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
}

impl Validate for UserMemorySourceDream {
    fn validate(&self, cx: &mut Issues) {
        cx.at("dreamId", |cx| cx.str_min(&self.dream_id, 1));
        cx.at("evidence", |cx| {
            cx.arr_max(self.evidence.len(), 8);
            self.evidence.validate(cx);
        });
        cx.at("why", |cx| {
            if let Some(v) = &self.why {
                cx.str_max(v, 300);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DreamSupportSummary {
    pub chats: i64,
    pub days: i64,
    pub projects: i64,
    pub first_seen: Num,
    pub last_seen: Num,
    pub origin: DreamSupportSummaryOrigin,
}

impl Validate for DreamSupportSummary {
    fn validate(&self, cx: &mut Issues) {
        cx.at("chats", |cx| cx.int_min(self.chats, 0, true));
        cx.at("days", |cx| cx.int_min(self.days, 0, true));
        cx.at("projects", |cx| cx.int_min(self.projects, 0, true));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum DreamSupportSummaryOrigin {
    Explicit,
    Inferred,
}

impl Validate for DreamSupportSummaryOrigin {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UserMemoryProposal {
    pub kind: DreamProposalKind,
    pub targets: Vec<UserMemoryId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub support: Option<DreamSupportSummary>,
}

impl Validate for UserMemoryProposal {
    fn validate(&self, cx: &mut Issues) {
        cx.at("targets", |cx| {
            cx.arr_max(self.targets.len(), 6);
            self.targets.validate(cx);
        });
        cx.at("confidence", |cx| {
            if let Some(v) = &self.confidence {
                cx.int_min(*v, 1, true);
                cx.int_max(*v, 3, true);
            }
        });
        cx.at("support", |cx| {
            if let Some(v) = &self.support {
                v.validate(cx);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UserMemory {
    pub id: UserMemoryId,
    #[serde(deserialize_with = "de::trimmed")]
    pub text: String,
    pub category: UserMemoryCategory,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<UserMemoryDomain>,
    pub scope: UserMemoryScope,
    pub tier: UserMemoryTier,
    pub status: UserMemoryStatus,
    pub source: UserMemorySource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal: Option<UserMemoryProposal>,
    pub rev: i64,
    pub created_at: Num,
    pub updated_at: Num,
}

impl Validate for UserMemory {
    fn validate(&self, cx: &mut Issues) {
        cx.at("id", |cx| self.id.validate(cx));
        cx.at("text", |cx| {
            cx.str_min(&self.text, 1);
            cx.str_max(&self.text, 500);
        });
        cx.at("scope", |cx| self.scope.validate(cx));
        cx.at("source", |cx| self.source.validate(cx));
        cx.at("proposal", |cx| {
            if let Some(v) = &self.proposal {
                v.validate(cx);
            }
        });
        cx.at("rev", |cx| cx.int_min(self.rev, 0, true));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UserMemoryListResponse {
    pub memories: Vec<UserMemory>,
}

impl Validate for UserMemoryListResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("memories", |cx| self.memories.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UserMemoryResponse {
    pub memory: UserMemory,
}

impl Validate for UserMemoryResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("memory", |cx| self.memory.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UserMemoryCreateRequest {
    #[serde(deserialize_with = "de::trimmed")]
    pub text: String,
    pub category: UserMemoryCategory,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<UserMemoryDomain>,
    pub scope: UserMemoryScope,
    #[serde(default = "user_memory_create_request_tier_default")]
    pub tier: UserMemoryTier,
}

fn user_memory_create_request_tier_default() -> UserMemoryTier {
    UserMemoryTier::Always
}

impl Validate for UserMemoryCreateRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("text", |cx| {
            cx.str_min(&self.text, 1);
            cx.str_max(&self.text, 500);
        });
        cx.at("scope", |cx| self.scope.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UserMemoryUpdateRequest {
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::trimmed_opt")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<UserMemoryCategory>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<UserMemoryDomain>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<UserMemoryScope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tier: Option<UserMemoryTier>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_rev: Option<i64>,
}

impl Validate for UserMemoryUpdateRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("text", |cx| {
            if let Some(v) = &self.text {
                cx.str_min(v, 1);
                cx.str_max(v, 500);
            }
        });
        cx.at("scope", |cx| {
            if let Some(v) = &self.scope {
                v.validate(cx);
            }
        });
        cx.at("baseRev", |cx| {
            if let Some(v) = &self.base_rev {
                cx.int_min(*v, 0, true);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UserMemorySuggestRequest {
    #[serde(deserialize_with = "de::trimmed")]
    pub text: String,
    pub category: UserMemoryCategory,
    pub scope: UserMemorySuggestRequestScope,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::trimmed_opt")]
    pub why: Option<String>,
}

impl Validate for UserMemorySuggestRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("text", |cx| {
            cx.str_min(&self.text, 1);
            cx.str_max(&self.text, 500);
        });
        cx.at("why", |cx| {
            if let Some(v) = &self.why {
                cx.str_max(v, 300);
            }
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum UserMemorySuggestRequestScope {
    Global,
    Project,
}

impl Validate for UserMemorySuggestRequestScope {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UserMemorySuggestResponse {
    pub memory: UserMemory,
    pub duplicate: bool,
    pub declined: bool,
}

impl Validate for UserMemorySuggestResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("memory", |cx| self.memory.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UserMemoryChangeEvent {
    pub id: UserMemoryId,
    pub action: UserMemoryChangeEventAction,
    pub status: UserMemoryStatus,
    pub by: UserMemoryChangeEventBy,
}

impl Validate for UserMemoryChangeEvent {
    fn validate(&self, cx: &mut Issues) {
        cx.at("id", |cx| self.id.validate(cx));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum UserMemoryChangeEventAction {
    Created,
    Updated,
    Approved,
    Dismissed,
    Deleted,
}

impl Validate for UserMemoryChangeEventAction {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum UserMemoryChangeEventBy {
    User,
    Agent,
    Dream,
    Sync,
}

impl Validate for UserMemoryChangeEventBy {}
