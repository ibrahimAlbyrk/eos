//! What the surface and direct-action routes take and answer, and what
//! `surfaces:change`, `surfaces:issue`, `surfaces:state` and `actions:record`
//! carry. Levels, places, roles and statuses travel as the words
//! `eos_surface` stores. Titles, issue bodies, state and action arguments
//! and results are the user's: these types are never logged.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::freedom::ActionClass;
use crate::validate::{Issues, Validate};

/// A row of `GET /api/surfaces`: one interface a routine answers with.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceRow {
    pub id: String,
    pub routine_id: String,
    /// `view`, `page` or `app`.
    pub level: String,
    /// `routine_page`, `needs_you`, `side_panel` or `tool`.
    pub place: String,
    /// `result`, `decisions`, `page` or `app`.
    pub role: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_version: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_version: Option<i64>,
    /// The problem paths that made Eos fall back, while a redesign is due.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub needs_redesign: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Validate for SurfaceRow {}

/// `GET /api/surfaces`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SurfaceList {
    pub surfaces: Vec<SurfaceRow>,
}

impl Validate for SurfaceList {}

/// A row of `GET /api/surfaces/{id}/versions`: one design, without its body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceVersionMeta {
    pub version: i64,
    /// `checking`, `candidate`, `kept`, `discarded` or `superseded`.
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_version: Option<i64>,
    /// `designer`, `user`, `arrange`, `restore` or `builder`.
    pub made_by: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// The maker's one-line summary of the change.
    pub note: String,
    pub body_bytes: i64,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kept_at: Option<i64>,
}

impl Validate for SurfaceVersionMeta {}

/// `GET /api/surfaces/{id}/versions`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SurfaceVersionList {
    pub versions: Vec<SurfaceVersionMeta>,
}

impl Validate for SurfaceVersionList {}

/// `GET /api/surfaces/{id}/versions/{n}`: one design with its body and the
/// report of its checks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SurfaceVersion {
    pub meta: SurfaceVersionMeta,
    pub body: Value,
    pub checks: Value,
}

impl Validate for SurfaceVersion {}

/// A row of `GET /api/surfaces/{id}/issues`: one answer of a run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceIssueRow {
    pub id: String,
    pub surface_id: String,
    /// The issue's number; a trial issue has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// The design version it was made with; a View has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<i64>,
    /// `page`, `view` or `fallback`.
    pub kind: String,
    /// `preparing`, `ready` or `failed`.
    pub status: String,
    pub rev: i64,
    pub trial: bool,
    pub kept: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Validate for SurfaceIssueRow {}

/// `GET /api/surfaces/{id}/issues?before=&limit=`, newest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SurfaceIssueList {
    pub issues: Vec<SurfaceIssueRow>,
    /// Older issues exist past the last one.
    pub more: bool,
}

impl Validate for SurfaceIssueList {}

/// `GET /api/surfaces/{id}/issues/{issueId}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SurfaceIssue {
    pub issue: SurfaceIssueRow,
    /// A View: `{view, actions}`, the View as `present` takes it and the ids of
    /// its bound actions. A Page: its data.
    pub body: Value,
}

impl Validate for SurfaceIssue {}

/// `GET /api/surfaces/{id}/state?scope=` and the body of its `PUT`: a
/// surface's small saved state, for the whole surface (`scope` empty) or one
/// issue (its id).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceStateDoc {
    #[serde(default)]
    pub scope: String,
    pub data: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
}

impl Validate for SurfaceStateDoc {}

/// `PUT /api/surfaces/{id}/issues/{issueId}/fields`: one edit in place of a
/// page issue's data, made on revision `baseRev`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IssueFieldEdit {
    pub base_rev: i64,
    /// `set` (a text field), `move` (a list item from `from` to `to`) or
    /// `remove` (the list item at `from`).
    pub op: String,
    /// The dotted path: `lead.title`, `stories.2.title`, `stories`.
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<usize>,
}

impl Validate for IssueFieldEdit {
    fn validate(&self, issues: &mut Issues) {
        if !matches!(self.op.as_str(), "set" | "move" | "remove") {
            issues.push_at("op", "must be set, move or remove");
        }
    }
}

/// A part of a page read, and the repeat's index it was in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PartRead {
    pub part: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<u32>,
}

