//! The providers reached with an API key (`/api/backends`): a preset or the
//! user's own endpoint is a `config.json` backend, its key a Keychain item.
//! A key is checked against the provider before it is saved.

use std::sync::Arc;

use eos_accounts::Accounts;
use eos_contracts::{AddBackendRequest, AddBackendResponse, AuthRefKind, BackendPresetsResponse, TestBackendRequest};
use eos_core::agent::ProviderKeys;
use eos_core::store::ConfigSource;
use eos_domain::accounts::{PROVIDER_PRESETS, ProviderPreset};
use eos_domain::provider::{endpoints, preset_profile, preset_summary};
use eos_runtime::access::Access;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use serde_json::{Map, Value, json};

use crate::param;

const NEEDS_KIND: &str = "kind and model are required (or supply a known preset)";
/// The context window of an endpoint the user adds without saying.
const CONTEXT_WINDOW: i64 = 128_000;

pub(crate) struct Backends {
    pub(crate) accounts: Arc<Accounts>,
    pub(crate) config: Arc<dyn ConfigSource>,
    pub(crate) keys: Arc<dyn ProviderKeys>,
}

fn preset_named(id: Option<&str>) -> Result<Option<&'static ProviderPreset>, String> {
    let Some(id) = id else { return Ok(None) };
    PROVIDER_PRESETS.iter().find(|p| p.id == id).map(Some).ok_or_else(|| format!("unknown preset \"{id}\""))
}

fn name_of<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// The backend a request describes: a preset's, or the user's own endpoint
/// (its key under `eos-<name>`).
fn profile_of(
    name: &str,
    preset: Option<&ProviderPreset>,
    kind: Option<Value>,
    model: Option<&str>,
    base_url: Option<&str>,
    rest: &AddBackendRequest,
) -> Result<Value, String> {
    if let Some(preset) = preset {
        let mut profile = preset_profile(preset);
        if let Some(model) = model {
            profile["model"] = model.into();
        }
        return Ok(profile);
    }
    let (Some(kind), Some(model)) = (kind, model) else { return Err(NEEDS_KIND.to_owned()) };
    let auth = match (&rest.auth, &rest.api_key) {
        (Some(auth), _) => name_of(auth),
        (None, Some(_)) => json!({"kind": "keychain", "ref": format!("eos-{name}")}),
        (None, None) => json!({"kind": "none"}),
    };
    let capabilities = match &rest.capabilities {
        Some(capabilities) => name_of(capabilities),
        None => json!({"wire": "openai-chat", "contextWindow": CONTEXT_WINDOW}),
    };
    let mut profile = json!({"kind": kind, "model": model, "auth": auth, "capabilities": capabilities});
    let optional = [
        ("baseUrl", base_url.map(Value::from)),
        ("costMode", rest.cost_mode.as_ref().map(name_of)),
        ("params", rest.params.as_ref().map(name_of)),
    ];
    for (key, value) in optional {
        if let Some(value) = value {
            profile[key] = value;
        }
    }
    Ok(profile)
}

fn bad(message: impl Into<String>) -> ApiError {
    ApiError::Validation(message.into())
}

impl Backends {
    async fn add(&self, body: AddBackendRequest) -> Result<Response, ApiError> {
        let preset = preset_named(body.preset.as_deref()).map_err(bad)?;
        let kind = body.kind.as_ref().map(name_of);
        let profile = profile_of(&body.name, preset, kind, body.model.as_deref(), body.base_url.as_deref(), &body)
            .map_err(bad)?;
        let parsed: eos_contracts::BackendProfile =
            serde_json::from_value(profile.clone()).map_err(|e| bad(format!("invalid request: {e}")))?;
        let service = parsed.auth.as_ref().filter(|a| a.kind == AuthRefKind::Keychain).and_then(|a| a.r#ref.clone());
        if let (Some(service), Some(key)) = (&service, body.api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()))
        {
            self.keys.save(service, key).map_err(|e| ApiError::Internal(format!("failed to save the key: {e}")))?;
        }
        let mut patch = Map::new();
        patch.insert(body.name.clone(), profile);
        self.config.patch("backends", patch).map_err(|e| ApiError::Internal(format!("failed to write config: {e}")))?;
        self.accounts.status().invalidate();
        let answer = AddBackendResponse {
            name: body.name,
            kind: name_of(&parsed.kind).as_str().unwrap_or_default().to_owned(),
            model: parsed.model,
            base_url: parsed.base_url,
        };
        Ok(Response::json(200, &answer))
    }

