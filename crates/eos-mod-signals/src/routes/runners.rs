//! `GET /api/runners` (the user's computers as the leases show them, with
//! the ones away for two hours) and `POST /api/runners/claim` (Move here:
//! the routine is held here from now on and takes up where the computer
//! before left it). Nothing moves by itself (D19).

use std::sync::Arc;

use eos_contracts::Trigger;
use eos_contracts::{ClaimRequest, ClaimResponse, RunnerDevice, RunnerView};
use eos_core::routine::RoutineTriggers;
use eos_core::signals::{Runner, RunnerError};
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;

use super::Routes;
use crate::moves::{AWAY_MS, take_over_in};

/// When the computer's last heartbeat came, once it is older than [`AWAY_MS`].
pub(crate) fn away_since(seen_at: i64, now: i64) -> Option<i64> {
    (now - seen_at >= AWAY_MS).then_some(seen_at)
}

pub(crate) fn view(runner: &dyn Runner, now: i64) -> RunnerView {
    let devices = runner
        .devices()
        .into_iter()
        .map(|device| RunnerDevice {
            away_since: away_since(device.seen_at, now),
            device_id: device.device_id,
            name: device.name,
            seen_at: device.seen_at,
            routines: device.routines,
        })
        .collect();
    RunnerView { device_id: runner.device_id().to_owned(), devices, confirmed_at: runner.confirmed_at() }
}

/// The capability of the first of the routine's sources this computer has
/// no source for (`github` for `github.pulls`).
fn missing_source(routes: &Routes, routine: &RoutineTriggers) -> Option<String> {
    routine.when.on.iter().find_map(|trigger| match trigger {
        Trigger::Source { source, .. } if routes.sources.get(source).is_none() => {
            Some(source.split('.').next().unwrap_or(source).to_owned())
        }
        _ => None,
    })
}

pub(super) fn list(routes: &Arc<Routes>) -> RouteDef {
    let routes = routes.clone();
    RouteDef::get("/api/runners", move |_req: Request| {
        let routes = routes.clone();
        async move { Ok(Response::json(200, &view(routes.runner.as_ref(), routes.clock.now_ms()))) }
    })
    .access(Access::ui_token().phone_user(Tier::Read))
}

pub(super) fn claim(routes: &Arc<Routes>) -> RouteDef {
    let routes = routes.clone();
    RouteDef::post("/api/runners/claim", move |req: Request| {
        let routes = routes.clone();
        async move {
            let ClaimRequest { routine_id } = req.parse()?;
            let routine = routes.routine(&routine_id).await?;
            // A source this computer cannot read would leave the routine deaf here.
            if let Some(missing) = missing_source(&routes, &routine) {
                return Err(ApiError::Conflict(format!("Connect {missing} on this Mac first")));
            }
            let handoff = match routes.runner.claim(&routine_id).await {
                Ok(handoff) => handoff,
                Err(RunnerError::Lost { holder, epoch }) => {
                    let lost = ClaimResponse { routine_id, claimed: false, holder, epoch };
                    return Ok(Response::json(200, &lost));
                }
                Err(RunnerError::Missing { capability }) => {
                    return Err(ApiError::Conflict(format!("Connect {capability} on this Mac first")));
                }
                Err(RunnerError::Unreachable) => {
                    return Err(ApiError::Unreachable("the sync vault could not be reached".into()));
                }
                Err(RunnerError::Off) => {
                    return Err(ApiError::Unreachable(
                        "sync is not open on this Mac: a routine moves here only through it".into(),
                    ));
                }
            };
            let (routing, ids, taken) = (routes.router.routing(), routes.ids.clone(), routine.clone());
            let marks = handoff.watermarks.clone();
            let decided = routes
                .store
                .write(move |tx, out| take_over_in(tx, out, &routing, ids.as_ref(), &taken, marks.as_ref()))
                .await?;
            tracing::info!(routine_id, epoch = handoff.epoch, decided, "a routine moved here");
            routes.kick.notify_one();
            let device = routes.runner.device_id().to_owned();
            Ok(Response::json(200, &ClaimResponse { routine_id, claimed: true, holder: device, epoch: handoff.epoch }))
        }
    })
    .access(Access::ui_token().phone_user(Tier::High))
}
