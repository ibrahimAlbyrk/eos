//! `POST /api/forge`: the user asks the Forge for a capability (from the
//! dashboard, or an App promoted to an Extension). A run's proposal:
//! `GET /api/forge/proposals/{runId}`, and from this computer's dashboard
//! only its live test and its answer: no phone, paired computer, link or
//! agent installs a capability.

use std::sync::Arc;

use eos_contracts::{ForgeStart, ForgeStarted, LiveTestStart, ProposalAnswer};
use eos_core::forge::{ForgeAnswer, ForgeCaller, ForgeRequest};
use eos_runtime::access::Access;
use eos_runtime::http::{Request, Response};
use eos_runtime::router::RouteDef;

use crate::answer::Proposals;
use crate::request::ForgeService;

fn run_of(req: &Request) -> String {
    req.param("id").unwrap_or_default().to_owned()
}

pub(crate) fn all(service: &Arc<ForgeService>, proposals: &Arc<Proposals>) -> Vec<RouteDef> {
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
    let p = proposals.clone();
    let read = RouteDef::get("/api/forge/proposals/{id}", move |req: Request| {
        let p = p.clone();
        async move { Ok(Response::json(200, &p.state(&run_of(&req)).await?.1)) }
    });
    let p = proposals.clone();
    let live = RouteDef::post("/api/forge/proposals/{id}/live-test", move |req: Request| {
        let p = p.clone();
        async move {
            let body: LiveTestStart = req.parse()?;
            Ok(Response::json(200, &p.live_test(&run_of(&req), body.settings).await?))
        }
    });
    let p = proposals.clone();
    let answer = RouteDef::post("/api/forge/proposals/{id}/answer", move |req: Request| {
        let p = p.clone();
        async move {
            let body: ProposalAnswer = req.parse()?;
            Ok(Response::json(200, &p.answer(&run_of(&req), body.choice).await?))
        }
    });
    // Starting agents that build code, reaching the user for real and
    // installing code are this computer's dashboard's alone.
    vec![
        start.access(Access::ui_token().local_only()),
        read.access(Access::ui_token()),
        live.access(Access::ui_token().local_only()),
        answer.access(Access::ui_token().local_only()),
    ]
}
