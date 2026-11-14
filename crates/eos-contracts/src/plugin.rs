use indexmap::IndexMap;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::primitives::{Num, de};
use crate::validate::{Issues, Validate, re, utf16_len};

pub const PLUGIN_MANIFEST_FILE: &str = "plugin.json";

pub const PLUGIN_UI_ENTRIES: &[&str] = &["ui.tsx", "ui.jsx", "ui.ts", "ui.js"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct PluginId(pub String);

impl Validate for PluginId {
    fn validate(&self, cx: &mut Issues) {
        cx.regex(&self.0, re!(r"^[a-z0-9]+(?:[.-][a-z0-9]+)*$"), Some("lowercase letters, digits, \"-\" and \".\""));
        cx.str_max(&self.0, 64);
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PluginSetting {
    Boolean(PluginSettingBoolean),
    String(PluginSettingString),
    Number(PluginSettingNumber),
    Select(PluginSettingSelect),
}

impl Validate for PluginSetting {
    fn validate(&self, cx: &mut Issues) {
        match self {
            Self::Boolean(v) => v.validate(cx),
            Self::String(v) => v.validate(cx),
            Self::Number(v) => v.validate(cx),
            Self::Select(v) => v.validate(cx),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PluginSettingBoolean {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<bool>,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

impl Validate for PluginSettingBoolean {
    fn validate(&self, cx: &mut Issues) {
        cx.at("title", |cx| {
            cx.str_min(&self.title, 1);
            cx.str_max(&self.title, 80);
        });
        cx.at("description", |cx| {
            if let Some(v) = &self.description {
                cx.str_max(v, 300);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PluginSettingString {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multiline: Option<bool>,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

impl Validate for PluginSettingString {
    fn validate(&self, cx: &mut Issues) {
        cx.at("title", |cx| {
            cx.str_min(&self.title, 1);
            cx.str_max(&self.title, 80);
        });
        cx.at("description", |cx| {
            if let Some(v) = &self.description {
                cx.str_max(v, 300);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PluginSettingNumber {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Num>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<Num>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<Num>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<Num>,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

impl Validate for PluginSettingNumber {
    fn validate(&self, cx: &mut Issues) {
        cx.at("title", |cx| {
            cx.str_min(&self.title, 1);
            cx.str_max(&self.title, 80);
        });
        cx.at("description", |cx| {
            if let Some(v) = &self.description {
                cx.str_max(v, 300);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PluginSettingSelect {
    pub options: Vec<PluginSettingSelectOptionsItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

impl Validate for PluginSettingSelect {
    fn validate(&self, cx: &mut Issues) {
        cx.at("options", |cx| cx.arr_min(self.options.len(), 1));
        cx.at("title", |cx| {
            cx.str_min(&self.title, 1);
            cx.str_max(&self.title, 80);
        });
        cx.at("description", |cx| {
            if let Some(v) = &self.description {
                cx.str_max(v, 300);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PluginSettingSelectOptionsItem {
    pub value: String,
    pub label: String,
}

impl Validate for PluginSettingSelectOptionsItem {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PluginManifest {
    pub id: PluginId,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<IndexMap<String, PluginSetting>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub experimental: Option<bool>,
}

impl Validate for PluginManifest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("id", |cx| self.id.validate(cx));
        cx.at("name", |cx| {
            cx.str_min(&self.name, 1);
            cx.str_max(&self.name, 60);
        });
        cx.at("description", |cx| {
            if let Some(v) = &self.description {
                cx.str_max(v, 300);
            }
        });
        cx.at("version", |cx| {
            if let Some(v) = &self.version {
                cx.str_max(v, 40);
            }
        });
        cx.at("icon", |cx| {
            if let Some(v) = &self.icon {
                cx.str_max(v, 8000);
            }
        });
        cx.at("settings", |cx| {
            if let Some(v) = &self.settings {
                for (k, v) in v {
                    cx.at(k, |cx| {
                        cx.regex(k, re!(r"^[A-Za-z][A-Za-z0-9_.-]*$"), None);
                        v.validate(cx);
                    });
                }
            }
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum PluginState {
    Active,
    Disabled,
    Error,
}

impl Validate for PluginState {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum PluginSettingValue {
    Flag(bool),
    Text(String),
    Number(Num),
}

impl Validate for PluginSettingValue {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub builtin: bool,
    pub dir: String,
    #[serde(deserialize_with = "de::required")]
    pub manifest: Option<PluginManifest>,
    pub enabled: bool,
    pub state: PluginState,
    #[serde(deserialize_with = "de::required")]
    pub error: Option<String>,
    pub rev: i64,
    pub has_ui: bool,
    pub has_css: bool,
    pub settings: IndexMap<String, PluginSettingValue>,
}

impl Validate for PluginInfo {
    fn validate(&self, cx: &mut Issues) {
        cx.at("manifest", |cx| {
            if let Some(v) = &self.manifest {
                v.validate(cx);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PluginReportRequest {
    pub rev: i64,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Validate for PluginReportRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("error", |cx| {
            if let Some(v) = &self.error {
                cx.str_max(v, 8000);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PluginEnabledRequest {
    pub enabled: bool,
}

impl Validate for PluginEnabledRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PluginSettingsRequest {
    pub values: IndexMap<String, PluginSettingValue>,
}

impl Validate for PluginSettingsRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PluginStoreRequest {
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::some")]
    pub value: Option<Value>,
}

impl Validate for PluginStoreRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct PluginStoreKey(pub String);

impl Validate for PluginStoreKey {
    fn validate(&self, cx: &mut Issues) {
        cx.regex(&self.0, re!(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$"), None);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum PluginPreviewSurface {
    Main,
    Panel,
    Header,
}

impl Validate for PluginPreviewSurface {}

pub const PLUGIN_PREVIEW_STORE_MAX_BYTES: i64 = 262144;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginPreviewRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface: Option<PluginPreviewSurface>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub store: Option<IndexMap<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_ms: Option<i64>,
}

impl Validate for PluginPreviewRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("view", |cx| {
            if let Some(v) = &self.view {
                cx.str_max(v, 100);
            }
        });
        cx.at("store", |cx| {
            if let Some(v) = &self.store {
                if !v.keys().all(|k| re!(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$").find(k).is_some()) {
                    cx.push("store keys: letters, digits, _ . -");
                }
                // JSON.stringify(store).length: UTF-16 units of the compact JSON.
                if serde_json::to_string(v).map_or(0, |json| utf16_len(&json)) > PLUGIN_PREVIEW_STORE_MAX_BYTES as usize
                {
                    cx.push("store is larger than 256 KB");
                }
            }
        });
        cx.at("width", |cx| {
            if let Some(v) = &self.width {
                cx.int_min(*v, 240, true);
                cx.int_max(*v, 1600, true);
            }
        });
        cx.at("height", |cx| {
            if let Some(v) = &self.height {
                cx.int_min(*v, 60, true);
                cx.int_max(*v, 1200, true);
            }
        });
        cx.at("waitMs", |cx| {
            if let Some(v) = &self.wait_ms {
                cx.int_min(*v, 0, true);
                cx.int_max(*v, 5000, true);
            }
        });
    }
}

/// Bus topics: `plugins:change {id}` — a plugin was added, removed, rebuilt,
/// toggled or re-set; `plugin:<id>:store {key}` — one stored value changed.
pub const PLUGINS_TOPIC: &str = "plugins:change";

pub fn plugin_store_topic(id: &str) -> String {
    format!("plugin:{id}:store")
}

/// What a window reported after loading a build, with when.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PluginReport {
    pub rev: i64,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub at: Num,
}

/// `[width, height]` of a preview when the request names none.
pub fn plugin_preview_size(surface: PluginPreviewSurface) -> (i64, i64) {
    match surface {
        PluginPreviewSurface::Main => (1000, 760),
        PluginPreviewSurface::Panel => (420, 760),
        PluginPreviewSurface::Header => (760, 56),
    }
}

/// The app's `plugin.preview` answer: what it drew and what went wrong while drawing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PluginPreviewResult {
    /// base64
    pub png: String,
    pub surface: PluginPreviewSurface,
    #[serde(deserialize_with = "de::required")]
    pub view: Option<String>,
    pub width: Num,
    pub height: Num,
    pub errors: Vec<String>,
    /// What the plugin registered, by surface: the ids `view` accepts.
    pub available: PluginPreviewAvailable,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct PluginPreviewAvailable {
    pub main: Vec<String>,
    pub panel: Vec<String>,
    pub header: Vec<String>,
}

/// Current setting values: defaults filled in, unknown keys and mistyped values dropped.
pub fn plugin_setting_values(
    manifest: Option<&PluginManifest>,
    saved: &serde_json::Map<String, Value>,
) -> IndexMap<String, PluginSettingValue> {
    let mut out = IndexMap::new();
    let Some(settings) = manifest.and_then(|m| m.settings.as_ref()) else { return out };
    for (key, def) in settings {
        let (kept, default) = match (def, saved.get(key)) {
            (PluginSetting::Boolean(d), v) => {
                (v.and_then(Value::as_bool).map(PluginSettingValue::Flag), d.default.map(PluginSettingValue::Flag))
            }
            (PluginSetting::String(d), v) => (
                v.and_then(Value::as_str).map(|s| PluginSettingValue::Text(s.to_owned())),
                d.default.clone().map(PluginSettingValue::Text),
            ),
            (PluginSetting::Number(d), v) => (
                v.and_then(Value::as_f64).map(|n| PluginSettingValue::Number(Num(n))),
                d.default.map(PluginSettingValue::Number),
            ),
            (PluginSetting::Select(d), v) => (
                v.and_then(Value::as_str)
                    .filter(|s| d.options.iter().any(|o| o.value == *s))
                    .map(|s| PluginSettingValue::Text(s.to_owned())),
                d.default.clone().map(PluginSettingValue::Text),
            ),
        };
        if let Some(value) = kept.or(default) {
            out.insert(key.clone(), value);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn setting_values_fill_defaults_and_drop_the_rest() {
        let manifest: PluginManifest = serde_json::from_value(json!({
            "id": "clock", "name": "Clock",
            "settings": {
                "seconds": {"type": "boolean", "title": "Seconds", "default": true},
                "label": {"type": "string", "title": "Label"},
                "size": {"type": "number", "title": "Size", "default": 12},
                "zone": {"type": "select", "title": "Zone", "options": [{"value": "utc", "label": "UTC"}], "default": "utc"},
            },
        }))
        .unwrap();
        let saved = json!({"seconds": "yes", "label": "Home", "size": 14, "zone": "mars", "gone": 1});
        let values = plugin_setting_values(Some(&manifest), saved.as_object().unwrap());
        // A mistyped value falls back to the default; an unknown select value too; no default = left out.
        assert_eq!(
            serde_json::to_value(&values).unwrap(),
            json!({"seconds": true, "label": "Home", "size": 14, "zone": "utc"})
        );
        assert!(plugin_setting_values(None, saved.as_object().unwrap()).is_empty());
    }
}
