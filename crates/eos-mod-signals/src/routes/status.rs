//! `GET /api/signals/routines/:routineId`: who acts on a routine's
//! triggers, each schedule with its next time, each source's state, the
//! open batch, and the signals counted today and over seven days; and
//! `GET /api/signals/routines`: when every routine runs next, in one read.

use std::sync::Arc;

use eos_contracts::{
    OpenBatch, RoutineHolder, RoutineNext, RoutineTriggerStatus, Schedule, ScheduleStatus, SourceStatus, Trigger,
};
use eos_core::Error;
use eos_core::os::ZoneRules;
use eos_core::signals::{Holder, Runner};
use eos_core::store::{StoredSignalSource, Tx};
use eos_domain::signals::key::capability_scope;
use eos_domain::signals::schedule::next_slot;
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{Request, Response};
use eos_runtime::router::RouteDef;

use super::Routes;
use crate::summary::{DAY_MS, counts_in, day_start};

const MINUTE_MS: i64 = 60_000;

pub(super) fn route(routes: &Arc<Routes>) -> RouteDef {
    let routes = routes.clone();
    RouteDef::get("/api/signals/routines/{routineId}", move |req: Request| {
        let routes = routes.clone();
        async move {
            let routine = routes.routine(req.param("routineId").unwrap_or_default()).await?;
            let push_routes = routes.clone();
            let now = routes.clock.now_ms();
            let today = day_start(routes.zone.as_ref(), now);
            let zones = routes.zones.clone();
            let holder = holder(routes.runner.as_ref(), &routine.id);
            let status = routes
                .store
                .read(move |tx| {
                    let stored = tx.signal_schedules().of_routine(&routine.id)?;
                    let mut schedules = Vec::new();
                    let mut sources = Vec::new();
                    for (slot, trigger) in routine.when.on.iter().enumerate() {
                        match trigger {
                            Trigger::Schedule { schedule, .. } => {
                                let slot = slot as i64;
                                let row = stored.iter().find(|row| row.slot == slot);
                                let mut status = schedule_status(zones.as_ref(), schedule, slot, now);
                                if let Some(row) = row {
                                    status.next_at = row.next_at.or(status.next_at);
                                    status.last_at = row.last_slot_at;
                                    status.late_by_ms = row.late_by_ms;
                                    status.missed = row.missed;
                                }
                                schedules.push(status);
                            }
                            Trigger::Source { source, scope, .. } => {
                                let (_, scope_hash) = capability_scope(source, scope);
                                if let Some(row) = tx.signal_sources().by_scope(&scope_hash)? {
                                    let push = push_state(&push_routes, tx, &row)?;
                                    sources.push(source_status(row, push));
                                }
                            }
                            _ => {}
                        }
                    }
                    let batch = match &routine.when.batch {
                        Some(batch) => {
                            let open = tx.signal_routes().open_batch(&routine.id)?;
                            open.first().map(|first| OpenBatch {
                                items: open.len() as i64,
                                opened_at: first.decided_at,
                                closes_at: first.decided_at + batch.wait_minutes * MINUTE_MS,
                            })
                        }
                        None => None,
                    };
                    Ok(RoutineTriggerStatus {
                        routine_id: routine.id.clone(),
                        holder,
                        schedules,
                        sources,
                        batch,
                        counts_today: counts_in(tx, &routine.id, today)?,
                        counts7d: counts_in(tx, &routine.id, now - 7 * DAY_MS)?,
                    })
                })
                .await?;
            Ok(Response::json(200, &status))
        }
    })
    .access(Access::ui_token().phone_user(Tier::Read))
}

