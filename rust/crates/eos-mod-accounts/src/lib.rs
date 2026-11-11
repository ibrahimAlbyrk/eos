//! Settings › Accounts and Settings › Usage (`manager/routes/accounts.ts`,
//! `usage.ts`, `anthropic.ts`).
//!
//! Every accounts route needs the user's dashboard: an agent that can reach
//! the app can neither read account state nor sign the user in or out. Every
//! answer is redacted: no token, key or store path leaves the app. Usage is
//! an open read (percentages and reset times only).
//!
//! Not here: the provider presets' keys (`/api/backends`), which arrive with
//! the metered providers.

use std::sync::Arc;

use eos_accounts::Accounts;
use eos_contracts::{
    AccountsResponse, AnthropicConfig, AnthropicConfigPatch, AnthropicConfigStatus, AutoSwitchRequest,
    DefaultLoginRequest, PlanLoginRenameRequest, PlanResumeRequest, SignInCodeRequest, SignInStartRequest,
    UsageResponse,
};
use eos_core::store::ConfigSource;
use eos_runtime::access::Access;
use eos_runtime::bus::{Topic, TopicDecl};
use eos_runtime::http::{ApiError, Request, Response, percent_decode};
use eos_runtime::module::{Module, ModuleError};
use eos_runtime::router::{BoxFuture, RouteDef};
use serde_json::{Map, Value, json};

/// Every round of plan-usage reads, as the dashboard's open surfaces follow it.
pub const USAGE_CHANGE: Topic<UsageResponse> = Topic::new("usage:change");

pub struct AccountsModule {
    accounts: Arc<Accounts>,
    config: Arc<dyn ConfigSource>,
}

impl std::fmt::Debug for AccountsModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AccountsModule").finish_non_exhaustive()
    }
}

impl AccountsModule {
    pub fn new(accounts: Arc<Accounts>, config: Arc<dyn ConfigSource>) -> Self {
        Self { accounts, config }
    }
}

fn ok() -> Response {
    Response::json(200, &json!({ "ok": true }))
}

/// A path parameter, decoded.
fn param(req: &Request, name: &str) -> String {
    let raw = req.param(name).unwrap_or_default();
    percent_decode(raw).map_or_else(|| raw.to_owned(), |decoded| decoded.into_owned())
}

/// `Ok` or today's 409 with the reason.
fn or_conflict(result: Result<(), String>) -> Result<Response, ApiError> {
    result.map(|()| ok()).map_err(ApiError::Conflict)
}

fn redact(anthropic: &AnthropicConfig) -> AnthropicConfigStatus {
    let set = |value: &Option<String>| value.as_ref().is_some_and(|v| !v.trim().is_empty());
    AnthropicConfigStatus { api_key_set: set(&anthropic.api_key), auth_token_set: set(&anthropic.auth_token) }
}

