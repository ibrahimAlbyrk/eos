use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::plugin::PluginManifest;
use crate::primitives::{Num, de};
use crate::validate::{Issues, Validate, re};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PluginSource {
    Npm(PluginSourceNpm),
    Git(PluginSourceGit),
    Local(PluginSourceLocal),
}

impl Validate for PluginSource {
    fn validate(&self, cx: &mut Issues) {
        match self {
            Self::Npm(v) => v.validate(cx),
            Self::Git(v) => v.validate(cx),
            Self::Local(v) => v.validate(cx),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PluginSourceNpm {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

impl Validate for PluginSourceNpm {
    fn validate(&self, cx: &mut Issues) {
        cx.at("name", |cx| {
            cx.regex(
                &self.name,
                re!(r"^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$"),
                Some("an npm package name"),
            );
            cx.str_max(&self.name, 214);
        });
        cx.at("version", |cx| {
            if let Some(v) = &self.version {
                cx.regex(v, re!(r"^[A-Za-z0-9][A-Za-z0-9.+_-]*$"), Some("an exact version or a tag"));
                cx.str_max(v, 64);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PluginSourceGit {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<String>,
}

impl Validate for PluginSourceGit {
    fn validate(&self, cx: &mut Issues) {
        cx.at("url", |cx| {
            cx.regex(&self.url, re!(r"^https:\/\/[^\s]+$"), Some("an https:// repository URL"));
            cx.str_max(&self.url, 500);
        });
        cx.at("ref", |cx| {
            if let Some(v) = &self.r#ref {
                cx.regex(v, re!(r"^[A-Za-z0-9][A-Za-z0-9._/-]*$"), Some("a branch or tag name"));
                cx.str_max(v, 200);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PluginSourceLocal {
    pub path: String,
}

impl Validate for PluginSourceLocal {
    fn validate(&self, cx: &mut Issues) {
        cx.at("path", |cx| {
            cx.str_min(&self.path, 1);
            cx.str_max(&self.path, 1000);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallRecord {
    pub source: PluginSource,
    pub resolved: String,
    #[serde(deserialize_with = "de::required")]
    pub integrity: Option<String>,
    #[serde(deserialize_with = "de::required")]
    pub version: Option<String>,
    pub installed_at: Num,
}

impl Validate for PluginInstallRecord {
    fn validate(&self, cx: &mut Issues) {
        cx.at("source", |cx| self.source.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StagedPlugin {
    pub staging_id: String,
    pub manifest: PluginManifest,
    pub source: PluginSource,
    pub resolved: String,
    #[serde(deserialize_with = "de::required")]
    pub integrity: Option<String>,
    pub files: i64,
    pub bytes: i64,
    #[serde(deserialize_with = "de::required")]
    pub replaces: Option<StagedPluginReplaces>,
}

impl Validate for StagedPlugin {
    fn validate(&self, cx: &mut Issues) {
        cx.at("manifest", |cx| self.manifest.validate(cx));
        cx.at("source", |cx| self.source.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct StagedPluginReplaces {
    #[serde(deserialize_with = "de::required")]
    pub version: Option<String>,
    pub installed: bool,
}

impl Validate for StagedPluginReplaces {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PluginInstallStageRequest {
    pub source: PluginSource,
}

impl Validate for PluginInstallStageRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("source", |cx| self.source.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct PluginStagingId(pub String);

impl Validate for PluginStagingId {
    fn validate(&self, cx: &mut Issues) {
        cx.regex(&self.0, re!(r"^st-[a-z0-9]{8,32}$"), None);
    }
}
