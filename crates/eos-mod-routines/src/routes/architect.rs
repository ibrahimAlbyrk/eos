//! Making and changing a routine by talking to its architect: make one from
//! a sentence (`POST /api/routines/architect`), start its draft
//! (`…/:id/start`), ask for a change (`…/:id/change`), read or leave the
//! draft (`GET`, `DELETE …/:id/draft`), tell the architect something or
//! answer its question (`…/:id/draft/message`), and try the draft on real
//! past items (`…/:id/trial`). Only the user's dashboard calls them: an
//! architect's draft is kept only by the user's start.

use std::sync::Arc;

use eos_contracts::{
    ArchitectRequest, BlueprintRefused, ChangeRequest, DraftMessage, StartRoutineRequest, StartRunResponse, StartedRun,
};
use eos_runtime::access::Access;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;

use super::{param, refusal, start_refused};
use crate::architect::{self, Started};
use crate::engine::Engine;
use crate::trial;

pub(crate) fn all(engine: &Arc<Engine>) -> Vec<RouteDef> {
    let making = engine.clone();
    let make = RouteDef::post("/api/routines/architect", move |req: Request| {
        let engine = making.clone();
        async move {
            let body: ArchitectRequest = req.parse()?;
            let saved = architect::make(&engine, &body.sentence, &body.attachments).await?;
            Ok(Response::json(201, &saved))
        }
    });
    let starting = engine.clone();
    let start = RouteDef::post("/api/routines/{id}/start", move |req: Request| {
        let engine = starting.clone();
        async move {
            let body: StartRoutineRequest = req.parse()?;
            match architect::start(&engine, &param(&req, "id"), body.without_trial).await.map_err(refusal)? {
                Started::Kept(row) => Ok(Response::json(200, &*row)),
                Started::NeedsTrial => {
                    Err(ApiError::coded(409, "try the routine first, or start it without a trial", "trial_needed"))
                }
                Started::Refused(issues) => Ok(Response::json(
                    400,
                    &BlueprintRefused { error: "the blueprint does not meet its rules".into(), issues },
                )),
            }
        }
    });
    let changing = engine.clone();
    let change = RouteDef::post("/api/routines/{id}/change", move |req: Request| {
        let engine = changing.clone();
        async move {
            let body: ChangeRequest = req.parse()?;
            let view = architect::change(&engine, &param(&req, "id"), &body.text).await.map_err(refusal)?;
            Ok(Response::json(200, &view))
        }
    });
    let reading = engine.clone();
    let draft = RouteDef::get("/api/routines/{id}/draft", move |req: Request| {
        let engine = reading.clone();
        async move { Ok(Response::json(200, &architect::view(&engine, &param(&req, "id")).await?)) }
    });
    let leaving = engine.clone();
    let leave = RouteDef::delete("/api/routines/{id}/draft", move |req: Request| {
        let engine = leaving.clone();
        async move { Ok(Response::json(200, &architect::abandon(&engine, &param(&req, "id")).await?)) }
    });
    let telling = engine.clone();
    let message = RouteDef::post("/api/routines/{id}/draft/message", move |req: Request| {
        let engine = telling.clone();
        async move {
            let body: DraftMessage = req.parse()?;
            let text = body.text.or(body.choice).unwrap_or_default();
            Ok(Response::json(200, &architect::message(&engine, &param(&req, "id"), &text).await?))
        }
    });
    let trying = engine.clone();
    let trial = RouteDef::post("/api/routines/{id}/trial", move |req: Request| {
        let engine = trying.clone();
        async move {
            match trial::start(&engine, &param(&req, "id")).await {
                Ok(made) => {
                    let runs = made
                        .into_iter()
                        .map(|run| StartedRun {
                            id: run.id,
                            state: run.state.as_str().to_owned(),
                            not_before: run.not_before,
                        })
                        .collect();
                    Ok(Response::json(201, &StartRunResponse { runs }))
                }
                Err(refused) => start_refused(refused),
            }
        }
    });
    [make, start, change, draft, leave, message, trial]
        .into_iter()
        .map(|route| route.access(Access::ui_token()))
        .collect()
}
