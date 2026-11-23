//! The reads of surfaces and their versions, and their saved state.

use std::sync::Arc;

use eos_contracts::{SurfaceList, SurfaceStateDoc, SurfaceVersionList, SurfacesState};
use eos_core::Error;
use eos_core::store::{StoredSurface, StoredSurfaceState, Tx};
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::path::percent_decode;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use eos_surface::limits::{APP_STATE_BYTES, STATE_BYTES};
use eos_surface::{Level, Place};
use serde_json::{Value, json};

use crate::wire::{surface_row, version, version_meta};
use crate::{SURFACES_STATE, SurfacesParts};

pub(crate) fn param(req: &Request, name: &str) -> String {
    let raw = req.param(name).unwrap_or_default();
    percent_decode(raw).map(|id| id.into_owned()).unwrap_or_else(|| raw.to_owned())
}

/// The surface `id`, or a 404.
pub(crate) fn surface_in(tx: &dyn Tx, id: &str) -> Result<StoredSurface, Error> {
    tx.surfaces().find(id)?.ok_or_else(|| Error::not_found("surface", id))
}

pub(crate) fn all(parts: &Arc<SurfacesParts>) -> Vec<RouteDef> {
    vec![list(parts), one(parts), versions(parts), one_version(parts), read_state(parts), write_state(parts)]
}

fn list(parts: &Arc<SurfacesParts>) -> RouteDef {
    let parts = parts.clone();
    RouteDef::get("/api/surfaces", move |req: Request| {
        let parts = parts.clone();
        async move {
            let routine = req.query().get("routine").map(|r| r.into_owned());
            let place = match req.query().get("place") {
                None => None,
                Some(word) => {
                    Some(Place::parse(&word).ok_or_else(|| ApiError::Validation(format!("unknown place: {word}")))?)
                }
            };
            let rows = parts.store.read(move |tx| tx.surfaces().list(routine.as_deref(), place)).await?;
            Ok(Response::json(200, &SurfaceList { surfaces: rows.iter().map(surface_row).collect() }))
        }
    })
    .access(Access::open().phone(Tier::Read))
}

fn one(parts: &Arc<SurfacesParts>) -> RouteDef {
    let parts = parts.clone();
    RouteDef::get("/api/surfaces/{id}", move |req: Request| {
        let (parts, id) = (parts.clone(), param(&req, "id"));
        async move {
            let row = parts.store.read(move |tx| surface_in(tx, &id)).await?;
            Ok(Response::json(200, &surface_row(&row)))
        }
    })
    .access(Access::open().phone(Tier::Read))
}

fn versions(parts: &Arc<SurfacesParts>) -> RouteDef {
    let parts = parts.clone();
    RouteDef::get("/api/surfaces/{id}/versions", move |req: Request| {
        let (parts, id) = (parts.clone(), param(&req, "id"));
        async move {
            let rows = parts
                .store
                .read(move |tx| {
                    surface_in(tx, &id)?;
                    tx.surface_versions().of_surface(&id)
                })
                .await?;
            Ok(Response::json(200, &SurfaceVersionList { versions: rows.iter().map(version_meta).collect() }))
        }
    })
    .access(Access::open().phone(Tier::Read))
}

fn one_version(parts: &Arc<SurfacesParts>) -> RouteDef {
    let parts = parts.clone();
    RouteDef::get("/api/surfaces/{id}/versions/{version}", move |req: Request| {
        let (parts, id) = (parts.clone(), param(&req, "id"));
        let number = param(&req, "version");
        async move {
            let n: i64 = number.parse().map_err(|_| ApiError::NotFound(format!("version not found: {number}")))?;
            let found = parts.store.read(move |tx| tx.surface_versions().find(&id, n)).await?;
            let found = found.ok_or_else(|| ApiError::NotFound(format!("version not found: {n}")))?;
            Ok(Response::json(200, &version(&found)))
        }
    })
    .access(Access::open().phone(Tier::Read))
}

fn scope_of(req: &Request) -> String {
    req.query().get("scope").map(|s| s.into_owned()).unwrap_or_default()
}

/// A scope is the whole surface (empty) or one of its issues.
fn check_scope(tx: &dyn Tx, surface_id: &str, scope: &str) -> Result<(), Error> {
    if scope.is_empty() {
        return Ok(());
    }
    match tx.surface_issues().find(scope)? {
        Some(issue) if issue.surface_id == surface_id => Ok(()),
        _ => Err(Error::not_found("issue", scope)),
    }
}

fn read_state(parts: &Arc<SurfacesParts>) -> RouteDef {
    let parts = parts.clone();
    RouteDef::get("/api/surfaces/{id}/state", move |req: Request| {
        let (parts, id, scope) = (parts.clone(), param(&req, "id"), scope_of(&req));
        async move {
            let found = parts
                .store
                .read(move |tx| {
                    surface_in(tx, &id)?;
                    check_scope(tx, &id, &scope)?;
                    Ok((scope.clone(), tx.surface_state().find(&id, &scope)?))
                })
                .await?;
            let doc = match found {
                (scope, None) => SurfaceStateDoc { scope, data: json!({}), updated_at: None },
                (scope, Some(stored)) => SurfaceStateDoc {
                    scope,
                    data: serde_json::from_str(&stored.data_json).unwrap_or_else(|_| json!({})),
                    updated_at: Some(stored.updated_at),
                },
            };
            Ok(Response::json(200, &doc))
        }
    })
    .access(Access::ui_token().phone_user(Tier::Read))
}

fn write_state(parts: &Arc<SurfacesParts>) -> RouteDef {
    let parts = parts.clone();
    RouteDef::put("/api/surfaces/{id}/state", move |req: Request| {
        let (parts, id) = (parts.clone(), param(&req, "id"));
        async move {
            let mut asked: SurfaceStateDoc = req.parse()?;
            if req.query().get("scope").is_some() {
                asked.scope = scope_of(&req);
            }
            if !matches!(asked.data, Value::Object(_)) {
                return Err(ApiError::Validation("invalid request: data: must be an object".into()));
            }
            let data_json = asked.data.to_string();
            let now = parts.clock.now_ms();
            let scope = asked.scope.clone();
            let saved = parts
                .store
                .write(move |tx, out| {
                    let surface = surface_in(tx, &id)?;
                    check_scope(tx, &id, &scope)?;
                    let max = if surface.level == Level::App { APP_STATE_BYTES } else { STATE_BYTES };
                    if data_json.len() > max {
                        return Err(Error::Validation(format!("state is {} bytes, max {max}", data_json.len())));
                    }
                    let bytes = i64::try_from(data_json.len()).unwrap_or(i64::MAX);
                    let row = StoredSurfaceState {
                        surface_id: id.clone(),
                        scope: scope.clone(),
                        data_json,
                        bytes,
                        updated_at: now,
                    };
                    tx.surface_state().put(&row)?;
                    out.push(SURFACES_STATE.name(), &SurfacesState { surface_id: id.clone(), scope });
                    Ok(row)
                })
                .await?;
            tracing::info!(surface = %saved.surface_id, bytes = saved.bytes, "a surface's state was saved");
            Ok(Response::json(200, &SurfaceStateDoc { scope: saved.scope, data: asked.data, updated_at: Some(now) }))
        }
    })
    .access(Access::ui_token().phone_user(Tier::Low))
}
