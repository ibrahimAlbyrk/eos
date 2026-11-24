//! Starting runs by hand and steering them: `POST /api/runs` (several
//! items, later, again, a repeat the user confirmed), the history page, and
//! a run's message, stop, pause and resume.

use std::sync::Arc;

use eos_contracts::{
    OnceRequest, RunMessageRequest, RunPage, RunsActive, StartRunRequest, StartRunResponse, StartedRun,
};
use eos_core::Error;
use eos_core::routine::{NewRun, RunOrigin, RunStarter, StartError, Unready};
use eos_domain::routine::run::{Reason, RunState};
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use serde_json::{Value, json};

use super::{newer_format, param, run_summaries};
use crate::engine::{self, Engine};
use crate::once::OnceRefused;

/// The largest start body: up to twenty items of 64 KiB text each.
const START_MAX_BODY: usize = 2 * 1024 * 1024;
const PAGE_DEFAULT: i64 = 50;
const PAGE_MAX: i64 = 200;

/// Where the user may start a run (01 §4.4).
const DOORS: [&str; 15] = [
    "home",
    "field",
    "sidebar",
    "routine_page",
    "palette",
    "surface",
    "chat",
    "terminal",
    "link",
    "shortcut",
    "services",
    "share",
    "dock",
    "phone",
    "phone_share",
];

