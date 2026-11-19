//! `POST /api/signals/replay {routineId, signalIds}`: decides signals of one
//! routine again as if they had just come, past its Which: each is admitted
//! through `RunIntake`, so the routine's limits apply. A signal that started
//! a run already is refused (409), and so is the whole replay; one the
//! routine never decided is not found. Off the network the router never
//! admits by itself, but a replay the dev guard let through does.

use std::sync::Arc;

use eos_contracts::{ReplayRequest, SignalChange, SignalChangeWhat};
use eos_core::Error;
use eos_core::store::StoredSignalRoute;
use eos_domain::signals::decision::Decision;
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{Request, Response};
use eos_runtime::router::RouteDef;

use super::{Routes, decision};
use crate::SIGNALS_CHANGE;
use crate::limits::stale_in;
use crate::router::run_in;

pub(super) fn route(routes: &Arc<Routes>) -> RouteDef {
    let routes = routes.clone();
    RouteDef::post("/api/signals/replay", move |req: Request| {
        let routes = routes.clone();
        async move {
            let asked: ReplayRequest = req.parse()?;
            let routine = routes.routine(&asked.routine_id).await?;
            let mut ids = asked.signal_ids;
            ids.sort_unstable();
            ids.dedup();
            let (intake, now) = (routes.intake.clone(), routes.clock.now_ms());
            let decided = routes
                .store
                .write(move |tx, out| {
                    let mut decided = Vec::with_capacity(ids.len());
                    for id in ids {
                        let signal =
                            tx.signals().find(id)?.ok_or_else(|| Error::not_found("signal", id.to_string()))?;
                        let before =
                            tx.signal_routes().by_signal(id)?.into_iter().find(|route| route.routine_id == routine.id);
                        let before = before.ok_or_else(|| Error::not_found("signal", id.to_string()))?;
                        if before.decision == Decision::Run {
                            return Err(Error::Conflict(format!("signal {id} started a run already")));
                        }
                        let stale = stale_in(tx, &routine.id, &signal.signal.subject)?;
                        let (decision, reason, run_id) =
                            run_in(tx, out, intake.as_ref(), &routine, &signal, now, &stale)?;
                        let route = StoredSignalRoute {
                            signal_id: id,
                            routine_id: routine.id.clone(),
                            routine_version: routine.version.clone(),
                            decision,
                            reason,
                            run_id,
                            model_asked: false,
                            decided_at: now,
                        };
                        tx.signal_routes().put(&route)?;
                        decided.push(route);
                    }
                    let change = SignalChange {
                        routine_id: Some(routine.id.clone()),
                        source_id: None,
                        what: SignalChangeWhat::Routed,
                    };
                    out.push(SIGNALS_CHANGE.name(), &change);
                    Ok(decided)
                })
                .await?;
            let runs = decided.iter().filter(|route| route.decision == Decision::Run).count();
            tracing::info!(signals = decided.len(), runs, "signals were replayed");
            Ok(Response::json(200, &decided.iter().map(decision).collect::<Vec<_>>()))
        }
    })
    .access(Access::ui_token().phone_user(Tier::High))
}