    async fn test(&self, body: TestBackendRequest) -> Response {
        let refused = |error: String| Response::json(400, &json!({"ok": false, "error": error}));
        let preset = match preset_named(body.preset.as_deref()) {
            Ok(preset) => preset,
            Err(error) => return refused(error),
        };
        let asked = AddBackendRequest {
            name: "test".into(),
            preset: None,
            kind: None,
            model: None,
            base_url: None,
            auth: None,
            cost_mode: None,
            params: None,
            capabilities: body.capabilities.clone(),
            api_key: body.api_key.clone(),
            price: None,
        };
        let kind = body.kind.as_ref().map(name_of);
        let profile = match profile_of("test", preset, kind, body.model.as_deref(), body.base_url.as_deref(), &asked) {
            Ok(profile) => profile,
            Err(error) => return refused(error),
        };
        let Some(key) = body.api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) else {
            return refused("apiKey is required".to_owned());
        };
        // The same reading as a saved backend's, so what is tested is what would run.
        let mut config = (*self.config.current()).clone();
        let parsed = serde_json::from_value(profile).map_err(|e| e.to_string());
        let endpoint = parsed.and_then(|profile| {
            config.backends.clear();
            config.backends.insert("test".to_owned(), profile);
            endpoints(&config).pop().ok_or_else(|| "this provider is not one Eos can reach with a key".to_owned())
        });
        let endpoint = match endpoint {
            Ok(endpoint) => endpoint,
            Err(error) => return refused(error),
        };
        match self.keys.probe(&endpoint, key).await {
            Ok(models) => Response::json(200, &json!({"ok": true, "models": models})),
            Err(error) => Response::json(200, &json!({"ok": false, "error": error})),
        }
    }

    fn delete(&self, name: &str) -> Result<Response, ApiError> {
        let config = self.config.current();
        let declared = self.config.declared_backends().unwrap_or_default();
        let Some(profile) = config.backends.get(name).filter(|_| declared.iter().any(|d| d == name)) else {
            return Err(ApiError::NotFound(format!("backend \"{name}\" not found")));
        };
        if let Some(auth) = profile.auth.as_ref().filter(|a| a.kind == AuthRefKind::Keychain)
            && let Some(service) = &auth.r#ref
        {
            self.keys.forget(service);
        }
        let mut patch = Map::new();
        patch.insert(name.to_owned(), Value::Null);
        self.config.patch("backends", patch).map_err(|e| ApiError::Internal(format!("failed to write config: {e}")))?;
        self.accounts.status().invalidate();
        Ok(Response::json(200, &json!({"ok": true})))
    }
}

pub(crate) fn routes(backends: Backends) -> Vec<RouteDef> {
    let backends = Arc::new(backends);
    let presets = |_req: Request| {
        let presets = PROVIDER_PRESETS.iter().map(preset_summary).collect();
        async move { Ok(Response::json(200, &BackendPresetsResponse { presets })) }
    };
    let b = backends.clone();
    let add = move |req: Request| {
        let b = b.clone();
        async move { b.add(req.parse()?).await }
    };
    let b = backends.clone();
    let test = move |req: Request| {
        let b = b.clone();
        async move { Ok(b.test(req.parse()?).await) }
    };
    let b = backends;
    let delete = move |req: Request| {
        let b = b.clone();
        async move { b.delete(&param(&req, "name")) }
    };
    // A key crosses these: the user's own dashboard on this computer only.
    let own = Access::ui_token().local_only();
    vec![
        RouteDef::get("/api/backends/presets", presets).access(Access::open()),
        RouteDef::post("/api/backends", add).access(own),
        RouteDef::post("/api/backends/test", test).access(own),
        RouteDef::delete("/api/backends/{name}", delete).access(own),
    ]
}
