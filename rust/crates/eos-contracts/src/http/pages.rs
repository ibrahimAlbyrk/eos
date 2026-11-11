//! Port of `contracts/src/http.ts` (pages).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::primitives::{Num, de};
use crate::validate::{Issues, Validate, re};

pub const PAGE_TITLE_MAX: i64 = 200;

pub const PAGE_BODY_MAX: i64 = 524288;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct PageId(pub String);

impl Validate for PageId {
    fn validate(&self, cx: &mut Issues) {
        cx.regex(&self.0, re!(r"^pg-[a-z0-9]{8,32}$"), Some("invalid page id"));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PageAuthor {
    pub kind: PageAuthorKind,
    #[serde(deserialize_with = "de::required")]
    pub agent_id: Option<String>,
    #[serde(deserialize_with = "de::required")]
    pub name: Option<String>,
}

impl Validate for PageAuthor {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum PageAuthorKind {
    User,
    Agent,
}

impl Validate for PageAuthorKind {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub id: PageId,
    pub title: String,
    pub body: String,
    #[serde(deserialize_with = "de::required")]
    pub project: Option<String>,
    #[serde(deserialize_with = "de::required")]
    pub agent_id: Option<String>,
    pub rev: i64,
    pub created_at: Num,
    pub updated_at: Num,
    pub updated_by: PageAuthor,
}

impl Validate for Page {
    fn validate(&self, cx: &mut Issues) {
        cx.at("id", |cx| self.id.validate(cx));
        cx.at("title", |cx| cx.str_max(&self.title, 200));
        cx.at("body", |cx| cx.str_max(&self.body, 524288));
        cx.at("rev", |cx| cx.int_min(self.rev, 0, true));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PageSummary {
    pub id: PageId,
    pub title: String,
    #[serde(deserialize_with = "de::required")]
    pub project: Option<String>,
    #[serde(deserialize_with = "de::required")]
    pub agent_id: Option<String>,
    pub rev: i64,
    pub created_at: Num,
    pub updated_at: Num,
    pub updated_by: PageAuthor,
    pub excerpt: String,
    pub tasks: PageSummaryTasks,
}

impl Validate for PageSummary {
    fn validate(&self, cx: &mut Issues) {
        cx.at("id", |cx| self.id.validate(cx));
        cx.at("title", |cx| cx.str_max(&self.title, 200));
        cx.at("rev", |cx| cx.int_min(self.rev, 0, true));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PageSummaryTasks {
    pub open: i64,
    pub done: i64,
}

impl Validate for PageSummaryTasks {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PageListResponse {
    pub pages: Vec<PageSummary>,
}

impl Validate for PageListResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("pages", |cx| self.pages.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PageResponse {
    pub page: Page,
}

impl Validate for PageResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("page", |cx| self.page.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PageCreateRequest {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub project: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
    pub agent_id: Option<Option<String>>,
}

impl Validate for PageCreateRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("title", |cx| cx.str_max(&self.title, 200));
        cx.at("body", |cx| cx.str_max(&self.body, 524288));
        cx.at("project", |cx| {
            if let Some(Some(v)) = &self.project {
                cx.str_min(v, 1);
            }
        });
        cx.at("agentId", |cx| {
            if let Some(Some(v)) = &self.agent_id {
                cx.str_min(v, 1);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PageUpdateRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_rev: Option<i64>,
}

impl Validate for PageUpdateRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("title", |cx| {
            if let Some(v) = &self.title {
                cx.str_max(v, 200);
            }
        });
        cx.at("body", |cx| {
            if let Some(v) = &self.body {
                cx.str_max(v, 524288);
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
#[serde(tag = "op", rename_all = "camelCase")]
pub enum PageEditRequest {
    Append(PageEditRequestAppend),
    Replace(PageEditRequestReplace),
    SetTask(PageEditRequestSetTask),
}

impl Validate for PageEditRequest {
    fn validate(&self, cx: &mut Issues) {
        match self {
            Self::Append(v) => v.validate(cx),
            Self::Replace(v) => v.validate(cx),
            Self::SetTask(v) => v.validate(cx),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PageEditRequestAppend {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::trimmed_opt")]
    pub heading: Option<String>,
}

impl Validate for PageEditRequestAppend {
    fn validate(&self, cx: &mut Issues) {
        cx.at("text", |cx| {
            cx.str_min(&self.text, 1);
            cx.str_max(&self.text, 524288);
        });
        cx.at("heading", |cx| {
            if let Some(v) = &self.heading {
                cx.str_min(v, 1);
                cx.str_max(v, 200);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PageEditRequestReplace {
    pub old_text: String,
    pub new_text: String,
}

impl Validate for PageEditRequestReplace {
    fn validate(&self, cx: &mut Issues) {
        cx.at("oldText", |cx| {
            cx.str_min(&self.old_text, 1);
            cx.str_max(&self.old_text, 524288);
        });
        cx.at("newText", |cx| cx.str_max(&self.new_text, 524288));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PageEditRequestSetTask {
    #[serde(deserialize_with = "de::trimmed")]
    pub task: String,
    pub done: bool,
}

impl Validate for PageEditRequestSetTask {
    fn validate(&self, cx: &mut Issues) {
        cx.at("task", |cx| {
            cx.str_min(&self.task, 1);
            cx.str_max(&self.task, 500);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PageChangeEvent {
    pub id: PageId,
    pub action: PageChangeEventAction,
    pub rev: i64,
    #[serde(deserialize_with = "de::required")]
    pub project: Option<String>,
    pub by: PageAuthor,
}

impl Validate for PageChangeEvent {
    fn validate(&self, cx: &mut Issues) {
        cx.at("id", |cx| self.id.validate(cx));
        cx.at("rev", |cx| cx.int_min(self.rev, 0, true));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum PageChangeEventAction {
    Created,
    Updated,
    Deleted,
}

impl Validate for PageChangeEventAction {}