/// `POST /api/surfaces/{id}/issues/{issueId}/read`: what the reader opened
/// on a page, in order: parts, and the parts whose links they followed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IssueReadReport {
    #[serde(default)]
    pub parts: Vec<PartRead>,
    #[serde(default)]
    pub links: Vec<PartRead>,
}

impl Validate for IssueReadReport {}

/// `GET /api/surfaces/{id}/queries/{queryId}?args=`: one named query's
/// answer, as a surface of its routine reads it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceQueryAnswer {
    pub query_id: String,
    pub answer: Value,
    /// The topics whose events may change the answer.
    pub topics: Vec<String>,
}

impl Validate for SurfaceQueryAnswer {}

/// `GET /api/surfaces/{id}/issues/{issueId}/parts/{part}`: a Live part drawn
/// with its query's answer, for the frame to swap in.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LivePartDoc {
    pub part: String,
    pub html: String,
    /// False when the query failed and `html` is the last answer drawn.
    pub current: bool,
    /// The topics whose events may change the part.
    pub topics: Vec<String>,
}

impl Validate for LivePartDoc {}

/// `GET`/`PUT /api/surfaces/pins`: the surfaces pinned on this Mac's Home,
/// in slot order, at most three.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PinsBody {
    pub surface_ids: Vec<String>,
}

impl Validate for PinsBody {}

/// One pinned surface as Home's tile shows it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Tile {
    /// 1 to 3.
    pub slot: u8,
    pub surface_id: String,
    pub routine_id: String,
    /// `view`, `page` or `app`.
    pub level: String,
    pub title: String,
    /// The design's tile headline, or a View's title; none for the default tile.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headline: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// A direct action the tile's button runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    /// The newest ready issue the tile reads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issued_at: Option<i64>,
    /// The owner routine's `routine.status` answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<Value>,
}

/// `GET /api/surfaces/tiles`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TileList {
    pub tiles: Vec<Tile>,
}

impl Validate for TileList {}

/// `GET`/`PUT /api/settings/surfaces`: how surfaces read on this Mac.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceSettings {
    /// 100, 115 or 130 (percent).
    pub text_scale: u16,
    /// `normal` or `more`.
    pub contrast: String,
    /// Every issue in Eos's own plain look.
    pub plain: bool,
}

impl Default for SurfaceSettings {
    fn default() -> Self {
        SurfaceSettings { text_scale: 100, contrast: "normal".into(), plain: false }
    }
}

impl Validate for SurfaceSettings {
    fn validate(&self, cx: &mut Issues) {
        if ![100, 115, 130].contains(&self.text_scale) {
            cx.push_at("textScale", "must be 100, 115 or 130");
        }
        if !matches!(self.contrast.as_str(), "normal" | "more") {
            cx.push_at("contrast", "must be normal or more");
        }
    }
}

/// A row of `GET /api/actions`: one direct action a surface may run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ActionDefRow {
    /// `routine.run_again`.
    pub id: String,
    pub title: String,
    pub class: ActionClass,
    /// `owner_routine` (only a surface of the routine it acts on) or `any`.
    pub scope: String,
    /// The argument type in the surface type language.
    pub args: Value,
}

impl Validate for ActionDefRow {}

/// `GET /api/actions`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ActionList {
    pub actions: Vec<ActionDefRow>,
}

impl Validate for ActionList {}

/// `POST /api/actions/run`. There is no field for arguments: the core reads
/// them from the stored issue, so a frame cannot pass its own. What the user
/// typed or chose comes as `state` and is typed against the action's
/// argument type.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ActionRunRequest {
    /// The issue whose button was pressed. Without it, `actionId` names a
    /// registry action that takes no arguments of the issue.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_id: Option<String>,
    /// A Page's button, by its part.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub button: Option<String>,
    /// A View's action id with an issue; a registry action id without one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_id: Option<String>,
    /// The item of a repeat the button sits in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<u32>,
    /// The `id` of the row the button sits in, when its rows have ids: it
    /// picks the row the core holds, never a value of the frame's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<Value>,
    /// Chosen by the caller; a repeated id answers the first record.
    pub client_id: String,
    /// The token of Eos's own confirmation, when it asked for one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm: Option<String>,
    /// What the user typed in that confirmation, for an action that cannot
    /// be taken back: its name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub typed: Option<String>,
}

