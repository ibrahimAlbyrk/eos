//! A routine's life by hand: its state, Recently deleted and back, a
//! one-off kept. Each answers the routine's row as it is after the write.

use std::sync::Arc;

use eos_contracts::RoutineStateRequest;
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{Request, Response};
use eos_runtime::router::RouteDef;

use super::param;
use crate::engine::{self, Engine};

pub(crate) fn all(engine: &Arc<Engine>) -> Vec<RouteDef> {
    let setting = engine.clone();
    let state = RouteDef::put("/api/routines/{id}/state", move |req: Request| {
        let engine = setting.clone();
        async move {
            let body: RoutineStateRequest = req.parse()?;
            let row = engine::set_state(&engine, &param(&req, "id"), body.state).await?;
            Ok(Response::json(200, &row))
        }
    });
    let deleting = engine.clone();
    let delete = RouteDef::delete("/api/routines/{id}", move |req: Request| {
        let engine = deleting.clone();
        async move { Ok(Response::json(200, &engine::delete(&engine, &param(&req, "id")).await?)) }
    });
    let restoring = engine.clone();
    let undelete = RouteDef::post("/api/routines/{id}/undelete", move |req: Request| {
        let engine = restoring.clone();
        async move { Ok(Response::json(200, &engine::undelete(&engine, &param(&req, "id")).await?)) }
    });
    let keeping = engine.clone();
    let keep = RouteDef::post("/api/routines/{id}/keep", move |req: Request| {
        let engine = keeping.clone();
        async move { Ok(Response::json(200, &engine::keep(&engine, &param(&req, "id")).await?)) }
    });
    vec![
        // The user's phone may pause and resume a routine.
        state.access(Access::ui_token().phone_user(Tier::Low)),
        delete.access(Access::ui_token()),
        undelete.access(Access::ui_token()),
        keep.access(Access::ui_token()),
    ]
}