pub(crate) fn all(engine: &Arc<Engine>) -> Vec<RouteDef> {
    let runs: Arc<dyn RunStarter> = Arc::new(engine::Runs(engine.clone()));
    let starter = runs.clone();
    let start = RouteDef::post("/api/runs", move |req: Request| {
        let runs = starter.clone();
        async move {
            let mut asked: StartRunRequest = req.parse()?;
            if !DOORS.contains(&asked.door.as_str()) {
                return Err(ApiError::Validation(format!("invalid request: door: {} is no door", asked.door)));
            }
            super::outside::mark_start(&mut asked);
            let origin = match asked.again_of {
                Some(run_id) => RunOrigin::Again { run_id },
                None => RunOrigin::Hand,
            };
            let new = NewRun {
                routine_id: asked.routine_id,
                version: None,
                input: asked.input,
                items: asked.items.unwrap_or_default(),
                origin,
                door: Some(asked.door),
                confirm_repeat: asked.confirm_repeat.unwrap_or(false),
                client_request_id: asked.client_request_id,
            };
            match runs.start(new).await {
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
    })
    .max_body(START_MAX_BODY);

    let asking = engine.clone();
    let once = RouteDef::post("/api/runs/once", move |req: Request| {
        let engine = asking.clone();
        async move {
            let mut asked: OnceRequest = req.parse()?;
            if !DOORS.contains(&asked.door.as_str()) {
                return Err(ApiError::Validation(format!("invalid request: door: {} is no door", asked.door)));
            }
            super::outside::mark_once(&mut asked);
            match crate::once::start(&engine, asked).await {
                Ok(started) => Ok(Response::json(201, &started)),
                Err(OnceRefused::Start(refused)) => start_refused(refused),
                Err(OnceRefused::Unplanned(error)) => Err(error.into()),
            }
        }
    })
    .max_body(START_MAX_BODY);

    let store = engine.store.clone();
    let page = RouteDef::get("/api/runs", move |req: Request| {
        let store = store.clone();
        async move {
            let query = req.query();
            let routine = query.get("routineId").map(|id| id.into_owned());
            let state = match query.get("state") {
                Some(word) => Some(
                    RunState::parse(&word)
                        .ok_or_else(|| ApiError::Validation(format!("invalid request: state: {word}")))?,
                ),
                None => None,
            };
            let number = |name: &str| -> Result<Option<i64>, ApiError> {
                query
                    .get(name)
                    .map(|text| {
                        text.parse::<i64>().map_err(|_| ApiError::Validation(format!("invalid request: {name}")))
                    })
                    .transpose()
            };
            let before = number("before")?;
            let limit = number("limit")?.unwrap_or(PAGE_DEFAULT).clamp(1, PAGE_MAX);
            let runs = store
                .read(move |tx| run_summaries(tx, &tx.runs().page(routine.as_deref(), state, before, limit)?))
                .await?;
            let next_before = (runs.len() as i64 == limit).then(|| runs.last().map(|run| run.created_at)).flatten();
            Ok(Response::json(200, &RunPage { runs, next_before }))
        }
    });

    let store = engine.store.clone();
    // What `runs:active` says, for a screen that opens before its next event.
    let active = RouteDef::get("/api/runs/active", move |_req: Request| {
        let store = store.clone();
        async move {
            let (count, needs_user) = store.read(|tx| tx.runs().active()).await?;
            Ok(Response::json(200, &RunsActive { count, needs_user }))
        }
    });

    let steering = engine.clone();
    let message = RouteDef::post("/api/runs/{id}/message", move |req: Request| {
        let engine = steering.clone();
        async move {
            let asked: RunMessageRequest = req.parse()?;
            engine::message(&engine, &param(&req, "id"), &asked.text).await?;
            Ok(Response::json(200, &json!({"ok": true})))
        }
    });
    let stopper = runs.clone();
    let stop = RouteDef::post("/api/runs/{id}/stop", move |req: Request| {
        let runs = stopper.clone();
        async move {
            runs.stop(&param(&req, "id"), Reason::User).await?;
            Ok(Response::json(200, &json!({"ok": true})))
        }
    });
    let pausing = engine.clone();
    let pause = RouteDef::post("/api/runs/{id}/pause", move |req: Request| {
        let engine = pausing.clone();
        async move {
            engine::pause(&engine, &param(&req, "id")).await?;
            Ok(Response::json(200, &json!({"ok": true})))
        }
    });
    let resuming = engine.clone();
    let resume = RouteDef::post("/api/runs/{id}/resume", move |req: Request| {
        let engine = resuming.clone();
        async move {
            engine::resume(&engine, &param(&req, "id")).await?;
            Ok(Response::json(200, &json!({"ok": true})))
        }
    });
    let user = |tier| Access::ui_token().phone_user(tier);
    vec![
        start.access(user(Tier::High)),
        once.access(user(Tier::High)),
        page.access(user(Tier::Read)),
        // Two counts and no text of the user's.
        active.access(Access::open().phone(Tier::Read)),
        message.access(user(Tier::High)),
        stop.access(user(Tier::Low)),
        pause.access(user(Tier::Low)),
        resume.access(Access::ui_token()),
        super::numbers::summary_route(engine),
    ]
}

/// A refused start as its route answers it.
pub(crate) fn start_refused(refused: StartError) -> Result<Response, ApiError> {
    match refused {
        StartError::SameItem { existing_run_id } => Ok(Response::json(
            409,
            &json!({"error": "the routine handled this item lately", "existingRunId": existing_run_id}),
        )),
        StartError::RoutineState(state) => Ok(Response::json(
            409,
            &json!({"error": format!("a routine that is {} does not take this run", word(state))}),
        )),
        StartError::NewerFormat => Err(newer_format()),
        StartError::DayCap => Err(ApiError::coded(409, "routines spent today's budget", "day_cap")),
        StartError::Halted => Err(ApiError::coded(409, "Eos is stopped", "halted")),
        StartError::Unready(unready) => Ok(Response::json(409, &unready_body(&unready))),
        StartError::UnknownRoutine(id) => Err(Error::not_found("routine", id).into()),
        StartError::Invalid(text) => Err(ApiError::Validation(format!("invalid request: {text}"))),
        StartError::Store(error) => Err(error.into()),
    }
}

/// What is missing, with its stable code and the repository or capability
/// it names.
fn unready_body(unready: &Unready) -> Value {
    let mut body = json!({"error": unready.message(), "code": unready.code()});
    match unready {
        Unready::NoLocalClone { repo: Some(repo) } => body["repo"] = json!(repo),
        Unready::NoLocalClone { repo: None } => {}
        Unready::SignIn { capability } | Unready::Capability { capability } => body["capability"] = json!(capability),
    }
    body
}

fn word(state: eos_contracts::RoutineState) -> String {
    serde_json::to_value(state).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()
}