impl Validate for ActionRunRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("clientId", |cx| {
            cx.str_min(self.client_id.trim(), 1);
            cx.str_max(&self.client_id, 128);
        });
        if self.action_id.is_none() && self.button.is_none() {
            cx.push_at("actionId", "actionId or button is required");
        }
        if self.button.is_some() && self.issue_id.is_none() {
            cx.push_at("issueId", "is required with a button");
        }
    }
}

/// What `POST /api/actions/run` answers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ActionAnswer {
    #[serde(rename_all = "camelCase")]
    Done {
        record_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
    },
    /// Eos asks the user in its own dialog, outside the frame, and repeats the
    /// call with `token` (single use, two minutes).
    #[serde(rename_all = "camelCase")]
    Confirm {
        record_id: String,
        token: String,
        prompt: String,
        /// The name the user types before the repeat goes, for an action
        /// that cannot be taken back.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        type_to_confirm: Option<String>,
    },
    /// Held in Needs you as the item named.
    #[serde(rename_all = "camelCase")]
    Held { record_id: String, item_id: String },
    #[serde(rename_all = "camelCase")]
    Refused {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        record_id: Option<String>,
        reason: String,
    },
}

impl Validate for ActionAnswer {}

/// `GET /api/actions/records/{id}`: one press of a button, as Eos ran it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ActionRecord {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    pub action_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routine_id: Option<String>,
    /// `dashboard`, `phone`, `mail_link` or `app`.
    pub origin: String,
    pub class: ActionClass,
    /// The arguments as the core typed them.
    pub args: Value,
    /// `run`, `confirm`, `hold` or `refuse`.
    pub decision: String,
    /// `running`, `done`, `failed`, `confirming`, `held` or `refused`.
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
}

impl Validate for ActionRecord {}

/// `surfaces:change`: a surface was made, renamed, archived or restored, or
/// its versions moved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SurfacesChange {
    pub surface_id: String,
    pub routine_id: String,
    /// `created`, `version`, `archived`, `restored` or `redesign`.
    pub what: String,
}

impl Validate for SurfacesChange {}

/// `surfaces:issue`: an issue was stored or moved on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SurfacesIssue {
    pub surface_id: String,
    pub issue_id: String,
    pub status: String,
    pub rev: i64,
}

impl Validate for SurfacesIssue {}

/// `surfaces:state`: a surface's saved state changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SurfacesState {
    pub surface_id: String,
    pub scope: String,
}

impl Validate for SurfacesState {}

/// `surfaces:pins`: the pins on Home changed.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SurfacesPins {}

impl Validate for SurfacesPins {}

/// `POST /api/surfaces/{id}/reshape`: what the user said, about the part
/// they pointed at, from the version they saw.
/// `POST /api/surfaces/{id}/issues/{issueId}/pdf`: the paper, A4 when left
/// out.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PdfRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paper: Option<String>,
}

impl Validate for PdfRequest {}

/// Where the PDF of an issue was written, and its size.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PdfExport {
    pub path: String,
    pub bytes: u64,
}

impl Validate for PdfExport {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReshapeRequest {
    pub base_version: i64,
    pub instruction: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub part: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<u32>,
}

impl Validate for ReshapeRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("instruction", |cx| cx.str_max(&self.instruction, 2_000));
    }
}

/// The design run a reshape started.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReshapeStarted {
    pub run_id: String,
}

impl Validate for ReshapeStarted {}

/// `POST /api/surfaces/{id}/arrange`: the popover's Remove, Move up or
/// Move down on the part pointed at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ArrangeRequest {
    pub base_version: i64,
    pub part: String,
    /// `remove`, `move_up` or `move_down`.
    pub op: String,
}

impl Validate for ArrangeRequest {}

/// `surfaces:design`: a design version moved through its checks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SurfacesDesign {
    pub surface_id: String,
    pub version: i64,
    /// `checking`, `waiting` (for Eos's window), `candidate` or `failed`.
    pub phase: String,
}

impl Validate for SurfacesDesign {}

/// `actions:record`: a press was recorded or finished.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ActionsRecord {
    pub record_id: String,
    pub action_id: String,
    pub status: String,
}

impl Validate for ActionsRecord {}

#[cfg(test)]
mod tests;
