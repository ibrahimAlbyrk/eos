//! `POST /api/forge`: the user asks the Forge for a capability (from the
//! dashboard, or an App promoted to an Extension).

use std::sync::Arc;

use eos_contracts::{ForgeStart, ForgeStarted};
use eos_core::forge::{ForgeAnswer, ForgeCaller, ForgeRequest};
use eos_runtime::access::Access;
use eos_runtime::http::{Request, Response};
use eos_runtime::router::RouteDef;

use crate::request::ForgeService;

pub(crate) fn all(service: &Arc<ForgeService>) -> Vec<RouteDef> {
    let service = service.clone();
    let start = RouteDef::post("/api/forge", move |req: Request| {
        let service = service.clone();
        async move {
            let body: ForgeStart = req.parse()?;
            let request = ForgeRequest {
                need: body.need,
                routine_id: body.routine_id,
                capability_id: body.capability_id,
                from_surface: body.from_surface,
                caller: ForgeCaller::User,
            };
            let run_id = match service.request(request).await? {
                ForgeAnswer::Started { run_id } => run_id,
                ForgeAnswer::Ready { .. } | ForgeAnswer::Setup { .. } => {
                    return Err(eos_core::Error::Conflict("the user's ask always starts a run".into()).into());
                }
            };
            Ok(Response::json(200, &ForgeStarted { run_id }))
        }
    });
    // It starts agents that build code: this computer's dashboard only.
    vec![start.access(Access::ui_token().local_only())]
}