fn account_routes(accounts: &Arc<Accounts>) -> Vec<RouteDef> {
    // The provider named in the path, when it can be signed in to; else a 404.
    let supported = |accounts: &Accounts, req: &Request| {
        let provider = param(req, "provider");
        if accounts.sign_ins().supports(&provider) {
            Ok(provider)
        } else {
            Err(ApiError::NotFound(format!("sign-in is not supported for \"{provider}\"")))
        }
    };
    // The provider named in the path, when it holds several sign-ins; else a 404.
    let several = |accounts: &Accounts, req: &Request| {
        let provider = param(req, "provider");
        if accounts.sign_ins().holds_several(&provider) {
            Ok(provider)
        } else {
            Err(ApiError::NotFound(format!("\"{provider}\" holds a single sign-in")))
        }
    };

    let a = accounts.clone();
    let list = move |_req: Request| {
        let a = a.clone();
        async move { Ok(Response::json(200, &AccountsResponse { accounts: a.status().list().await })) }
    };

    let a = accounts.clone();
    let sign_in = move |req: Request| {
        let a = a.clone();
        async move {
            let provider = supported(&a, &req)?;
            let body: SignInStartRequest = req.parse()?;
            Ok(Response::json(202, &a.sign_ins().start(&provider, body.login_id.as_deref())?))
        }
    };

    let a = accounts.clone();
    let sign_out = move |req: Request| {
        let a = a.clone();
        async move {
            let provider = supported(&a, &req)?;
            match a.sign_ins().sign_out(&provider).await {
                Ok(()) => Ok(ok()),
                Err(e) => Err(ApiError::Internal(format!("failed to sign out: {e}"))),
            }
        }
    };

    let a = accounts.clone();
    let rename = move |req: Request| {
        let a = a.clone();
        async move {
            let provider = several(&a, &req)?;
            let body: PlanLoginRenameRequest = req.parse()?;
            a.logins().rename(&provider, &param(&req, "id"), &body.label)?;
            // The usage snapshots carry the label.
            Ok(ok())
        }
    };

    let a = accounts.clone();
    let remove = move |req: Request| {
        let a = a.clone();
        async move {
            let provider = several(&a, &req)?;
            a.sign_ins().remove_login(&provider, &param(&req, "id")).await?;
            Ok(ok())
        }
    };

    let a = accounts.clone();
    let default_login = move |req: Request| {
        let a = a.clone();
        async move {
            let provider = several(&a, &req)?;
            let body: DefaultLoginRequest = req.parse()?;
            a.logins().set_default(&provider, &body.login_id)?;
            Ok(ok())
        }
    };

    let a = accounts.clone();
    let auto_switch = move |req: Request| {
        let a = a.clone();
        async move {
            let provider = several(&a, &req)?;
            let body: AutoSwitchRequest = req.parse()?;
            a.logins().set_auto_switch(&provider, body.enabled)?;
            Ok(ok())
        }
    };

    // An accounts_exhausted row's actions.
    let a = accounts.clone();
    let plan_resume = move |req: Request| {
        let a = a.clone();
        async move {
            let body: PlanResumeRequest = req.parse()?;
            let worker = param(&req, "id");
            if !body.on {
                a.resume().cancel(&worker, body.row_id).await;
                return Ok(ok());
            }
            or_conflict(a.resume().schedule(&worker, body.row_id).await)
        }
    };

    let a = accounts.clone();
    let api_key_continue = move |req: Request| {
        let a = a.clone();
        async move { or_conflict(a.continue_on_api_key(&param(&req, "id")).await) }
    };

    let not_found = || ApiError::NotFound("sign-in not found".to_owned());
    let a = accounts.clone();
    let session = move |req: Request| {
        let found = a.sign_ins().get(&param(&req, "id"));
        async move { Ok(Response::json(200, &found.ok_or_else(not_found)?)) }
    };

    let a = accounts.clone();
    let cancel = move |req: Request| {
        let id = param(&req, "id");
        let cancelled = a.sign_ins().cancel(&id);
        let after = a.sign_ins().get(&id);
        async move {
            // A sign-in that already ended answers 404 with its last state, as today.
            let after = after.ok_or_else(not_found)?;
            Ok(Response::json(if cancelled { 200 } else { 404 }, &after))
        }
    };

    let a = accounts.clone();
    let code = move |req: Request| {
        let a = a.clone();
        async move {
            let body: SignInCodeRequest = req.parse()?;
            let id = param(&req, "id");
            if !a.sign_ins().submit_code(&id, &body.code) {
                return Err(ApiError::Conflict("sign-in is not waiting for a code".to_owned()));
            }
            Ok(Response::json(200, &a.sign_ins().get(&id)))
        }
    };

    let user = Access::ui_token();
    vec![
        RouteDef::get("/api/accounts", list).access(user),
        RouteDef::post("/api/accounts/{provider}/sign-in", sign_in).access(user),
        RouteDef::delete("/api/accounts/{provider}/sign-in", sign_out).access(user),
        RouteDef::put("/api/accounts/{provider}/logins/{id}", rename).access(user),
        RouteDef::delete("/api/accounts/{provider}/logins/{id}", remove).access(user),
        RouteDef::put("/api/accounts/{provider}/default-login", default_login).access(user),
        RouteDef::put("/api/accounts/{provider}/auto-switch", auto_switch).access(user),
        RouteDef::put("/workers/{id}/plan-resume", plan_resume).access(user),
        RouteDef::post("/workers/{id}/api-key-continue", api_key_continue).access(user),
        RouteDef::get("/api/sign-ins/{id}", session).access(user),
        RouteDef::delete("/api/sign-ins/{id}", cancel).access(user),
        RouteDef::post("/api/sign-ins/{id}/code", code).access(user),
    ]
}

/// Plan usage: what is held at once (a stale snapshot refreshes behind it and
/// arrives as `usage:change`); `?wait=1` waits for that refresh.
fn usage_route(accounts: &Arc<Accounts>) -> RouteDef {
    let a = accounts.clone();
    let usage = move |req: Request| {
        let a = a.clone();
        async move {
            let wait = req.query().get("wait").as_deref() == Some("1");
            let usage = if wait { a.usage().get_usage().await } else { a.usage().current().await };
            Ok(Response::json(200, &usage))
        }
    };
    RouteDef::get("/api/usage", usage).access(Access::open())
}

/// The Claude credentials of `config.json`, redacted both ways.
fn anthropic_routes(accounts: &Arc<Accounts>, config: &Arc<dyn ConfigSource>) -> Vec<RouteDef> {
    let c = config.clone();
    let read = move |_req: Request| {
        let status = redact(&c.current().anthropic);
        async move { Ok(Response::json(200, &status)) }
    };
    let (a, c) = (accounts.clone(), config.clone());
    let write = move |req: Request| {
        let (a, c) = (a.clone(), c.clone());
        async move {
            let patch: AnthropicConfigPatch = req.parse()?;
            // A blank value clears the field, so config.json stays clean.
            let mut fields = Map::new();
            for (key, value) in [("apiKey", patch.api_key), ("authToken", patch.auth_token)] {
                match value {
                    Some(value) if !value.trim().is_empty() => fields.insert(key.to_owned(), value.into()),
                    Some(_) => fields.insert(key.to_owned(), Value::Null),
                    None => None,
                };
            }
            let config =
                c.patch("anthropic", fields).map_err(|e| ApiError::Internal(format!("failed to write config: {e}")))?;
            a.status().invalidate();
            Ok(Response::json(200, &redact(&config.anthropic)))
        }
    };
    vec![
        RouteDef::get("/api/anthropic/config", read).access(Access::ui_token()),
        RouteDef::put("/api/anthropic/config", write).access(Access::ui_token()),
    ]
}

impl Module for AccountsModule {
    fn id(&self) -> &'static str {
        "accounts"
    }

    fn routes(&self) -> Vec<RouteDef> {
        let mut routes = account_routes(&self.accounts);
        routes.push(usage_route(&self.accounts));
        routes.extend(anthropic_routes(&self.accounts, &self.config));
        routes
    }

    fn topics(&self) -> Vec<TopicDecl> {
        vec![USAGE_CHANGE.decl()]
    }

    /// Claude's sign-in from before it could hold several joins the list.
    fn start(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        Box::pin(async move { Ok(self.accounts.adopt_existing().await?) })
    }
}
