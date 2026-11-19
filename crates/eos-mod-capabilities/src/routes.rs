//! The routes over the capability service, each capability turned into its
//! wire row.

use std::collections::HashMap;
use std::sync::Arc;

use eos_capabilities::CapabilityService;
use eos_contracts::{
    CapabilityAction, CapabilityCall, CapabilityDetail, CapabilityReach, CapabilityRow, CapabilitySecret,
    CapabilitySetting, CapabilitySettings, CapabilityVersion, RollbackRequest,
};
use eos_core::Error;
use eos_core::capability::{Capability, CapabilityRegistry};
use eos_core::store::{Store, Tx};
use eos_domain::capability::health::StateCode;
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use serde_json::{Value, json};

/// The calls a capability's page lists.
const RECENT_CALLS: i64 = 20;
/// The items the candidates route lists when the request names no limit.
const CANDIDATES_DEFAULT: usize = 20;

/// A closed set's word, as the manifest writes it (`this_mac`, `phone`).
fn word<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_value(value).ok().and_then(|value| value.as_str().map(str::to_owned)).unwrap_or_default()
}

/// The ids of the routines whose blueprint needs each capability. A routine
/// deleted, or without a blueprint this app reads, uses none.
fn users(tx: &dyn Tx) -> Result<HashMap<String, Vec<String>>, Error> {
    let mut users: HashMap<String, Vec<String>> = HashMap::new();
    for routine in tx.routines().list()?.into_iter().filter(|routine| routine.deleted_at.is_none()) {
        let Some(head) = tx.routine_versions().head(&routine.id)? else { continue };
        let Ok(blueprint) = serde_json::from_str::<Value>(&head.blueprint) else { continue };
        for need in blueprint["needs"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            users.entry(need.to_owned()).or_default().push(routine.id.clone());
        }
    }
    Ok(users)
}

fn row(capability: &Capability, users: &HashMap<String, Vec<String>>) -> CapabilityRow {
    let manifest = &capability.manifest;
    CapabilityRow {
        id: capability.id.clone(),
        name: manifest.name.clone(),
        summary: manifest.summary.clone(),
        origin: capability.origin.clone(),
        state: capability.health.state.as_str().to_owned(),
        state_code: capability.health.code.as_ref().map(StateCode::as_string),
        version: capability.version.clone(),
        works: word(&manifest.works),
        action_count: manifest.actions.len() as i64,
        used_by: users.get(&capability.id).cloned().unwrap_or_default(),
        account_label: capability.account_label.clone(),
    }
}

/// The capability, or 404.
async fn found(service: &CapabilityService, id: &str) -> Result<Capability, Error> {
    service.get(id).await?.ok_or_else(|| Error::not_found("capability", id))
}

async fn row_of(service: &CapabilityService, store: &Arc<dyn Store>, id: &str) -> Result<CapabilityRow, Error> {
    let capability = found(service, id).await?;
    Ok(row(&capability, &store.read(users).await?))
}

async fn detail(service: &CapabilityService, store: &Arc<dyn Store>, id: &str) -> Result<CapabilityDetail, Error> {
    let capability = found(service, id).await?;
    let manifest = &capability.manifest;
    let owned = id.to_owned();
    let (users, mut versions, calls) = store
        .read(move |tx| {
            let versions = tx.capability_versions().of_capability(&owned)?;
            Ok((users(tx)?, versions, tx.capability_calls().recent(&owned, RECENT_CALLS)?))
        })
        .await?;
    versions.sort_by_key(|version| std::cmp::Reverse(version.created_at));
    let mut secrets = Vec::new();
    for secret in &manifest.secrets {
        let set = service.secret_set(id, &secret.name).await?;
        secrets.push(CapabilitySecret { name: secret.name.clone(), label: secret.label.clone(), set });
    }
    Ok(CapabilityDetail {
        row: row(&capability, &users),
        actions: manifest
            .actions
            .iter()
            .map(|action| CapabilityAction {
                name: action.name.clone(),
                summary: action.summary.clone(),
                class: action.class,
                undo: Some(action.undo.clone()).filter(|undo| !undo.is_empty()),
            })
            .collect(),
        reach: CapabilityReach {
            hosts: manifest.reach.hosts.clone(),
            apps: manifest.reach.apple_events.clone(),
            files: manifest.reach.files_read.clone(),
        },
        secrets,
        settings: manifest
            .settings
            .iter()
            .map(|setting| CapabilitySetting {
                name: setting.name.clone(),
                label: setting.label.clone(),
                kind: word(&setting.kind),
                value: capability.settings[&setting.name].as_str().map(str::to_owned),
            })
            .collect(),
        versions: versions
            .into_iter()
            .map(|version| CapabilityVersion {
                version: version.version,
                status: version.status,
                created_at: version.created_at,
                source: version.source,
            })
            .collect(),
        recent_calls: calls
            .into_iter()
            .map(|call| CapabilityCall {
                action: call.action,
                outcome: call.outcome,
                at: call.started_at,
                duration_ms: call.duration_ms,
            })
            .collect(),
    })
}

