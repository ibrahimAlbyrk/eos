//! Settings › Remote (`manager/routes/remote.ts`). The user's own dashboard
//! only, and never across to a paired computer: arming the link and showing
//! its pairing code are a person's act at this computer. A phone cannot reach
//! them either — they have no phone rule.

use std::sync::Arc;

use eos_contracts::{RemoteConfig, RemoteConfigRelay, Validate};
use eos_runtime::access::Access;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::Shared;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status<'a> {
    enabled: bool,
    armed: bool,
    /// The saved URL, also while disarmed: Settings shows it.
    relay_url: Option<&'a str>,
}

#[derive(Serialize)]
struct Arming {
    enabled: bool,
    armed: bool,
}

#[derive(Serialize)]
struct Saved<'a> {
    remote: &'a RemoteConfig,
}

/// What Settings may write of `config.remote`: the switch and the relay URL.
/// Any other key is refused instead of landing in `config.json`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteConfigPatch {
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    relay: Option<RemoteConfigRelay>,
}

impl Validate for RemoteConfigPatch {
    fn validate(&self, cx: &mut eos_contracts::Issues) {
        cx.at("relay", |cx| {
            if let Some(relay) = &self.relay {
                relay.validate(cx);
            }
        });
    }
}

const ACCESS: Access = Access::ui_token().local_only();

pub(crate) fn all(shared: &Arc<Shared>) -> Vec<RouteDef> {
    let status = {
        let shared = shared.clone();
        RouteDef::get("/api/remote/status", move |_req: Request| {
            let shared = shared.clone();
            async move {
                let config = shared.parts.config.current();
                let relay_url = config.remote.relay.as_ref().map(|relay| relay.url.as_str());
                let armed = shared.armed().is_some();
                Ok(Response::json(200, &Status { enabled: config.remote.enabled, armed, relay_url }))
            }
        })
    };
    // Arms or disarms for the configuration on disk. The dashboard calls it
    // right after saving, so switching the link on needs no restart.
    let arm = {
        let shared = shared.clone();
        RouteDef::post("/api/remote/arm", move |_req: Request| {
            let shared = shared.clone();
            async move {
                shared.parts.config.reload();
                let state = shared.reconcile();
                Ok(Response::json(200, &Arming { enabled: state.enabled, armed: state.armed }))
            }
        })
    };
    let pair = {
        let shared = shared.clone();
        RouteDef::post("/api/remote/pair", move |_req: Request| {
            let shared = shared.clone();
            async move {
                match shared.pairing() {
                    Some(code) => Ok(Response::json(200, &code)),
                    None => Err(ApiError::Conflict("remote not armed; enable + set relay URL + Save".into())),
                }
            }
        })
    };
    // Saves the switch and the relay URL into `config.json`'s `remote`
    // section, beside whatever else is there. Arming is a separate call.
    let save = {
        let shared = shared.clone();
        RouteDef::put("/api/remote/config", move |req: Request| {
            let shared = shared.clone();
            async move {
                let patch: RemoteConfigPatch = req.parse()?;
                let mut section = serde_json::Map::new();
                if let Some(enabled) = patch.enabled {
                    section.insert("enabled".into(), Value::Bool(enabled));
                }
                if let Some(relay) = patch.relay {
                    section.insert("relay".into(), serde_json::json!({ "url": relay.url }));
                }
                match shared.parts.config.patch("remote", section) {
                    Ok(config) => Ok(Response::json(200, &Saved { remote: &config.remote })),
                    Err(error) => Ok(Response::error(500, format!("failed to write config: {error}"))),
                }
            }
        })
    };
    [status, arm, pair, save].into_iter().map(|route| route.access(ACCESS)).collect()
}
