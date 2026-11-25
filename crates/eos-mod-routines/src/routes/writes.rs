//! A routine's life by hand: its state, Recently deleted and back, a
//! one-off kept, each answering the routine's row as it is after the write;
//! and its blueprint: made by hand, a new version kept, an old one brought
//! back, a copy, each answering the row, the version it wrote and the
//! warnings it was kept with (a blueprint its rules refuse answers 400 with
//! every finding).

use std::sync::Arc;

use eos_contracts::{
    BlueprintRefused, CopyRoutineRequest, CreateRoutineRequest, KeepVersionRequest, RoutineStateRequest, VersionAuthor,
};
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{Request, Response};
use eos_runtime::router::RouteDef;

use super::{param, refusal};
use crate::engine::{self, Edit, Engine, Saved};

fn answer(saved: Saved, created: bool) -> Response {
    match saved {
        Saved::Done(saved) => Response::json(if created { 201 } else { 200 }, &saved),
        Saved::Refused(issues) => {
            Response::json(400, &BlueprintRefused { error: "the blueprint does not meet its rules".into(), issues })
        }
    }
}

fn blueprint_routes(engine: &Arc<Engine>) -> Vec<RouteDef> {
    let creating = engine.clone();
    let create = RouteDef::post("/api/routines", move |req: Request| {
        let engine = creating.clone();
        async move {
            let body: CreateRoutineRequest = req.parse()?;
            Ok(answer(engine::create(&engine, body.blueprint, body.note, "hand", VersionAuthor::User).await?, true))
        }
    });
    let keeping = engine.clone();
    let blueprint = RouteDef::put("/api/routines/{id}/blueprint", move |req: Request| {
        let engine = keeping.clone();
        async move {
            let body: KeepVersionRequest = req.parse()?;
            let edit = Edit {
                base: Some(body.base_version_id),
                value: body.blueprint,
                note: body.note,
                author: VersionAuthor::User,
            };
            Ok(answer(engine::save(&engine, &param(&req, "id"), edit).await.map_err(refusal)?, false))
        }
    });
    let restoring = engine.clone();
    let restore = RouteDef::post("/api/routines/{id}/versions/{versionId}/restore", move |req: Request| {
        let engine = restoring.clone();
        async move {
            let saved =
                engine::restore(&engine, &param(&req, "id"), &param(&req, "versionId")).await.map_err(refusal)?;
            Ok(answer(saved, false))
        }
    });
    let copying = engine.clone();
    let copy = RouteDef::post("/api/routines/{id}/copy", move |req: Request| {
        let engine = copying.clone();
        async move {
            let body: CopyRoutineRequest = req.parse()?;
            Ok(answer(engine::copy(&engine, &param(&req, "id"), body.brief).await?, true))
        }
    });
    [create, blueprint, restore, copy].into_iter().map(|route| route.access(Access::ui_token())).collect()
}

pub(crate) fn all(engine: &Arc<Engine>) -> Vec<RouteDef> {
    let setting = engine.clone();
    let state = RouteDef::put("/api/routines/{id}/state", move |req: Request| {
        let engine = setting.clone();
        async move {
            let body: RoutineStateRequest = req.parse()?;
            match engine::set_state(&engine, &param(&req, "id"), body.state).await? {
                Ok(row) => Ok(Response::json(200, &row)),
                Err(refusal) => Ok(Response::json(409, &refusal.answer())),
            }
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
        async move { Ok(Response::json(200, &engine::keep(&engine, &param(&req, "id")).await.map_err(refusal)?)) }
    });
    let mut routes = blueprint_routes(engine);
    routes.extend([
        // The user's phone may pause and resume a routine.
        state.access(Access::ui_token().phone_user(Tier::Low)),
        delete.access(Access::ui_token()),
        undelete.access(Access::ui_token()),
        keep.access(Access::ui_token()),
    ]);
    routes
}
