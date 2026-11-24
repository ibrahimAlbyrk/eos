//! What memory's routes take and answer, and what `memory:change` and
//! `memory:recalled` carry. Note text is the user's: these types are never
//! logged.

use indexmap::IndexMap;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::validate::Validate;

/// `memory:change`: notes were learned, changed or forgotten, or only their
/// counts moved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceChange {
    pub ids: Vec<String>,
    /// `learned`, `changed`, `forgotten` or `counts`.
    pub action: String,
}

impl Validate for ExperienceChange {}

/// `memory:recalled`: notes went in front of a chat's or a run's model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceRecalledEvent {
    /// The chat's agent; none for a run's pack, given before its lead starts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub note_ids: Vec<String>,
    /// `pack`, `reminder` or `tool`.
    pub how: String,
}

impl Validate for ExperienceRecalledEvent {}

/// `GET`/`PUT /api/memory/settings`: whether Eos learns, and whether it
/// reminds agents of what it learned.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceSettings {
    pub learning: bool,
    pub reminders: bool,
}

impl Validate for ExperienceSettings {}

/// `POST /api/memory/hook`: a Code-mode pane's Claude Code hook (04 G34), as the terminal's
/// `eos memory hook` hands it on. `input` is the hook's own input, as Claude Code wrote it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceHookRequest {
    pub event: String,
    #[serde(default)]
    pub input: serde_json::Value,
}

impl Validate for ExperienceHookRequest {
    fn validate(&self, cx: &mut crate::validate::Issues) {
        cx.at("event", |cx| {
            cx.str_min(&self.event, 1);
            cx.str_max(&self.event, 64);
        });
    }
}

/// `POST /api/memory/tidy`: whether a tidying started (`false` while one
/// already works).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceTidy {
    pub started: bool,
}

impl Validate for ExperienceTidy {}

/// Where a note holds: a routine, a project, a kind of work, or everywhere.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceScope {
    /// `routine`, `project`, `work` or `everywhere`.
    pub level: String,
    /// The routine's id, the project's key, the work kind; empty for everywhere.
    pub key: String,
    /// The project's folder name or the work kind; the routine's id (the
    /// dashboard names it); empty for everywhere.
    pub label: String,
}

impl Validate for ExperienceScope {}

/// How many notes hold in one scope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceScopeCount {
    pub level: String,
    pub key: String,
    pub label: String,
    pub count: i64,
}

/// How memory runs on this Mac.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceHealth {
    /// `ready`, `loading` or `off`.
    pub embedder: String,
    pub pending_moments: i64,
    pub learning: bool,
    pub reminders: bool,
}

/// `GET /api/memory/summary`: the Memory screen's head.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceSummary {
    /// Memories kept in About you.
    pub about_you: i64,
    /// Notes learned from work, neither closed nor forgotten.
    pub learned: i64,
    /// What was learned in the last seven days (zero hides the line).
    pub weekly: i64,
    pub scopes: Vec<ExperienceScopeCount>,
    /// Live notes by kind.
    pub kinds: IndexMap<String, i64>,
    pub health: ExperienceHealth,
}

impl Validate for ExperienceSummary {}

/// A note as a list shows it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceNoteRow {
    pub id: String,
    pub kind: String,
    pub text: String,
    /// What it was learned from, in a line.
    pub why: String,
    /// The signal of what first taught it (`says_wrong`, `edits`, `command_fails`, …).
    pub source: String,
    pub state: String,
    pub trust: String,
    pub helped: i64,
    pub used: i64,
    /// How far the note is trusted, 0 to 1 (`(helped+1)/(helped+hurt+2)`, capped by trust).
    pub strength: f64,
    pub scope: ExperienceScope,
    pub rev: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forgotten_at: Option<i64>,
    pub updated_at: i64,
}

impl Validate for ExperienceNoteRow {}

/// `GET /api/memory/notes`: a page of notes, newest change first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceNoteList {
    pub notes: Vec<ExperienceNoteRow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

impl Validate for ExperienceNoteList {}

