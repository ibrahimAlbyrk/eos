//! What the Home input asks for (`POST /api/routines/intent`, and its
//! model read), and which routines take a thing the user dropped
//! (`POST /api/routines/match-item`).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::ItemRef;
use crate::validate::{Issues, Validate};

/// The longest text the input reads.
pub const INTENT_TEXT_MAX: usize = 2_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum IntentKind {
    /// Run one routine, on an item or its latest.
    Run,
    /// Make a new routine.
    Make,
    /// Do the task once, with no routine.
    Once,
    /// Change a routine the user has.
    Change,
    /// Not sure: the alternatives are the choices.
    Unsure,
}

impl Validate for IntentKind {}

/// A thing given with the text: a link, a path, a file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct IntentAttachment {
    pub kind: String,
    pub value: String,
}

impl Validate for IntentAttachment {}

/// `POST /api/routines/intent` and `/api/routines/intent/model`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IntentRequest {
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<IntentAttachment>,
    /// A mode the user picked: it decides.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forced: Option<IntentKind>,
    /// The routine token the user picked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routine_id: Option<String>,
    /// Echoed, so the dashboard applies only its latest answer.
    pub seq: i64,
}

impl Validate for IntentRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("text", |cx| cx.str_max(&self.text, INTENT_TEXT_MAX));
        cx.at("attachments", |cx| cx.arr_max(self.attachments.len(), 20));
    }
}

/// One other reading of the text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IntentChoice {
    pub intent: IntentKind,
    pub line: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routine_id: Option<String>,
}

impl Validate for IntentChoice {}

/// What the text asks for, and the line the input shows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IntentAnswer {
    pub intent: IntentKind,
    /// Enter may act on it.
    pub certain: bool,
    pub line: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routine_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item: Option<ItemRef>,
    /// The run's option values the text names.
    pub options: Map<String, Value>,
    /// Other readings; while unsure, the choices, at most three.
    pub alternatives: Vec<IntentChoice>,
    /// `rules` or `model`.
    pub source: String,
    pub seq: i64,
}

impl Validate for IntentAnswer {}

/// `POST /api/routines/match-item`: a thing the user dropped or pasted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct MatchItemRequest {
    pub item: IntentAttachment,
}

impl Validate for MatchItemRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("item", |cx| cx.at("value", |cx| cx.str_max(&self.item.value, INTENT_TEXT_MAX)));
    }
}

/// The routines that take the thing, then "do it once".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct MatchItemAnswer {
    pub choices: Vec<IntentChoice>,
}

impl Validate for MatchItemAnswer {}
