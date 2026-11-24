//! Named queries as a surface reads them, and the Live parts they feed:
//!
//! - `GET /api/surfaces/:id/queries/:queryId?args=`: one query its kept
//!   design declares, read for the surface's routine;
//! - `GET /api/surfaces/:id/issues/:issueId/parts/:part`: a Live part of a
//!   page issue drawn with its query's answer, the arguments filled from the
//!   issue's stored data. When the query fails, the part's last good drawing
//!   comes back marked not current.
//!
//! Each answer names the topics that may change it, so the dashboard reads
//! it again when one fires.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use eos_contracts::{LivePartDoc, SurfaceQueryAnswer};
use eos_core::Error;
use eos_core::store::StoredSurface;
use eos_runtime::access::{Access, Tier};
use eos_runtime::actions::QueryCall;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use eos_surface::render::render_part;
use eos_surface::{PageDesign, Sources, fill_args, validate};
use serde_json::Value;

use crate::SurfacesParts;
use crate::page::load;
use crate::routes::{param, surface_in};

/// How many last good parts are held; the oldest go first.
const LAST_GOOD_MAX: usize = 256;

/// The last good drawing of each Live part, by issue and part.
#[derive(Debug, Default)]
pub(crate) struct LastGood(Mutex<Vec<((String, String), String)>>);

impl LastGood {
    fn put(&self, key: (String, String), html: String) {
        let mut held = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        held.retain(|(k, _)| *k != key);
        if held.len() >= LAST_GOOD_MAX {
            held.remove(0);
        }
        held.push((key, html));
    }

    fn get(&self, key: &(String, String)) -> Option<String> {
        let held = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        held.iter().find(|(k, _)| k == key).map(|(_, html)| html.clone())
    }
}

/// Reads `query_id` for a surface whose design declares it.
pub(crate) async fn read(
    parts: &SurfacesParts,
    surface: &StoredSurface,
    declared: &[String],
    query_id: &str,
    args: Value,
) -> Result<(Value, Vec<String>), ApiError> {
    if !declared.iter().any(|q| q == query_id) {
        return Err(ApiError::NotFound(format!("this surface reads no query {query_id}")));
    }
    let registry = parts.actions.registry();
    let decl = registry.query(query_id).ok_or_else(|| ApiError::NotFound(format!("no query {query_id}")))?;
    let checked = validate(&decl.args, &args);
    if !checked.is_ok() {
        let first = checked.problems.first().map(|p| p.to_string()).unwrap_or_default();
        return Err(ApiError::Validation(format!("invalid request: args: {first}")));
    }
    // Read for the routine the surface belongs to: a query of the owner's
    // scope answers only for it, one of any scope narrows itself to it.
    let call = QueryCall { query_id: query_id.to_owned(), routine_id: Some(surface.routine_id.clone()), args };
    let topics = decl.topics.iter().map(|t| (*t).to_owned()).collect();
    let answer = decl.handler.read(call).await.map_err(|failure| {
        tracing::debug!(surface_id = %surface.id, query_id, kind = %failure.kind, "a query failed");
        ApiError::Unreachable(failure.reason)
    })?;
    Ok((answer, topics))
}

pub(crate) fn routes(parts: &Arc<SurfacesParts>, last_good: &Arc<LastGood>) -> Vec<RouteDef> {
    let at = parts.clone();
    let query = RouteDef::get("/api/surfaces/{id}/queries/{queryId}", move |req: Request| {
        let (at, id, query_id) = (at.clone(), param(&req, "id"), param(&req, "queryId"));
        let args = req.query().get("args").map(|a| a.into_owned());
        async move {
            let args = match args {
                None => Value::Object(Default::default()),
                Some(raw) => serde_json::from_str(&raw)
                    .map_err(|_| ApiError::Validation("invalid request: args: JSON".into()))?,
            };
            let (surface, body) = at
                .store
                .read(move |tx| {
                    let surface = surface_in(tx, &id)?;
                    let number = surface.current_version.ok_or_else(|| Error::not_found("version", &id))?;
                    let found = tx.surface_versions().find(&id, number)?;
                    let found = found.ok_or_else(|| Error::not_found("version", number.to_string()))?;
                    Ok((surface, found.body_json))
                })
                .await?;
            let body: Value = serde_json::from_str(&body).unwrap_or_default();
            let declared = PageDesign::from_body(&body).map(|d| d.queries).unwrap_or_default();
            let (answer, topics) = read(&at, &surface, &declared, &query_id, args).await?;
            Ok(Response::json(200, &SurfaceQueryAnswer { query_id, answer, topics }))
        }
    })
    .access(Access::ui_token().phone_user(Tier::Read));

    let (at, held) = (parts.clone(), last_good.clone());
    let part = RouteDef::get("/api/surfaces/{id}/issues/{issueId}/parts/{part}", move |req: Request| {
        let (at, held) = (at.clone(), held.clone());
        let (id, issue_id, part) = (param(&req, "id"), param(&req, "issueId"), param(&req, "part"));
        async move {
            let drawn = load(&at, &id, &issue_id, None).await?;
            let live = drawn.design.template.live_part(&part);
            let live = live.ok_or_else(|| ApiError::NotFound(format!("no live part {part}")))?;
            let none = Value::Null;
            let args = fill_args(&live.args, Sources { data: &none, state: &none, item: &none, fields: &drawn.data });
            let key = (issue_id.clone(), part.clone());
            let topics = at
                .actions
                .registry()
                .query(&live.query)
                .map(|q| q.topics.iter().map(|t| (*t).to_owned()).collect())
                .unwrap_or_default();
            let read = read(&at, &drawn.surface, &drawn.design.queries, &live.query, args).await;
            let answer = match read {
                Ok((answer, _)) => answer,
                Err(ApiError::Unreachable(_)) => {
                    let html = held.get(&key).ok_or_else(|| ApiError::Unreachable("not current".into()))?;
                    return Ok(Response::json(200, &LivePartDoc { part, html, current: false, topics }));
                }
                Err(other) => return Err(other),
            };
            let surface_id = drawn.surface.id.clone();
            let image_src =
                move |hash: &str| Some(format!("http://raw.eos.localhost/surfaces/{surface_id}/img/{hash}"));
            let answers = HashMap::from([(part.clone(), answer)]);
            let html = render_part(&drawn.input(&image_src, &answers), &part).unwrap_or_default();
            held.put(key, html.clone());
            Ok(Response::json(200, &LivePartDoc { part, html, current: true, topics }))
        }
    })
    .access(Access::ui_token());
    vec![query, part]
}