/// One thing a note was learned or confirmed from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceLearnedFrom {
    pub at: i64,
    pub text: String,
}

/// A hook a note is about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceConnection {
    pub kind: String,
    pub label: String,
}

/// When a note comes back, and what the agent then reads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceComesBack {
    pub situation: String,
    pub reminder: String,
}

/// Whether a note helped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceHelp {
    pub recalled: i64,
    pub used: i64,
    pub helped: i64,
    pub hurt: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<i64>,
}

/// One version of a note.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceVersion {
    pub rev: i64,
    pub at: i64,
    /// `learned`, `corrected`, `edited`, `merged`, `narrowed`, `restored`, `rewritten` or `closed`.
    pub why: String,
}

/// `GET /api/memory/notes/{id}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceNoteDetail {
    pub note: ExperienceNoteRow,
    pub learned_from: Vec<ExperienceLearnedFrom>,
    pub connected_to: Vec<ExperienceConnection>,
    pub next_to: Vec<ExperienceNoteRow>,
    pub comes_back_when: ExperienceComesBack,
    pub help: ExperienceHelp,
    pub versions: Vec<ExperienceVersion>,
    /// The Mac that last wrote it.
    pub device: String,
}

impl Validate for ExperienceNoteDetail {}

/// `PUT /api/memory/notes/{id}`: the user's own words or scope for a note.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceEditRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<ExperienceScopeRequest>,
    /// The note's `rev` the edit was made on: a newer one refuses it.
    pub base_rev: i64,
}

impl Validate for ExperienceEditRequest {
    fn validate(&self, cx: &mut crate::validate::Issues) {
        if let Some(text) = &self.text {
            cx.at("text", |cx| {
                cx.str_min(text.trim(), 1);
                cx.str_max(text, 280);
            });
        }
    }
}

/// A scope the user picks for a note.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceScopeRequest {
    pub level: String,
    #[serde(default)]
    pub key: String,
}

/// `POST /api/memory/notes/{id}/not-right`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NotRightRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// What the user says was wrong.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl Validate for NotRightRequest {}

/// A note that went in front of a model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceRecalledNote {
    pub row: ExperienceNoteRow,
    /// `pack`, `reminder` or `tool`.
    pub how: String,
    pub at: i64,
}

/// `GET /api/memory/recalled?workerId=&runId=`: the notes a chat or a run
/// received, first first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceRecalled {
    pub notes: Vec<ExperienceRecalledNote>,
}

impl Validate for ExperienceRecalled {}

/// Where a rule the user stated was said.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceStatedRule {
    /// An About you memory (`um-`) or a note (`mn-`).
    pub memory_id: String,
    pub worker_id: String,
    pub row_id: i64,
    pub at: i64,
}

/// `GET /api/memory/stated`: newest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceStated {
    pub rules: Vec<ExperienceStatedRule>,
}

impl Validate for ExperienceStated {}

/// `POST /api/memory/forget-all`: `{confirm: true}` forgets every note Eos
/// learned; `{undo: true}` brings back what the last one forgot, for 30 days.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ForgetAllRequest {
    #[serde(default)]
    pub confirm: bool,
    #[serde(default)]
    pub undo: bool,
}

impl Validate for ForgetAllRequest {}

/// What forgetting everything, or undoing it, did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ForgetAllAnswer {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forgotten: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restored: Option<i64>,
}

impl Validate for ForgetAllAnswer {}

/// What a note was learned or confirmed from, as an export keeps it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ExperienceExportEvidence {
    pub kind: String,
    pub summary: String,
    pub at: i64,
}

/// One live note in an export.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceExportNote {
    pub id: String,
    pub kind: String,
    pub text: String,
    pub trust: String,
    pub state: String,
    pub scope: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub evidence: Vec<ExperienceExportEvidence>,
}

/// `GET /api/memory/export`: every live note with its evidence, for the
/// user to save as one file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceExport {
    pub exported_at: i64,
    pub notes: Vec<ExperienceExportNote>,
}

impl Validate for ExperienceExport {}

#[cfg(test)]
mod tests;
