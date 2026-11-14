//! Wire types of the questions routes.

use indexmap::IndexMap;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::primitives::de;
use crate::validate::{Issues, Validate};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct QuestionOption {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

impl Validate for QuestionOption {
    fn validate(&self, cx: &mut Issues) {
        cx.at("label", |cx| cx.str_min(&self.label, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub question: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multi_select: Option<bool>,
    pub options: Vec<QuestionOption>,
}

impl Validate for Question {
    fn validate(&self, cx: &mut Issues) {
        cx.at("question", |cx| cx.str_min(&self.question, 1));
        cx.at("options", |cx| {
            cx.arr_min(self.options.len(), 1);
            cx.arr_max(self.options.len(), 8);
            self.options.validate(cx);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QuestionRequest {
    pub questions: Vec<Question>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub tool_use_id: Option<Option<String>>,
}

impl Validate for QuestionRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("questions", |cx| {
            cx.arr_min(self.questions.len(), 1);
            cx.arr_max(self.questions.len(), 4);
            self.questions.validate(cx);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QuestionRegisterResponse {
    pub question_id: String,
    pub tool_use_id: String,
}

impl Validate for QuestionRegisterResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct QuestionPollResponse {
    pub status: QuestionPollResponseStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answers: Option<IndexMap<String, String>>,
}

impl Validate for QuestionPollResponse {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum QuestionPollResponseStatus {
    Pending,
    Answered,
    Dismissed,
    Gone,
}

impl Validate for QuestionPollResponseStatus {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QuestionAnswerRequest {
    pub tool_use_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answers: Option<IndexMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dismissed: Option<bool>,
}

impl Validate for QuestionAnswerRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PeerListItem {
    pub id: String,
    #[serde(deserialize_with = "de::required")]
    pub name: Option<String>,
    pub state: String,
    pub summary: String,
}

impl Validate for PeerListItem {}

pub type PeerListResponse = Vec<PeerListItem>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PeerRef {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl Validate for PeerRef {
    fn validate(&self, cx: &mut Issues) {
        cx.at("id", |cx| {
            if let Some(v) = &self.id {
                cx.str_min(v, 1);
            }
        });
        cx.at("name", |cx| {
            if let Some(v) = &self.name {
                cx.str_min(v, 1);
            }
        });
        if self.id.is_some() == self.name.is_some() {
            cx.push("peer target must carry exactly one of { id, name }");
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PeerRequestRegisterRequest {
    pub target: PeerRef,
    pub question: String,
}

impl Validate for PeerRequestRegisterRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("target", |cx| self.target.validate(cx));
        cx.at("question", |cx| cx.str_min(&self.question, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PeerRequestRegisterResponse {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub declined: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl Validate for PeerRequestRegisterResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PeerRequestPollResponse {
    pub status: PeerRequestPollResponseStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl Validate for PeerRequestPollResponse {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum PeerRequestPollResponseStatus {
    Pending,
    Answered,
    Declined,
    Gone,
}

impl Validate for PeerRequestPollResponseStatus {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PeerResponseRequest {
    pub answer: String,
}

impl Validate for PeerResponseRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("answer", |cx| cx.str_min(&self.answer, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PeerResponseResult {
    pub ok: bool,
    pub outcome: PeerResponseResultOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_worker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub to_name: Option<Option<String>>,
}

impl Validate for PeerResponseResult {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum PeerResponseResultOutcome {
    Answered,
    None,
}

impl Validate for PeerResponseResultOutcome {}
