//! Settings › Remote access and the Machines menu (`manager/routes/peer.ts`).

use std::sync::Arc;

use eos_contracts::{ConnectHostRequest, HostView, PeerUpdateRequest, UpdateHostRequest};
use eos_core::net::peer::PeerHosting;
use eos_core::store::ConfigSource;
use eos_domain::peer::{ViewTokens, is_fingerprint};
use eos_runtime::access::Access;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::{PeerParts, no_route};

#[derive(Serialize)]
struct Cancelled {
    cancelled: usize,
}

#[derive(Serialize)]
struct Disconnected {
    disconnected: usize,
}

#[derive(Serialize)]
struct Done {
    ok: bool,
}

#[derive(Serialize)]
struct Hosts {
    hosts: Vec<HostView>,
}

#[derive(Serialize)]
struct Token {
    token: String,
}

/// A paired host with whether it took this computer's offer to be controlled back.
#[derive(Serialize)]
struct Paired {
    #[serde(flatten)]
    view: HostView,
    mutual: bool,
}

/// The user's own settings: this dashboard only, never from a paired computer.
const SETTINGS: Access = Access::ui_token().local_only();

/// Why no invite is made on a run that keeps off the network.
const OFF_NETWORK_INVITE: &str = "Only the installed Eos on your own data folder lets other computers in";

/// The id in the path, when it is a fingerprint.
fn fingerprint<'a>(req: &'a Request, name: &str) -> Option<&'a str> {
    req.param(name).filter(|id| is_fingerprint(id))
}

fn write_config(config: &dyn ConfigSource, patch: Map<String, Value>) -> Result<(), ApiError> {
    config.patch("peer", patch).map(drop).map_err(|e| ApiError::Internal(format!("failed to write config: {e}")))
}

/// The fields a request names, as the configuration file takes them.
fn config_patch(patch: &PeerUpdateRequest) -> Map<String, Value> {
    match serde_json::to_value(patch) {
        Ok(Value::Object(fields)) => fields,
        _ => Map::new(),
    }
}

pub(crate) fn all(parts: &PeerParts) -> Vec<RouteDef> {
    let mut routes = hosting(parts.hosting.clone(), parts.config.clone());
    routes.extend(controlling(parts));
    routes
}

fn hosting(hosting: Arc<dyn PeerHosting>, config: Arc<dyn ConfigSource>) -> Vec<RouteDef> {
    let info = hosting.clone();
    let status = hosting.clone();
    let (save, save_config) = (hosting.clone(), config.clone());
    let (invite, invite_config) = (hosting.clone(), config);
    let cancel = hosting.clone();
    let revoke = hosting.clone();
    let disconnect = hosting;
    vec![
        // Who this app is: public on purpose, on a paired computer too.
        RouteDef::get("/api/host", move |_req: Request| {
            let info = info.clone();
            async move { Ok(Response::json(200, &info.host_info())) }
        })
        .access(Access::open().peer_open()),
        RouteDef::get("/api/peer", move |_req: Request| {
            let status = status.clone();
            async move { Ok(Response::json(200, &status.status())) }
        })
        .access(SETTINGS),
        RouteDef::put("/api/peer", move |req: Request| {
            let (hosting, config) = (save.clone(), save_config.clone());
            async move {
                let patch: PeerUpdateRequest = req.parse()?;
                write_config(config.as_ref(), config_patch(&patch))?;
                hosting.reconcile().await;
                Ok(Response::json(200, &hosting.status()))
            }
        })
        .access(SETTINGS),
        RouteDef::post("/api/peer/invite", move |_req: Request| {
            let (hosting, config) = (invite.clone(), invite_config.clone());
            async move {
                if !config.current().peer.enabled {
                    return Err(ApiError::Conflict("turn on remote access first".into()));
                }
                // A link from a run that keeps off the network names no way in.
                if hosting.status().off.is_some() {
                    return Err(ApiError::Conflict(OFF_NETWORK_INVITE.into()));
                }
                let invite = hosting.create_invite().map_err(|e| ApiError::Conflict(e.to_string()))?;
                Ok(Response::json(200, &invite))
            }
        })
        .access(SETTINGS),
        RouteDef::delete("/api/peer/invite", move |_req: Request| {
            let hosting = cancel.clone();
            async move { Ok(Response::json(200, &Cancelled { cancelled: hosting.cancel_invites() })) }
        })
        .access(SETTINGS),
        RouteDef::delete("/api/peer/devices/{fp}", move |req: Request| {
            let hosting = revoke.clone();
            async move {
                let Some(fp) = fingerprint(&req, "fp") else { return Ok(no_route(req.path())) };
                if !hosting.revoke(fp) {
                    return Err(ApiError::NotFound("no such device".into()));
                }
                Ok(Response::json(200, &Done { ok: true }))
            }
        })
        .access(SETTINGS),
        RouteDef::post("/api/peer/devices/{fp}/disconnect", move |req: Request| {
            let hosting = disconnect.clone();
            async move {
                let Some(fp) = fingerprint(&req, "fp") else { return Ok(no_route(req.path())) };
                Ok(Response::json(200, &Disconnected { disconnected: hosting.disconnect(fp) }))
            }
        })
        .access(SETTINGS),
    ]
}

