//! `GET /api/signals/summary?since=`: what signals did since a time, for
//! every routine and by routine; since the start of the user's day when
//! `since` is left out. A routine another computer holds adds what that
//! computer's heartbeat counted.

use std::sync::Arc;

use eos_contracts::{SignalCounts, SignalSummary};
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;

use super::Routes;
use crate::summary::{counts_in, day_start, elsewhere_since, sum};

pub(super) fn route(routes: &Arc<Routes>) -> RouteDef {
    let routes = routes.clone();
    RouteDef::get("/api/signals/summary", move |req: Request| {
        let routes = routes.clone();
        async move {
            let since = match req.query().get("since") {
                Some(text) => text.parse::<i64>().map_err(|_| ApiError::Validation("invalid request: since".into()))?,
                None => day_start(routes.zone.as_ref(), routes.clock.now_ms()),
            };
            let routines = routes.directory.triggers().await?;
            let elsewhere: Vec<SignalCounts> = routines
                .iter()
                .map(|routine| {
                    routes
                        .runner
                        .hourly_elsewhere(&routine.id)
                        .map_or_else(SignalCounts::default, |(seen_at, hourly)| {
                            elsewhere_since(seen_at, &hourly, since)
                        })
                })
                .collect();
            let summary = routes
                .store
                .read(move |tx| {
                    let mut counts = SignalCounts::default();
                    let mut by_routine = Vec::with_capacity(routines.len());
                    for (routine, elsewhere) in routines.iter().zip(elsewhere) {
                        let of_routine = sum(counts_in(tx, &routine.id, since)?, elsewhere);
                        counts = sum(counts, of_routine);
                        by_routine.push((routine.id.clone(), of_routine));
                    }
                    Ok(SignalSummary { since, counts, by_routine: by_routine.into_iter().collect() })
                })
                .await?;
            Ok(Response::json(200, &summary))
        }
    })
    .access(Access::ui_token().phone_user(Tier::Read))
}
