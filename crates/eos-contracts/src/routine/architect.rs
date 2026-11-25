//! Making and changing a routine by talking to its architect.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::{DraftStatus, RunSummary};
use crate::freedom::Rung;
use crate::validate::{Issues, Validate};

/// The longest sentence or message the user sends the architect.
const TEXT_MAX: usize = 8000;

fn text(cx: &mut Issues, key: &str, value: &str) {
    cx.at(key, |cx| {
        cx.str_min(value.trim(), 1);
        cx.str_max(value, TEXT_MAX);
    });
}

/// The longest project folder and model name the Home input's pills send.
const PROJECT_MAX: usize = 4096;
const MODEL_MAX: usize = 64;

/// The project and model the Home input's pills chose: a folder, and a
/// model name made of letters, digits, `.`, `-` and `_`.
pub(crate) fn home_choices(cx: &mut Issues, project: Option<&str>, model: Option<&str>) {
    if let Some(project) = project {
        cx.at("project", |cx| {
            cx.str_min(project.trim(), 1);
            cx.str_max(project, PROJECT_MAX);
        });
    }
    if let Some(model) = model {
        cx.at("model", |cx| {
            cx.str_min(model, 1);
            cx.str_max(model, MODEL_MAX);
            if !model.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')) {
                cx.push("Invalid model name");
            }
        });
    }
}

/// `POST /api/routines/architect`: a routine made from what the user wants.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ArchitectRequest {
    pub sentence: String,
    /// Paths of the files the user gave with it.
    #[serde(default)]
    pub attachments: Vec<String>,
    /// The rung the routine starts at; Draft when absent. Home offers no
    /// more than Draft: more freedom is the blueprint's Freedom row, which
    /// asks first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rung: Option<Rung>,
    /// The project folder the routine works on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// The model its architect's session runs at; the user's default when
    /// absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

impl Validate for ArchitectRequest {
    fn validate(&self, cx: &mut Issues) {
        text(cx, "sentence", &self.sentence);
        cx.at("attachments", |cx| cx.arr_max(self.attachments.len(), 20));
        if self.rung.is_some_and(|rung| rung > Rung::Draft) {
            cx.push_at("rung", "Home starts a routine at Draft at most");
        }
        home_choices(cx, self.project.as_deref(), self.model.as_deref());
    }
}

/// `POST /api/routines/:id/start`: the draft kept as the routine's head.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StartRoutineRequest {
    /// The user pressed "Start without a trial".
    #[serde(default)]
    pub without_trial: bool,
}

impl Validate for StartRoutineRequest {}

/// `POST /api/routines/:id/change`: what the user wants changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChangeRequest {
    pub text: String,
}

impl Validate for ChangeRequest {
    fn validate(&self, cx: &mut Issues) {
        text(cx, "text", &self.text);
    }
}

/// `POST /api/routines/:id/draft/message`: a message, or the choice that
/// answers the architect's question; exactly one of them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DraftMessage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choice: Option<String>,
}

impl Validate for DraftMessage {
    fn validate(&self, cx: &mut Issues) {
        match (&self.text, &self.choice) {
            (Some(value), None) => text(cx, "text", value),
            (None, Some(value)) => text(cx, "choice", value),
            _ => cx.push("one of text and choice"),
        }
    }
}

/// `GET /api/routines/:id/draft`: what the architect works on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DraftView {
    pub purpose: String,
    pub status: DraftStatus,
    /// The one question the architect waits on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    /// The answers it offers to that question.
    pub choices: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_version_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draft_version_id: Option<String>,
    /// The trial runs of the draft version, newest first.
    pub trial_runs: Vec<RunSummary>,
    /// The worker id of the draft's architect session, whose messages
    /// `GET /workers/:id/events` reads; absent while no architect works on
    /// the draft.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub architect_id: Option<String>,
    /// The blueprint's slots the draft changes from the head, in blueprint
    /// order; every slot while the routine has no head.
    pub changed: Vec<String>,
    pub updated_at: i64,
}

impl Validate for DraftView {}
