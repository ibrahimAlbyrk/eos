//! What the routine routes answer and `routine:change` carries.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{RoutineKind, RoutineOption, Takes};
use crate::freedom::Rung;
use crate::primitives::Num;
use crate::validate::Validate;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum RoutineState {
    /// Being made: only trials run.
    Draft,
    Active,
    /// Its triggers are off; hand runs still start.
    Paused,
    /// Paused for good and hidden; it can come back.
    Archived,
    /// In Recently deleted.
    Deleted,
    /// A one-off that was not kept.
    Transient,
}

impl Validate for RoutineState {}

/// A row of `GET /api/routines`, and the row `routine:change` carries.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoutineSummary {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub summary: String,
    pub icon: String,
    pub aliases: Vec<String>,
    pub kind: RoutineKind,
    pub state: RoutineState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused_reason: Option<String>,
    /// How far its results go without the user.
    pub rung: Rung,
    /// When it runs, in words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger_line: Option<String>,
    pub takes: RoutineTakes,
    /// The options the run form shows inline.
    pub options: Vec<RoutineOption>,
    /// What a run usually costs and takes; absent while nothing tells.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usual: Option<UsualCost>,
    /// Runs in the last seven days.
    pub runs7d: i64,
    pub active_runs: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run: Option<RunSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stats: Option<RoutineStats>,
}

impl Validate for RoutineSummary {}

/// The blueprint's Takes, with the patterns that recognise one of its items.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoutineTakes {
    #[serde(flatten)]
    pub takes: Takes,
    /// JavaScript regular expressions over a link or a text.
    #[serde(default)]
    pub item_patterns: Vec<String>,
}

impl Validate for RoutineTakes {}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UsualCost {
    pub usd: Num,
    pub ms: i64,
}

impl Validate for UsualCost {}

/// Shares run from 0 to 1.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoutineStats {
    /// The share of the last seven days' results sent without edits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent_unedited7d: Option<Num>,
    /// The same share over the first full week after the routine started.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline_first_week: Option<Num>,
    pub runs7d: i64,
    pub cost7d: Num,
    /// What making and changing the routine cost.
    pub setup_usd: Num,
}

impl Validate for RoutineStats {}

/// `GET /api/routines/{id}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RoutineDetail {
    pub routine: RoutineSummary,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<RoutineVersion>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draft: Option<RoutineDraft>,
    /// The most recent runs, newest first.
    pub runs: Vec<RunSummary>,
}

impl Validate for RoutineDetail {}

/// A draft the architect works on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoutineDraft {
    pub purpose: String,
    pub status: DraftStatus,
    /// The one question the architect waits on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_version_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draft_version_id: Option<String>,
    pub updated_at: i64,
}

impl Validate for RoutineDraft {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum DraftStatus {
    Working,
    Asking,
    Trying,
    Ready,
    Abandoned,
}

impl Validate for DraftStatus {}

/// A row of `GET /api/routines/{id}/versions`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoutineVersionRow {
    pub id: String,
    /// The version's place among the routine's versions by `createdAt`, from 1.
    pub number: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub status: VersionStatus,
    pub author: VersionAuthor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub format: i64,
    /// False for a format newer than this app knows: shown, never run or
    /// edited here.
    pub runnable: bool,
    pub created_at: i64,
}

impl Validate for RoutineVersionRow {}

/// `GET /api/routines/{id}/versions/{versionId}`, and a routine's head.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RoutineVersion {
    #[serde(flatten)]
    pub row: RoutineVersionRow,
    pub hash: String,
    /// The blueprint as the version stores it, whatever its format.
    pub blueprint: Value,
}

impl Validate for RoutineVersion {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum VersionStatus {
    Draft,
    Kept,
    Discarded,
}

impl Validate for VersionStatus {}

/// Who made a version.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum VersionAuthor {
    User,
    Architect,
    /// Eos itself, as when an option's default follows the user.
    Eos,
    Restore,
    Sync,
    Once,
}

impl Validate for VersionAuthor {}

/// One run in a routine's history.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub id: String,
    pub routine_id: String,
    /// `standing`, `project`, `once`, `trial`, `design`, `app-build` or `ask`.
    pub kind: String,
    /// What started it: `hand`, `trigger`, `routine`, `agent`, `again`,
    /// `trial`, `replay` or `surface`.
    pub origin: String,
    /// `queued`, `running`, `checking`, `waiting_for_user`, `delivering`,
    /// `done`, `skipped`, `cancelled`, `paused` or `failed`.
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub station: Option<String>,
    /// Why it failed, was skipped, cancelled or paused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headline: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_title: Option<String>,
    pub needs_user: bool,
    pub cost_usd: Num,
    pub work_ms: i64,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    /// A project run's milestones the gate is done with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub milestones_done: Option<i64>,
}

impl Validate for RunSummary {}

/// `routine:change`: the row as it is now; none when the routine was deleted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoutineChange {
    pub routine_id: String,
    pub reason: RoutineChangeReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row: Option<RoutineSummary>,
}

impl Validate for RoutineChange {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum RoutineChangeReason {
    Created,
    /// A new head version.
    Version,
    State,
    Draft,
    Deleted,
    Stats,
}

impl Validate for RoutineChangeReason {}