/// `GET /api/signals/routines`: each routine's next slot, who holds it and
/// whether every source it reads is `active`.
pub(super) fn every(routes: &Arc<Routes>) -> RouteDef {
    let routes = routes.clone();
    RouteDef::get("/api/signals/routines", move |_req: Request| {
        let routes = routes.clone();
        async move {
            let routines = routes.directory.triggers().await?;
            let now = routes.clock.now_ms();
            let holders: Vec<Option<String>> = routines
                .iter()
                .map(|routine| holder(routes.runner.as_ref(), &routine.id).map(|holder| holder.device_id))
                .collect();
            let zones = routes.zones.clone();
            let rows = routes
                .store
                .read(move |tx| {
                    let mut rows = Vec::with_capacity(routines.len());
                    for (routine, holder) in routines.iter().zip(holders) {
                        let stored = tx.signal_schedules().of_routine(&routine.id)?;
                        let mut next = None::<i64>;
                        let mut sources_ok = true;
                        for (slot, trigger) in routine.when.on.iter().enumerate() {
                            match trigger {
                                Trigger::Schedule { schedule, .. } => {
                                    let row = stored.iter().find(|row| row.slot == slot as i64);
                                    let at = row
                                        .and_then(|row| row.next_at)
                                        .or_else(|| next_at(zones.as_ref(), schedule, now));
                                    next = match (next, at) {
                                        (Some(a), Some(b)) => Some(a.min(b)),
                                        (a, b) => a.or(b),
                                    };
                                }
                                Trigger::Source { source, scope, .. } => {
                                    let (_, scope_hash) = capability_scope(source, scope);
                                    let row = tx.signal_sources().by_scope(&scope_hash)?;
                                    sources_ok &= row.is_none_or(|row| row.state == "active");
                                }
                                _ => {}
                            }
                        }
                        rows.push(RoutineNext { routine_id: routine.id.clone(), next_at: next, holder, sources_ok });
                    }
                    Ok(rows)
                })
                .await?;
            Ok(Response::json(200, &rows))
        }
    })
    .access(Access::ui_token().phone_user(Tier::Read))
}

/// Who acts on the routine's triggers, as this computer last knew.
pub(super) fn holder(runner: &dyn Runner, routine_id: &str) -> Option<RoutineHolder> {
    let (device_id, here) = match runner.holder(routine_id) {
        Holder::Here { .. } => (runner.device_id().to_owned(), true),
        Holder::Elsewhere { device_id, .. } => (device_id, false),
        Holder::Unknown => return None,
    };
    Some(RoutineHolder { device_id, name: None, here, away_since: None })
}

/// A schedule's next slot after `now`, on its zone's clock; none for a zone
/// this computer does not know.
pub(super) fn next_at(zones: &dyn ZoneRules, schedule: &Schedule, now: i64) -> Option<i64> {
    if !zones.known(&schedule.zone) {
        return None;
    }
    let offset_at = |at: i64| zones.offset_minutes_at(&schedule.zone, at).unwrap_or(0);
    next_slot(&schedule.repeat, now, &offset_at)
}

/// A schedule no scheduler has written a row for yet.
fn schedule_status(zones: &dyn ZoneRules, schedule: &Schedule, slot: i64, now: i64) -> ScheduleStatus {
    ScheduleStatus {
        slot,
        next_at: next_at(zones, schedule, now),
        last_at: None,
        late_by_ms: 0,
        missed: 0,
        zone: schedule.zone.clone(),
        zone_differs: schedule.zone != zones.local_name(),
    }
}

/// Whether the source's service pushes (`on`), could push through this
/// computer's hook inbox (`off`), or cannot (none).
pub(super) fn push_state(routes: &Routes, tx: &dyn Tx, row: &StoredSignalSource) -> Result<Option<String>, Error> {
    let pushes = row.source.as_deref().and_then(|name| routes.sources.get(name)).is_some_and(|source| source.pushes());
    if !pushes || routes.push.is_none() {
        return Ok(None);
    }
    let on = tx.signal_hooks().hooked()?.contains(&row.id);
    Ok(Some(if on { "on" } else { "off" }.to_owned()))
}

pub(super) fn source_status(row: StoredSignalSource, push: Option<String>) -> SourceStatus {
    SourceStatus {
        source_id: row.id,
        kind: row.kind,
        source: row.source,
        state: row.state,
        error_kind: row.error_kind,
        last_poll_at: row.last_poll_at,
        next_poll_at: row.next_poll_at,
        last_signal_at: row.last_signal_at,
        catch_up: row.catch_up_json.as_deref().and_then(|json| serde_json::from_str(json).ok()),
        push,
    }
}
