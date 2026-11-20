//! "Stop everything" on this Mac (03 G10): `GET /api/eos/halt` reads the
//! switch, `POST /api/eos/halt` switches it on and `POST /api/eos/resume`
//! off. Each answers the switch as it is then (`HaltState`). Stopping is
//! easy from the phone; resuming needs its highest tier.

use std::sync::Arc;

use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;

use super::answered_by;
use crate::Shared;

pub(super) fn all(shared: &Arc<Shared>) -> Vec<RouteDef> {
    let at = shared.clone();
    let read = RouteDef::get("/api/eos/halt", move |_: Request| {
        let at = at.clone();
        async move { Ok::<_, ApiError>(Response::json(200, &at.items.halt_state().await?)) }
    });
    let at = shared.clone();
    let halt = RouteDef::post("/api/eos/halt", move |req: Request| {
        let at = at.clone();
        async move { Ok::<_, ApiError>(Response::json(200, &at.items.halt(answered_by(&req.caller)).await?)) }
    });
    let at = shared.clone();
    let resume = RouteDef::post("/api/eos/resume", move |req: Request| {
        let at = at.clone();
        async move { Ok::<_, ApiError>(Response::json(200, &at.items.resume(answered_by(&req.caller)).await?)) }
    });
    let user = |tier| Access::ui_token().phone_user(tier);
    vec![read.access(Access::open().phone(Tier::Read)), halt.access(user(Tier::Low)), resume.access(user(Tier::High))]
}
