//! `GET /api/routines/:id/candidates?q=&limit=`: what the run form offers
//! to run on: the items the routine's Takes source lists, and the items its
//! own runs were given, newest first, each once.

use std::sync::Arc;

use eos_contracts::{CapabilityItem, ItemRef, RoutineCandidates, RunInput};
use eos_core::Error;
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{Request, Response};
use eos_runtime::router::RouteDef;

use super::{param, readable, showing_version};
use crate::engine::Engine;

/// The most items the form offers.
const CANDIDATES_MAX: usize = 20;
/// How many of the routine's runs its recent items are read from.
const RECENT_RUNS: i64 = 100;

pub(crate) fn route(engine: &Arc<Engine>) -> RouteDef {
    let engine = engine.clone();
    RouteDef::get("/api/routines/{id}/candidates", move |req: Request| {
        let engine = engine.clone();
        async move {
            let id = param(&req, "id");
            let query = req.query();
            let q = query.get("q").map(|q| q.into_owned()).filter(|q| !q.trim().is_empty());
            let limit = query.get("limit").and_then(|text| text.parse::<usize>().ok()).unwrap_or(CANDIDATES_MAX);
            let limit = limit.clamp(1, CANDIDATES_MAX);
            let routine = id.clone();
            let (source, recent) = engine
                .store
                .read(move |tx| {
                    let version =
                        showing_version(tx, &routine)?.ok_or_else(|| Error::not_found("routine", &routine))?;
                    let blueprint = readable(&version)?.ok_or_else(|| Error::not_found("routine", &routine))?;
                    let mut recent = Vec::new();
                    for run in tx.runs().by_routine(&routine, RECENT_RUNS)? {
                        let Ok(input) = serde_json::from_str::<RunInput>(&run.input) else { continue };
                        let items = input.item.into_iter().chain(input.items.into_iter().flatten());
                        recent.extend(items.map(|item| (run.created_at, item)));
                    }
                    Ok((blueprint.takes.source, recent))
                })
                .await?;
            let listed = match &source {
                Some(source) => match engine.reads.candidates(source, q.as_deref(), limit).await {
                    Ok(items) => items,
                    Err(error) => {
                        // The routine's own recent items still help.
                        tracing::warn!(routine_id = %id, %error, "a routine's candidates could not be read");
                        Vec::new()
                    }
                },
                None => Vec::new(),
            };
            let items = merge(listed, recent, q.as_deref(), limit);
            Ok(Response::json(200, &RoutineCandidates { items }))
        }
    })
    .access(Access::ui_token().phone_user(Tier::Read))
}

/// Both lists by time, newest first; an item already offered is not offered
/// again; recent items only when they match `q`.
fn merge(listed: Vec<CapabilityItem>, recent: Vec<(i64, ItemRef)>, q: Option<&str>, limit: usize) -> Vec<ItemRef> {
    let matches = |item: &ItemRef| {
        let Some(q) = q.map(str::to_lowercase) else { return true };
        let text = |field: &Option<String>| field.as_deref().is_some_and(|text| text.to_lowercase().contains(&q));
        text(&item.title) || text(&item.key)
    };
    let mut all: Vec<(i64, ItemRef)> = listed.into_iter().map(|item| (item.updated_at, item_ref(item))).collect();
    all.extend(recent.into_iter().filter(|(_, item)| matches(item)));
    all.sort_by_key(|(at, _)| std::cmp::Reverse(*at));
    let mut items: Vec<ItemRef> = Vec::new();
    for (_, item) in all {
        let seen = item.key.is_some() && items.iter().any(|kept| kept.key == item.key);
        if !seen {
            items.push(item);
        }
        if items.len() == limit {
            break;
        }
    }
    items
}

/// A capability's item as a run takes it: from outside.
pub(crate) fn item_ref(item: CapabilityItem) -> ItemRef {
    ItemRef {
        kind: item.kind,
        key: Some(item.key),
        title: Some(item.title),
        url: item.url,
        path: None,
        text: None,
        date: None,
        range: None,
        version: None,
        untrusted: true,
    }
}