fn controlling(parts: &PeerParts) -> Vec<RouteDef> {
    let unknown = || ApiError::NotFound("unknown computer".into());
    let list = parts.links.clone();
    let (connect, connect_hosting, connect_config) = (parts.links.clone(), parts.hosting.clone(), parts.config.clone());
    let update = parts.links.clone();
    let (forget, forget_tokens): (_, Arc<ViewTokens>) = (parts.links.clone(), parts.view_tokens.clone());
    let (mint, mint_tokens) = (parts.links.clone(), parts.view_tokens.clone());
    let reconnect = parts.links.clone();
    vec![
        RouteDef::get("/api/hosts", move |_req: Request| {
            let links = list.clone();
            async move { Ok(Response::json(200, &Hosts { hosts: links.list() })) }
        })
        .access(SETTINGS),
        RouteDef::post("/api/hosts", move |req: Request| {
            let (links, hosting, config) = (connect.clone(), connect_hosting.clone(), connect_config.clone());
            async move {
                let body: ConnectHostRequest = req.parse()?;
                let mutual = body.mutual == Some(true);
                // "Let it control this Mac too" is hosting: the person just asked for it.
                if mutual && !config.current().peer.enabled {
                    write_config(config.as_ref(), Map::from_iter([("enabled".to_owned(), Value::Bool(true))]))?;
                    hosting.reconcile().await;
                }
                let (view, mutual) = links
                    .pair(&body.invite, body.alias.as_deref(), mutual)
                    .await
                    .map_err(|e| ApiError::Status { status: e.status, message: e.message, code: None })?;
                Ok(Response::json(200, &Paired { view, mutual }))
            }
        })
        .access(SETTINGS),
        RouteDef::put("/api/hosts/{id}", move |req: Request| {
            let links = update.clone();
            async move {
                let Some(id) = fingerprint(&req, "id") else { return Ok(no_route(req.path())) };
                let patch: UpdateHostRequest = req.parse()?;
                let view = links.update(id, &patch).ok_or_else(unknown)?;
                Ok(Response::json(200, &view))
            }
        })
        .access(SETTINGS),
        RouteDef::delete("/api/hosts/{id}", move |req: Request| {
            let (links, tokens) = (forget.clone(), forget_tokens.clone());
            async move {
                let Some(id) = fingerprint(&req, "id") else { return Ok(no_route(req.path())) };
                if !links.forget(id) {
                    return Err(unknown());
                }
                tokens.revoke_host(id);
                Ok(Response::json(200, &Done { ok: true }))
            }
        })
        .access(SETTINGS),
        RouteDef::post("/api/hosts/{id}/view-token", move |req: Request| {
            let (links, tokens) = (mint.clone(), mint_tokens.clone());
            async move {
                let Some(id) = fingerprint(&req, "id") else { return Ok(no_route(req.path())) };
                if links.get(id).is_none() {
                    return Err(unknown());
                }
                Ok(Response::json(200, &Token { token: tokens.mint(id) }))
            }
        })
        .access(SETTINGS),
        RouteDef::post("/api/hosts/{id}/reconnect", move |req: Request| {
            let links = reconnect.clone();
            async move {
                let Some(id) = fingerprint(&req, "id") else { return Ok(no_route(req.path())) };
                if !links.reconnect(id) {
                    return Err(unknown());
                }
                Ok(Response::json(200, &links.get(id)))
            }
        })
        .access(SETTINGS),
    ]
}
