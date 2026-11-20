//! `GET /api/routines/:id/freedom` (03 §6): how far the routine's results go
//! without the user, as the user confirmed it, its streak and its offer.

use std::sync::Arc;

use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;

use super::item_id;
use crate::Shared;

pub(super) fn all(shared: &Arc<Shared>) -> Vec<RouteDef> {
    let at = shared.clone();
    let read = RouteDef::get("/api/routines/{id}/freedom", move |req: Request| {
        let at = at.clone();
        async move { Ok::<_, ApiError>(Response::json(200, &at.items.freedom(&item_id(&req)).await?)) }
    });
    vec![read.access(Access::ui_token().phone_user(Tier::Read))]
}
