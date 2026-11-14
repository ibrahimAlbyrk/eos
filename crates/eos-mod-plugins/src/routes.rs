//! The plugin routes:
//!
//! ```text
//! GET  /api/plugins                     every plugin, its state and settings, and the
//!                                       folder plugins live in (+ where the installed
//!                                       ones came from, for the user's dashboard)
//! GET  /api/plugins/:id                 one
//! GET  /api/plugins/:id/status[?wait=1] one, with the windows' latest report
//! POST /api/plugins/:id/report          { rev, ok, error? } from a window
//! PUT  /api/plugins/:id/enabled         { enabled }
//! PUT  /api/plugins/:id/settings        { values }
//! GET  /api/plugins/:id/store/:key      { value }
//! PUT  /api/plugins/:id/store/:key      { value }
//! POST /api/plugins/:id/preview         → { path } of a PNG (this computer only)
//! ```
//!
//! Installing — the user's dashboard only, never from another computer:
//!
//! ```text
//! POST   /api/plugins/install             { source } → a staged plugin to review
//! POST   /api/plugins/install/:stagingId  install it → { plugin }
//! DELETE /api/plugins/install/:stagingId  drop it
//! POST   /api/plugins/:id/update          stage the newest from where it came from
//! DELETE /api/plugins/:id                 move its folder to the trash
//! GET    /ui/plugins/:id/:rev.js|.css     a build, by revision — beside the dashboard's
//!                                         own code, so a window loads it the same way
//! ```

use std::sync::Arc;

use eos_contracts::{
    PluginEnabledRequest, PluginId, PluginInfo, PluginInstallRecord, PluginInstallStageRequest, PluginPreviewRequest,
    PluginReportRequest, PluginSettingsRequest, PluginStagingId, PluginStoreKey, PluginStoreRequest, StagedPlugin,
    Validate,
};
use eos_runtime::access::Access;
use eos_runtime::http::{ApiError, Request, Response, percent_decode};
use eos_runtime::router::RouteDef;
use indexmap::IndexMap;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::installer::PluginInstaller;
use crate::preview::{PluginPreviews, PreviewFailure};
use crate::service::PluginService;

#[derive(Clone)]
pub(crate) struct Deps {
    pub(crate) plugins: Arc<PluginService>,
    pub(crate) installer: Arc<PluginInstaller>,
    pub(crate) previews: Arc<PluginPreviews>,
}

#[derive(Serialize)]
struct Listing {
    plugins: Vec<PluginInfo>,
    /// Where installed plugins came from is the user's business only.
    #[serde(skip_serializing_if = "Option::is_none")]
    installs: Option<IndexMap<String, PluginInstallRecord>>,
    dir: String,
}

#[derive(Serialize)]
struct One {
    plugin: PluginInfo,
}

#[derive(Serialize)]
struct Staged {
    staged: StagedPlugin,
}

#[derive(Serialize)]
struct Done {
    ok: bool,
}

#[derive(Serialize)]
struct Stored {
    value: Option<Value>,
}

#[derive(Serialize)]
struct Missing<'a> {
    error: &'a str,
    path: String,
}

fn ok() -> Response {
    Response::json(200, &Done { ok: true })
}

/// A path parameter checked as the contract type `T` (a plugin id, a store
/// key, a staging id), exactly as written in the path.
fn param<T: DeserializeOwned + Validate>(req: &Request, name: &str) -> Result<T, ApiError> {
    let raw = req.param(name).unwrap_or_default();
    Ok(eos_contracts::parse(&Value::String(raw.to_owned()))?)
}

fn id(req: &Request) -> Result<String, ApiError> {
    param::<PluginId>(req, "id").map(|id| id.0)
}

