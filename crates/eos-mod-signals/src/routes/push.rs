//! `POST /api/signals/sources/:sourceId/push`: the source's service pushes
//! its events to a new hook of this computer's relay inbox. The service
//! changes (a repository gets a webhook), so only the user on this
//! computer asks, never the phone; a dev run refuses it, since it reaches
//! the service and the relay. Answers the source as the routine page shows
//! it.

use std::sync::Arc;

use eos_core::Error;
use eos_runtime::access::Access;
use eos_runtime::http::{Request, Response};
use eos_runtime::router::RouteDef;

use super::Routes;
use super::status::source_status;

pub(super) fn route(routes: &Arc<Routes>) -> RouteDef {
    let routes = routes.clone();
    RouteDef::post("/api/signals/sources/{sourceId}/push", move |req: Request| {
        let routes = routes.clone();
        async move {
            let source_id = req.param("sourceId").unwrap_or_default().to_owned();
            let push =
                routes.push.as_ref().ok_or_else(|| Error::Unreachable("no hook inbox in this run of Eos".into()))?;
            let row = push.add(&source_id).await?;
            Ok(Response::json(200, &source_status(row)))
        }
    })
    .access(Access::ui_token())
}
