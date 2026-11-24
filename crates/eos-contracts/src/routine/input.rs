//! What one run is given: its item or items, option values, note and
//! result mode.

use indexmap::IndexMap;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::validate::{Issues, Validate};

/// The longest note one run takes, in characters.
pub const RUN_NOTE_MAX_CHARS: usize = 4_000;

/// The longest text one item carries, in bytes.
pub const ITEM_TEXT_MAX_BYTES: usize = 64 * 1024;

/// What one run is given.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item: Option<ItemRef>,
    /// The items of a batch, which one run takes together.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items: Option<Vec<ItemRef>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger: Option<RunTrigger>,
    /// Option values by key; an option left out takes its default.
    #[serde(default)]
    pub options: IndexMap<String, Value>,
    /// An instruction for this run only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub result: ResultMode,
    /// Not before this time (epoch ms).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
    /// What a run for one of the routine's surfaces is asked (01 G51); only
    /// surfaces start such a run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface: Option<SurfaceRunInput>,
    /// The Agents chat the run was started from: it is told when the run's
    /// result is ready and when the run ends.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat: Option<String>,
}

/// The kinds of run a routine's surface starts (01 G51).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum SurfaceRunKind {
    /// The designer makes or reshapes a page.
    Design,
    /// A builder team makes an App.
    AppBuild,
    /// One focused session answers about an item of an issue.
    Ask,
}

impl SurfaceRunKind {
    /// The word `runs.kind` stores.
    pub fn word(self) -> &'static str {
        match self {
            SurfaceRunKind::Design => "design",
            SurfaceRunKind::AppBuild => "app-build",
            SurfaceRunKind::Ask => "ask",
        }
    }

    /// Whether `kind` is one of a surface's runs.
    pub fn is_surface_word(kind: &str) -> bool {
        matches!(kind, "design" | "app-build" | "ask")
    }
}

/// A surface's run: which surface, from which of its versions, what the
/// user said and the part (and item) they pointed at.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceRunInput {
    pub kind: SurfaceRunKind,
    pub surface_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_version: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instruction: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub part: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<u32>,
    /// The issue an Ask was pressed on, and the row it sits in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item: Option<Value>,
}

impl Validate for RunInput {
    fn validate(&self, cx: &mut Issues) {
        cx.at("item", |cx| self.item.validate(cx));
        cx.at("items", |cx| self.items.validate(cx));
        if let Some(note) = &self.note {
            cx.at("note", |cx| cx.str_max(note, RUN_NOTE_MAX_CHARS));
        }
        if let Some(instruction) = self.surface.as_ref().and_then(|surface| surface.instruction.as_ref()) {
            cx.at("surface.instruction", |cx| cx.str_max(instruction, RUN_NOTE_MAX_CHARS));
        }
    }
}

/// The signal that started a run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunTrigger {
    pub signal_id: String,
    /// The schedule slot it stands for (epoch ms).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub late_by_ms: Option<i64>,
}

impl Validate for RunTrigger {}

/// Where a run's result goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ResultMode {
    /// As the routine's Freedom says.
    Usual,
    /// Held for the user whatever the Freedom says.
    Ask,
    /// Shown in Eos and sent nowhere.
    ShowOnly,
}

impl Validate for ResultMode {}

/// The thing a run works on: something from a source, a link, a file or
/// folder, a text, a day or a range of days.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ItemRef {
    pub kind: String,
    /// What makes two items the same item (`github:pr:acme/game#482@<sha>`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// A day, `YYYY-MM-DD`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<DateRange>,
    /// The item's version (a pull request's head commit).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// It came from outside the user's own text and files. Required: an item
    /// that does not say is never taken for the user's own.
    pub untrusted: bool,
}

impl Validate for ItemRef {
    fn validate(&self, cx: &mut Issues) {
        if self.text.as_ref().is_some_and(|text| text.len() > ITEM_TEXT_MAX_BYTES) {
            cx.push_at("text", "Text must be at most 64 KiB");
        }
    }
}

/// Days from `from` to `to`, both included, `YYYY-MM-DD`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct DateRange {
    pub from: String,
    pub to: String,
}

impl Validate for DateRange {}