fn id_of(req: &Request) -> String {
    req.param("id").unwrap_or_default().to_owned()
}

fn limit_of(req: &Request) -> Result<usize, ApiError> {
    match req.query().get("limit") {
        None => Ok(CANDIDATES_DEFAULT),
        Some(text) => text
            .parse::<usize>()
            .ok()
            .filter(|limit| *limit > 0)
            .ok_or_else(|| ApiError::invalid([("limit", "Expected a positive number")])),
    }
}

/// What every handler holds.
#[derive(Clone)]
struct Parts {
    service: Arc<CapabilityService>,
    store: Arc<dyn Store>,
}

pub(crate) fn all(service: &Arc<CapabilityService>, store: &Arc<dyn Store>) -> Vec<RouteDef> {
    let parts = Parts { service: service.clone(), store: store.clone() };

    let p = parts.clone();
    let list = RouteDef::get("/api/capabilities", move |_req: Request| {
        let p = p.clone();
        async move {
            let capabilities = p.service.list().await?;
            let users = p.store.read(users).await?;
            Ok(Response::json(200, &capabilities.iter().map(|capability| row(capability, &users)).collect::<Vec<_>>()))
        }
    });
    let p = parts.clone();
    let candidates = RouteDef::get("/api/capabilities/candidates", move |req: Request| {
        let p = p.clone();
        async move {
            let limit = limit_of(&req)?;
            let (item, q) = (req.query().get("item"), req.query().get("q"));
            let items = p.service.candidates(item.as_deref(), q.as_deref(), limit).await?;
            Ok(Response::json(200, &items))
        }
    });
    let p = parts.clone();
    let one = RouteDef::get("/api/capabilities/{id}", move |req: Request| {
        let p = p.clone();
        async move { Ok(Response::json(200, &detail(&p.service, &p.store, &id_of(&req)).await?)) }
    });
    let p = parts.clone();
    let enable = RouteDef::post("/api/capabilities/{id}/enable", move |req: Request| {
        let p = p.clone();
        async move {
            let id = id_of(&req);
            p.service.enable(&id).await?;
            Ok(Response::json(200, &row_of(&p.service, &p.store, &id).await?))
        }
    });
    let p = parts.clone();
    let disable = RouteDef::post("/api/capabilities/{id}/disable", move |req: Request| {
        let p = p.clone();
        async move {
            let id = id_of(&req);
            p.service.disable(&id).await?;
            Ok(Response::json(200, &row_of(&p.service, &p.store, &id).await?))
        }
    });
    let p = parts.clone();
    let settings = RouteDef::put("/api/capabilities/{id}/settings", move |req: Request| {
        let p = p.clone();
        async move {
            let (id, body): (String, CapabilitySettings) = (id_of(&req), req.parse()?);
            p.service.set_settings(&id, body.values.into_iter().collect()).await?;
            Ok(Response::json(200, &detail(&p.service, &p.store, &id).await?))
        }
    });
    let p = parts.clone();
    let check = RouteDef::post("/api/capabilities/{id}/check", move |req: Request| {
        let p = p.clone();
        async move {
            let id = id_of(&req);
            p.service.check(&id).await?;
            Ok(Response::json(200, &row_of(&p.service, &p.store, &id).await?))
        }
    });
    let p = parts.clone();
    let rollback = RouteDef::post("/api/capabilities/{id}/rollback", move |req: Request| {
        let p = p.clone();
        async move {
            let (id, body): (String, RollbackRequest) = (id_of(&req), req.parse()?);
            p.service.rollback(&id, &body.version).await?;
            Ok(Response::json(200, &row_of(&p.service, &p.store, &id).await?))
        }
    });
    let p = parts;
    let remove = RouteDef::delete("/api/capabilities/{id}", move |req: Request| {
        let p = p.clone();
        async move {
            p.service.remove(&id_of(&req)).await?;
            Ok(Response::json(200, &json!({ "ok": true })))
        }
    });

    // What a capability is and does reads from the phone; switching one off and checking it
    // act from there too. Its settings, versions and removal are this computer's alone.
    let read = Access::ui_token().phone_user(Tier::Read);
    let act = Access::ui_token().phone_user(Tier::Low);
    let here = Access::ui_token().local_only();
    vec![
        list.access(read),
        candidates.access(read),
        one.access(read),
        enable.access(Access::ui_token()),
        disable.access(act),
        settings.access(here),
        check.access(act),
        rollback.access(here),
        remove.access(here),
    ]
}
