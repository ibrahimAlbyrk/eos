//! Settings › Sync. Status is open; the key and every change are the user's.
//! All of it is local-only: the key never crosses to a paired computer.

use std::sync::Arc;

use eos_contracts::{SyncJoinRequest, SyncKeyResponse, routes};
use eos_runtime::access::Access;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;

use crate::SyncService;

const USER: Access = Access::ui_token().local_only();

pub(crate) fn all(service: &Arc<SyncService>) -> Vec<RouteDef> {
    let sync = service.clone();
    let status = RouteDef::get(routes::SYNC.path, move |_req: Request| {
        let sync = sync.clone();
        async move { Ok(Response::json(200, &sync.status())) }
    })
    .access(Access::open().local_only());

    let sync = service.clone();
    let key = RouteDef::get(routes::SYNC_KEY.path, move |_req: Request| {
        let sync = sync.clone();
        async move {
            let key = sync.key().ok_or_else(|| ApiError::NotFound("sync is off".into()))?;
            Ok(Response::json(200, &SyncKeyResponse { key }))
        }
    })
    .access(USER);

    let sync = service.clone();
    let create = RouteDef::post(routes::SYNC_CREATE.path, move |_req: Request| {
        let sync = sync.clone();
        async move { Ok(Response::json(200, &sync.create()?)) }
    })
    .access(USER);

    let sync = service.clone();
    let join = RouteDef::post(routes::SYNC_JOIN.path, move |req: Request| {
        let sync = sync.clone();
        async move {
            let body: SyncJoinRequest = req.parse()?;
            Ok(Response::json(200, &sync.join(&body.key)?))
        }
    })
    .access(USER);

    let sync = service.clone();
    let now = RouteDef::post(routes::SYNC_NOW.path, move |_req: Request| {
        let sync = sync.clone();
        async move {
            sync.sync_now();
            Ok(Response::json(202, &sync.status()))
        }
    })
    .access(USER);

    let sync = service.clone();
    let leave = RouteDef::post(routes::SYNC_LEAVE.path, move |_req: Request| {
        let sync = sync.clone();
        async move { Ok(Response::json(200, &sync.leave()?)) }
    })
    .access(USER);

    vec![status, key, create, join, now, leave]
}
