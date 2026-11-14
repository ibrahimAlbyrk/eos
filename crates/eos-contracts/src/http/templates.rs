//! Wire types of the templates routes.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::validate::{Issues, Validate, re};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct TemplateName(pub String);

impl Validate for TemplateName {
    fn validate(&self, cx: &mut Issues) {
        cx.str_min(&self.0, 1);
        cx.str_max(&self.0, 64);
        cx.regex(&self.0, re!(r"^[a-z0-9][a-z0-9-]*$"), Some("lowercase letters, digits and dashes only"));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TemplateAttachment {
    pub label: String,
    pub kind: TemplateAttachmentKind,
    pub path: String,
}

impl Validate for TemplateAttachment {
    fn validate(&self, cx: &mut Issues) {
        cx.at("label", |cx| cx.str_min(&self.label, 1));
        cx.at("path", |cx| cx.str_min(&self.path, 1));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum TemplateAttachmentKind {
    Image,
    File,
    Folder,
}

impl Validate for TemplateAttachmentKind {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Template {
    pub name: TemplateName,
    pub description: String,
    pub content: String,
    #[serde(default)]
    pub attachments: Vec<TemplateAttachment>,
}

impl Validate for Template {
    fn validate(&self, cx: &mut Issues) {
        cx.at("name", |cx| self.name.validate(cx));
        cx.at("attachments", |cx| self.attachments.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TemplateListResponse {
    pub templates: Vec<Template>,
}

impl Validate for TemplateListResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("templates", |cx| self.templates.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TemplateCreateRequest {
    pub name: TemplateName,
    #[serde(default)]
    pub description: String,
    pub content: String,
    #[serde(default)]
    pub attachments: Vec<TemplateAttachment>,
}

impl Validate for TemplateCreateRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("name", |cx| self.name.validate(cx));
        cx.at("content", |cx| cx.str_min(&self.content, 1));
        cx.at("attachments", |cx| self.attachments.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TemplateUpdateRequest {
    #[serde(default)]
    pub description: String,
    pub content: String,
    #[serde(default)]
    pub attachments: Vec<TemplateAttachment>,
}

impl Validate for TemplateUpdateRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("content", |cx| cx.str_min(&self.content, 1));
        cx.at("attachments", |cx| self.attachments.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TemplateMutationResponse {
    pub ok: bool,
}

impl Validate for TemplateMutationResponse {}
