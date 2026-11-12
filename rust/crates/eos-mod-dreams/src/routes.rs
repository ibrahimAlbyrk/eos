//! `GET  /api/dreams`             the dream log and the chats kept out of dreams
//! `GET  /api/dreams/status`      what dreaming is doing now
//! `GET  /api/dreams/:id`         one dream
//! `POST /api/dreams`             "Dream now"
//! `POST /api/dreams/stop`        stop after the current chat
//! `POST /api/dreams/exclusions`  keep a chat out of dreams, or let it back in
//!
//! Reads are open (the Memory view, Settings, the log); starting, stopping
//! and excluding chats are the user's.

use std::sync::Arc;

use eos_contracts::{DreamExclusionRequest, DreamListResponse};
use eos_core::store::Store;
use eos_runtime::access::Access;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use serde_json::json;

use crate::service::Dreams;

const RUNS_LISTED: i64 = 30;

/// `dr-[a-z0-9]+`: what a dream's id looks like.
fn is_run_id(id: &str) -> bool {
    id.strip_prefix("dr-")
        .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()))
}

pub(crate) fn all(dreams: &Dreams, store: &Arc<dyn Store>) -> Vec<RouteDef> {
    let list = {
        let store = store.clone();
        RouteDef::get("/api/dreams", move |_req: Request| {
            let store = store.clone();
            async move {
                let (runs, excluded) =
                    store.read(|tx| Ok((tx.dreams().list(RUNS_LISTED)?, tx.dreams().excluded()?))).await?;
                Ok(Response::json(200, &DreamListResponse { runs, excluded }))
            }
        })
    };
    let status = {
        let dreams = dreams.clone();
        RouteDef::get("/api/dreams/status", move |_req: Request| {
            let dreams = dreams.clone();
            async move { Ok(Response::json(200, &dreams.status().await)) }
        })
    };
    let one = {
        let store = store.clone();
        RouteDef::get("/api/dreams/{id}", move |req: Request| {
            let store = store.clone();
            async move {
                let id = req.param("id").unwrap_or_default().to_owned();
                if !is_run_id(&id) {
                    return Err(ApiError::NotFound("not found".into()));
                }
                match store.read(move |tx| tx.dreams().get(&id)).await? {
                    Some(run) => Ok(Response::json(200, &json!({"run": run}))),
                    None => Err(ApiError::NotFound("no such dream".into())),
                }
            }
        })
    };
    let now = {
        let dreams = dreams.clone();
        RouteDef::post("/api/dreams", move |_req: Request| {
            let dreams = dreams.clone();
            async move {
                match dreams.dream_now().await {
                    Ok(()) => Ok(Response::json(202, &json!({"started": true}))),
                    Err(reason) => Err(ApiError::Conflict(reason)),
                }
            }
        })
    };
    let stop = {
        let dreams = dreams.clone();
        RouteDef::post("/api/dreams/stop", move |_req: Request| {
            let dreams = dreams.clone();
            async move { Ok(Response::json(200, &json!({"stopping": dreams.request_stop()}))) }
        })
    };
    let exclude = {
        let store = store.clone();
        RouteDef::post("/api/dreams/exclusions", move |req: Request| {
            let store = store.clone();
            async move {
                let body: DreamExclusionRequest = req.parse()?;
                let excluded = store
                    .write(move |tx, _| {
                        tx.dreams().set_excluded(&body.worker_id, body.excluded)?;
                        tx.dreams().excluded()
                    })
                    .await?;
                Ok(Response::json(200, &json!({"excluded": excluded})))
            }
        })
    };
    vec![
        list.access(Access::open()),
        status.access(Access::open()),
        one.access(Access::open()),
        now.access(Access::ui_token()),
        stop.access(Access::ui_token()),
        exclude.access(Access::ui_token()),
    ]
}
