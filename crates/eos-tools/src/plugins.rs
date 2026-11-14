//! Eos plugins as the agent writing one sees them (`plugin_status`,
//! `plugin_preview`).

use std::sync::Arc;

use eos_contracts::{PLUGIN_PREVIEW_STORE_MAX_BYTES, PluginPreviewRequest, PluginStoreKey};
use eos_core::plugin::{PluginStatus, Plugins};
use eos_core::{BoxFuture, Error};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::schema::{Schema, int, issues_text, object, one_of, record, string};
use crate::tool::{Call, Failure, Handler, Outcome, Output, Spec, args};

const SURFACES: &[&str] = &["main", "panel", "header"];

/// Where a plugin stands after its files were written: built or not (and
/// why), and whether the open windows loaded it or it failed there.
fn describe(status: &PluginStatus) -> Value {
    let (p, report) = (&status.plugin, status.report.as_ref());
    let window = if !p.enabled {
        "turned off in Settings › Plugins — nothing loads".to_owned()
    } else if !p.has_ui {
        "no UI entry to load".to_owned()
    } else {
        match report.filter(|report| report.rev >= p.rev) {
            None => "not loaded in any window yet (is the Eos app open?)".to_owned(),
            Some(report) if report.ok => format!("build {} loaded", p.rev),
            Some(report) => format!(
                "build {} failed in the window: {}",
                report.rev,
                report.error.as_deref().unwrap_or("unknown error")
            ),
        }
    };
    json!({
        "id": p.id,
        "dir": p.dir,
        "state": p.state,
        "buildError": p.error,
        "build": if p.rev == 0 { Value::Null } else { p.rev.into() },
        "window": window,
        "settings": p.settings,
    })
}

struct PluginStatusTool(Arc<dyn Plugins>);

#[derive(Deserialize)]
struct StatusArgs {
    id: Option<String>,
}

impl Handler for PluginStatusTool {
    fn run<'a>(&'a self, _call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let StatusArgs { id } = args(input)?;
            let Some(id) = id.filter(|id| !id.is_empty()) else {
                let plugins: Vec<Value> = self
                    .0
                    .list()
                    .iter()
                    .map(|p| {
                        json!({
                            "id": p.id,
                            "name": p.manifest.as_ref().map(|m| m.name.clone()),
                            "state": p.state,
                            "error": p.error,
                        })
                    })
                    .collect();
                return Ok(Output::json(&json!({"pluginsDir": self.0.dir(), "plugins": plugins})));
            };
            match self.0.status(&id, true).await {
                Ok(status) => Ok(Output::Json(describe(&status))),
                Err(Error::NotFound { .. }) => Ok(Output::json(&json!({
                    "id": id,
                    "state": "missing",
                    "window": format!(
                        "no plugin folder \"{id}\" — create it (with plugin.json) in the plugins folder; call plugin_status with no id to see where that is"
                    ),
                }))),
                Err(e) => Err(e.into()),
            }
        })
    }
}

struct PluginPreviewTool(Arc<dyn Plugins>);

/// The preview request's own limits (`PluginPreviewRequestSchema`): the tool
/// checks its input against them before asking for a picture.
fn preview_request() -> Schema {
    object(vec![
        ("surface", one_of(SURFACES).optional()),
        ("view", string().max(100).optional()),
        ("store", record().optional()),
        ("width", int().min(240).max(1600).optional()),
        ("height", int().min(60).max(1200).optional()),
        ("waitMs", int().min(0).max(5000).optional()),
    ])
}

fn custom(message: &str) -> Value {
    json!({"code": "custom", "message": message, "path": ["store"]})
}

/// What the request's schema refuses, in its words.
fn refused_request(body: &Value) -> Option<String> {
    let mut issues = preview_request().parse(body).err().unwrap_or_default();
    if let Some(store) = body.get("store").and_then(Value::as_object) {
        let key_ok = |key: &String| eos_contracts::check(&PluginStoreKey(key.clone())).is_ok();
        let mut custom_issues = Vec::new();
        if !store.keys().all(key_ok) {
            custom_issues.push(custom("store keys: letters, digits, _ . -"));
        }
        let size = Value::Object(store.clone()).to_string().encode_utf16().count();
        if i64::try_from(size).unwrap_or(i64::MAX) > PLUGIN_PREVIEW_STORE_MAX_BYTES {
            custom_issues.push(custom("store is larger than 256 KB"));
        }
        // The store's issues sit where its key does: before the sizes.
        let at = issues
            .iter()
            .position(|issue| matches!(issue["path"][0].as_str(), Some("width" | "height" | "waitMs")))
            .unwrap_or(issues.len());
        issues.splice(at..at, custom_issues);
    }
    (!issues.is_empty()).then(|| issues_text(&issues))
}

impl Handler for PluginPreviewTool {
    fn run<'a>(&'a self, _call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let id = input["id"].as_str().unwrap_or_default().to_owned();
            let mut body = input;
            if let Some(fields) = body.as_object_mut() {
                fields.remove("id");
            }
            if let Some(text) = refused_request(&body) {
                return Err(Failure(text));
            }
            let request: PluginPreviewRequest = args(body)?;
            let previewed = self.0.preview(&id, request).await?;
            Ok(Output::json(&previewed))
        })
    }
}

pub(crate) fn specs(plugins: &Arc<dyn Plugins>) -> Vec<Spec> {
    vec![
        Spec::new(
            "plugin_status",
            object(vec![(
                "id",
                string().optional().describe(
                    "The plugin's id (its folder name). Omit to list every plugin and the folder they live in.",
                ),
            )]),
            PluginStatusTool(plugins.clone()),
        )
        .search_hint("eos plugin status build error loaded ui widget sidebar header panel extend interface"),
        Spec::new(
            "plugin_preview",
            object(vec![
                ("id", string().describe("The plugin's id (its folder name).")),
                (
                    "surface",
                    one_of(SURFACES).optional().describe(
                        "main = a mainView, panel = a sidePanelTab, header = the headerRight widgets. Default: the first the plugin registered, in that order.",
                    ),
                ),
                ("view", string().optional().describe("Which mainView / sidePanelTab id to draw; default the first.")),
                (
                    "store",
                    record().optional().describe(
                        "Sample values for useStore keys, used only in the preview (the user's data is never touched). Keys left out read the real stored value.",
                    ),
                ),
                ("width", int().optional().describe("Width in px. Default: main 1000, panel 420, header 760.")),
                ("height", int().optional().describe("Height in px. Default: main 760, panel 760, header 56.")),
                (
                    "waitMs",
                    int().optional().describe(
                        "Let entrance animations play this long before the picture is taken. Default 700.",
                    ),
                ),
            ]),
            PluginPreviewTool(plugins.clone()),
        )
        .search_hint("eos plugin preview screenshot picture look design check render view"),
    ]
}
