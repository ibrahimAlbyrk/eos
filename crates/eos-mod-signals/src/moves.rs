//! Moving a routine between the user's computers (02 §3 F.32–33): each
//! computer's heartbeat carries, per routine it holds, how far it got (its
//! watermarks) and its hourly counts; Move here starts the routine's
//! sources from the away computer's cursors, its schedules from their last
//! slots (a missed one fires once), and decides again this computer's own
//! `elsewhere` signals for it that the away computer never saw.

use std::collections::HashSet;

use eos_contracts::Trigger;
use eos_core::routine::RoutineTriggers;
use eos_core::signals::{DeviceReport, HeldRoutine};
use eos_core::store::{Outbox, StoredSignalSchedule, Tx};
use eos_core::{Error, Ids};
use eos_domain::routine::blueprint::hash;
use eos_domain::signals::decision::Decision;
use eos_domain::signals::key::capability_scope;
use serde_json::{Map, Value, json};

use crate::router::Routing;
use crate::sources::{SourceSpec, source_in};

/// How often a computer writes its heartbeat.
pub(crate) const HEARTBEAT_MS: i64 = 10 * 60_000;
/// A computer whose last heartbeat is older shows as away.
pub const AWAY_MS: i64 = 2 * 60 * 60_000;
/// The newest signal keys a heartbeat carries per routine.
const LAST_KEYS: i64 = 50;
/// The `elsewhere` signals a move decides again, at most.
const REROUTE_MAX: i64 = 200;
const HOUR_MS: i64 = 60 * 60_000;

const CAPABILITY: &str = "capability";

/// The routine's capability sources here: their source, scope and hash.
fn sources_of(routine: &RoutineTriggers) -> Vec<(String, String, String)> {
    routine
        .when
        .on
        .iter()
        .filter_map(|trigger| match trigger {
            Trigger::Source { source, scope, .. } => {
                let (scope_json, scope_hash) = capability_scope(source, scope);
                Some((source.clone(), scope_json, scope_hash))
            }
            _ => None,
        })
        .collect()
}

/// How far this computer got on `routine`: each source's cursor by its
/// scope (the same on every computer), each schedule's last slot, and the
/// keys of its newest signals.
pub(crate) fn watermarks_in(tx: &dyn Tx, routine: &RoutineTriggers) -> Result<Value, Error> {
    let mut sources = Map::new();
    for (_, _, scope_hash) in sources_of(routine) {
        let source = tx.signal_sources().by_scope(&scope_hash)?;
        if let Some(cursor) = source.and_then(|s| s.cursor_json).and_then(|c| serde_json::from_str::<Value>(&c).ok()) {
            sources.insert(scope_hash, cursor);
        }
    }
    let schedules: Map<String, Value> = tx
        .signal_schedules()
        .of_routine(&routine.id)?
        .into_iter()
        .filter_map(|row| Some((row.slot.to_string(), json!(row.last_slot_at?))))
        .collect();
    let keys: Vec<String> =
        tx.signals().page(Some(&routine.id), None, None, LAST_KEYS)?.into_iter().map(|s| s.signal.key).collect();
    Ok(json!({"sources": sources, "schedules": schedules, "keys": keys}))
}

/// Runs started for the routine in each of the last 24 hours, the newest last.
pub(crate) fn hourly_in(tx: &dyn Tx, routine_id: &str, now: i64) -> Result<Vec<i64>, Error> {
    let mut since: Vec<i64> = Vec::with_capacity(25);
    for hours in (0..=24).rev() {
        since.push(tx.signal_routes().count_since(routine_id, Decision::Run, now - hours * HOUR_MS)?);
    }
    Ok(since.windows(2).map(|pair| pair[0] - pair[1]).collect())
}

/// This computer's heartbeat over the routines it holds, each at `epoch`.
pub(crate) fn report_in(tx: &dyn Tx, held: &[(RoutineTriggers, i64)], now: i64) -> Result<DeviceReport, Error> {
    let mut holds = Vec::with_capacity(held.len());
    for (routine, epoch) in held {
        holds.push(HeldRoutine {
            routine_id: routine.id.clone(),
            epoch: *epoch,
            watermarks: watermarks_in(tx, routine)?,
            counts: hourly_in(tx, &routine.id, now)?,
        });
    }
    Ok(DeviceReport { name: String::new(), seen_at: now, holds })
}

/// Takes `routine` up where the away computer left it (`marks`, its
/// watermarks; none when it never reported): answers how many `elsewhere`
/// signals were decided again.
pub(crate) fn take_over_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    routing: &Routing,
    ids: &dyn Ids,
    routine: &RoutineTriggers,
    marks: Option<&Value>,
) -> Result<usize, Error> {
    let now = routing.now;
    if let Some(marks) = marks {
        for (source, scope_json, scope_hash) in sources_of(routine) {
            let Some(cursor) = marks["sources"].get(&scope_hash) else { continue };
            let spec =
                SourceSpec { kind: CAPABILITY, source: Some(&source), scope_json, scope_hash, interval_ms: 60_000 };
            let (row, _) = source_in(tx, ids, spec, now)?;
            let row = eos_core::store::StoredSignalSource {
                cursor_json: Some(cursor.to_string()),
                next_poll_at: Some(now),
                updated_at: now,
                ..row
            };
            tx.signal_sources().update(&row)?;
        }
        let rows = tx.signal_schedules().of_routine(&routine.id)?;
        for (slot, trigger) in routine.when.on.iter().enumerate() {
            let Trigger::Schedule { schedule, .. } = trigger else { continue };
            let Some(last) = marks["schedules"].get(slot.to_string()).and_then(Value::as_i64) else { continue };
            let earlier = rows.iter().find(|row| row.slot == slot as i64);
            if earlier.and_then(|row| row.last_slot_at).is_some_and(|here| here >= last) {
                continue;
            }
            // Armed from the away computer's last slot: the latest one missed since fires once.
            tx.signal_schedules().put(&StoredSignalSchedule {
                routine_id: routine.id.clone(),
                slot: slot as i64,
                spec_hash: hash(&serde_json::to_string(schedule).unwrap_or_default()),
                zone: schedule.zone.clone(),
                armed_at: last,
                last_slot_at: Some(last),
                next_at: None,
                missed: earlier.map_or(0, |row| row.missed),
                late_by_ms: 0,
                updated_at: now,
            })?;
        }
    }
    let seen: HashSet<&str> = marks
        .and_then(|marks| marks["keys"].as_array())
        .map(|keys| keys.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let mut decided = 0;
    for signal in tx.signals().page(Some(&routine.id), Some(Decision::Elsewhere), None, REROUTE_MAX)? {
        if seen.contains(signal.signal.key.as_str()) {
            continue;
        }
        routing.decide_again_in(tx, out, routine, &signal)?;
        decided += 1;
    }
    Ok(decided)
}