/// JSON numbers as JavaScript keeps them: `2.0` is `2`. Stored values came
/// through `JSON.parse` until now, so what is written back reads the same.
fn js_numbers(value: &mut Value) {
    match value {
        Value::Number(number) => {
            if let Some(float) = number.as_f64().filter(|f| number.is_f64() && f.fract() == 0.0 && f.abs() < 9.0e15) {
                *number = serde_json::Number::from(float as i64);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(js_numbers),
        Value::Object(fields) => fields.values_mut().for_each(js_numbers),
        _ => {}
    }
}

/// `<rev>.js` or `<rev>.css`.
fn bundle_file(name: &str) -> Option<(i64, bool)> {
    let (rev, ext) = name.split_once('.')?;
    let is_js = match ext {
        "js" => true,
        "css" => false,
        _ => return None,
    };
    let digits = !rev.is_empty() && rev.bytes().all(|b| b.is_ascii_digit());
    // A revision past what fits was never handed out.
    digits.then(|| (rev.parse().unwrap_or(-1), is_js))
}

pub(crate) fn all(deps: &Deps) -> Vec<RouteDef> {
    let user = Access::ui_token();
    let user_here = Access::ui_token().local_only();
    let mut routes = Vec::new();

    let d = deps.clone();
    routes.push(
        RouteDef::get("/ui/plugins/{id}/{file}", move |req: Request| {
            let plugins = d.plugins.clone();
            async move {
                let Some((rev, is_js)) = bundle_file(req.param("file").unwrap_or_default()) else {
                    // Not a build: what the dashboard bundle says about a file it does not have.
                    let rest = req.path().strip_prefix("/ui/").unwrap_or_default();
                    let path = format!("/ui/{}", percent_decode(rest).unwrap_or(rest.into()));
                    return Ok(Response::json(404, &Missing { error: "not found", path }));
                };
                let build = plugins.bundle(req.param("id").unwrap_or_default(), rev);
                let body = build.and_then(|build| if is_js { Some(build.js) } else { build.css });
                let Some(body) = body else { return Err(ApiError::NotFound("not found".into())) };
                let kind = if is_js { "text/javascript; charset=utf-8" } else { "text/css; charset=utf-8" };
                // A revision never changes; a new build gets a new one.
                Ok(Response::bytes(200, kind, body).header("cache-control", "public, max-age=31536000, immutable"))
            }
        })
        .access(Access::open().peer_open()),
    );

    let d = deps.clone();
    routes.push(
        RouteDef::get("/api/plugins", move |req: Request| {
            let d = d.clone();
            async move {
                let installs = req.speaks_for_user().then(|| d.installer.installs());
                Ok(Response::json(200, &Listing { plugins: d.plugins.list(), installs, dir: d.plugins.dir() }))
            }
        })
        .access(Access::open()),
    );

    let d = deps.clone();
    routes.push(
        RouteDef::post("/api/plugins/install", move |req: Request| {
            let installer = d.installer.clone();
            async move {
                let body: PluginInstallStageRequest = req.parse()?;
                Ok(Response::json(200, &Staged { staged: installer.stage(body.source).await? }))
            }
        })
        .access(user_here),
    );

    let d = deps.clone();
    routes.push(
        RouteDef::post("/api/plugins/install/{stagingId}", move |req: Request| {
            let installer = d.installer.clone();
            async move {
                let staging = param::<PluginStagingId>(&req, "stagingId")?;
                Ok(Response::json(200, &One { plugin: installer.commit(&staging.0).await? }))
            }
        })
        .access(user_here),
    );

    let d = deps.clone();
    routes.push(
        RouteDef::delete("/api/plugins/install/{stagingId}", move |req: Request| {
            let installer = d.installer.clone();
            async move {
                let staging = param::<PluginStagingId>(&req, "stagingId")?;
                installer.discard(&staging.0).await;
                Ok(ok())
            }
        })
        .access(user_here),
    );

    let d = deps.clone();
    routes.push(
        RouteDef::post("/api/plugins/{id}/update", move |req: Request| {
            let installer = d.installer.clone();
            async move { Ok(Response::json(200, &Staged { staged: installer.stage_update(&id(&req)?).await? })) }
        })
        .access(user_here),
    );

    let d = deps.clone();
    routes.push(
        RouteDef::delete("/api/plugins/{id}", move |req: Request| {
            let installer = d.installer.clone();
            async move {
                installer.remove(&id(&req)?).await?;
                Ok(ok())
            }
        })
        .access(user_here),
    );

    let d = deps.clone();
    routes.push(
        RouteDef::get("/api/plugins/{id}/status", move |req: Request| {
            let plugins = d.plugins.clone();
            async move {
                let id = id(&req)?;
                let wait = req.query().get("wait").as_deref() == Some("1");
                Ok(Response::json(200, &plugins.status(&id, wait).await?))
            }
        })
        .access(Access::open()),
    );

    let d = deps.clone();
    routes.push(
        RouteDef::post("/api/plugins/{id}/report", move |req: Request| {
            let plugins = d.plugins.clone();
            async move {
                let body: PluginReportRequest = req.parse()?;
                plugins.report(&id(&req)?, body)?;
                Ok(ok())
            }
        })
        .access(user),
    );

    let d = deps.clone();
    routes.push(
        RouteDef::get("/api/plugins/{id}", move |req: Request| {
            let plugins = d.plugins.clone();
            async move { Ok(Response::json(200, &One { plugin: plugins.get(&id(&req)?)? })) }
        })
        .access(Access::open()),
    );

    let d = deps.clone();
    routes.push(
        RouteDef::put("/api/plugins/{id}/enabled", move |req: Request| {
            let plugins = d.plugins.clone();
            async move {
                let body: PluginEnabledRequest = req.parse()?;
                Ok(Response::json(200, &One { plugin: plugins.set_enabled(&id(&req)?, body.enabled).await? }))
            }
        })
        .access(user),
    );

    let d = deps.clone();
    routes.push(
        RouteDef::put("/api/plugins/{id}/settings", move |req: Request| {
            let plugins = d.plugins.clone();
            async move {
                let body: PluginSettingsRequest = req.parse()?;
                Ok(Response::json(200, &One { plugin: plugins.set_settings(&id(&req)?, &body.values)? }))
            }
        })
        .access(user),
    );

    let d = deps.clone();
    routes.push(
        RouteDef::get("/api/plugins/{id}/store/{key}", move |req: Request| {
            let plugins = d.plugins.clone();
            async move {
                let (id, key) = (id(&req)?, param::<PluginStoreKey>(&req, "key")?);
                Ok(Response::json(200, &Stored { value: plugins.store_value(&id, &key.0)? }))
            }
        })
        .access(Access::open()),
    );

    let d = deps.clone();
    routes.push(
        RouteDef::put("/api/plugins/{id}/store/{key}", move |req: Request| {
            let plugins = d.plugins.clone();
            async move {
                let mut body: PluginStoreRequest = req.parse()?;
                if let Some(value) = &mut body.value {
                    js_numbers(value);
                }
                let (id, key) = (id(&req)?, param::<PluginStoreKey>(&req, "key")?);
                plugins.set_store_value(&id, &key.0, body.value)?;
                Ok(ok())
            }
        })
        .access(user),
    );

    let d = deps.clone();
    routes.push(
        RouteDef::post("/api/plugins/{id}/preview", move |req: Request| {
            let previews = d.previews.clone();
            async move {
                let id = id(&req)?;
                let body: PluginPreviewRequest = req.parse()?;
                match previews.draw(&id, body).await {
                    Ok(drawn) => Ok(Response::json(200, &drawn)),
                    Err(PreviewFailure::Failed(e)) => Err(e.into()),
                    Err(PreviewFailure::NotDrawable(why)) => Err(ApiError::Conflict(why)),
                    Err(PreviewFailure::NoWindow) => Err(ApiError::status_with(503, PreviewFailure::NO_WINDOW)),
                }
            }
        })
        // No token: the agent writing the plugin asks. Drawn by this computer's app only.
        .access(Access::open().local_only()),
    );

    routes
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_bundle_file_is_a_revision_and_a_kind() {
        assert_eq!(bundle_file("12.js"), Some((12, true)));
        assert_eq!(bundle_file("3.css"), Some((3, false)));
        assert_eq!(bundle_file("99999999999999999999999.js"), Some((-1, true)), "never handed out");
        for other in ["", "js", ".js", "a.js", "1.mjs", "1.js.map", "-1.js", "1"] {
            assert_eq!(bundle_file(other), None, "{other:?}");
        }
    }

    #[test]
    fn whole_floats_are_stored_as_javascript_writes_them() {
        let mut value = json!({"count": 2.0, "half": 0.5, "list": [1.0, -3.0, 1e300], "text": "2.0"});
        js_numbers(&mut value);
        assert_eq!(value.to_string(), r#"{"count":2,"half":0.5,"list":[1,-3,1e+300],"text":"2.0"}"#);
    }
}
