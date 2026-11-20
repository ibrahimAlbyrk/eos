//! The gate a checked result passes (01 §4.9, 03 §4.8), called inside the
//! run's own write job so the decision, the run's state and its event
//! commit together.

use std::sync::Arc;

use eos_core::Error;
use eos_core::routine::{GateDecision, GateInput, GateMode};
use eos_core::store::{Outbox, RunMove, StoredRun, Tx};
use eos_domain::routine::numbers::Outcome;
use eos_domain::routine::run::{Reason, RunState, Station};
use serde_json::json;

use super::check::{NOTHING, result_doc};
use super::control::confirmed_in;
use super::{Engine, failures, move_run};
use crate::routes::readable;

/// Hands the passed result of `run` to the gate and moves the run by its
/// decision. A result with nothing to send skips the gate (01 G20).
pub(crate) fn hand_over(
    engine: &Arc<Engine>,
    tx: &dyn Tx,
    out: &mut Outbox,
    run: &StoredRun,
    now: i64,
) -> Result<(), Error> {
    let result = tx.run_results().by_run(&run.id)?.into_iter().find(|r| r.attempt == run.attempt);
    let result = result.ok_or_else(|| Error::not_found("run result", run.id.clone()))?;
    if result.kind == NOTHING {
        return done(engine, tx, out, run, Outcome::Nothing, now);
    }
    let input = gate_input(tx, run, &result)?;
    let decision = engine.gate.apply_in(tx, out, now, engine.ids.as_ref(), &input)?;
    let at = |state, station, reason| RunMove { state, station: Some(station), reason, at: now };
    match decision {
        GateDecision::Shown => done(engine, tx, out, run, Outcome::Shown, now),
        GateDecision::Held { item_id } => {
            tx.runs().append_event(&run.id, now, "held", Some(&json!({"itemId": item_id}).to_string()))?;
            move_run(tx, out, run, at(RunState::WaitingForUser, Station::Gate, None)).map(drop)
        }
        GateDecision::Delivering { delivery_ids } => {
            let data = json!({"deliveries": delivery_ids.len()}).to_string();
            tx.runs().append_event(&run.id, now, "delivering", Some(&data))?;
            move_run(tx, out, run, at(RunState::Delivering, Station::Deliver, None)).map(drop)
        }
        GateDecision::Refused => {
            move_run(tx, out, run, at(RunState::Failed, Station::Gate, Some(Reason::Delivery)))?;
            failures::ended_in(engine, tx, out, &run.id, now)
        }
    }
}

pub(crate) fn done(
    engine: &Arc<Engine>,
    tx: &dyn Tx,
    out: &mut Outbox,
    run: &StoredRun,
    outcome: Outcome,
    now: i64,
) -> Result<(), Error> {
    tx.runs().set_outcome(&run.id, outcome)?;
    let done = RunMove { state: RunState::Done, station: run.station, reason: None, at: now };
    move_run(tx, out, run, done)?;
    failures::ended_in(engine, tx, out, &run.id, now)
}

fn gate_input(tx: &dyn Tx, run: &StoredRun, result: &eos_core::store::StoredRunResult) -> Result<GateInput, Error> {
    let version_id = run.version_id.clone().unwrap_or_default();
    let version = tx.routine_versions().find(&run.routine_id, &version_id)?;
    let version = version.ok_or_else(|| Error::not_found("version", version_id.clone()))?;
    let blueprint = readable(&version)?.ok_or_else(|| Error::not_found("blueprint", version_id.clone()))?;
    let input: eos_contracts::RunInput =
        serde_json::from_str(&run.input).map_err(|_| Error::storage(format!("run {} has no input", run.id)))?;
    let (freedom_confirmed, goes_to_confirmed) = match confirmed_in(tx, &run.routine_id) {
        Ok(confirmed) => (Some(confirmed.freedom), confirmed.goes_to),
        Err(Error::NotFound { .. }) => (None, Vec::new()),
        Err(error) => return Err(error),
    };
    let trial = run.kind == "trial";
    let result_mode = match (run.kind.as_str(), input.result) {
        ("trial", _) => GateMode::Trial,
        (_, eos_contracts::ResultMode::ShowOnly) => GateMode::ShowOnly,
        (_, eos_contracts::ResultMode::Ask) => GateMode::Ask,
        (_, eos_contracts::ResultMode::Usual) => GateMode::AsUsual,
    };
    Ok(GateInput {
        run_id: run.id.clone(),
        routine_id: run.routine_id.clone(),
        version: version_id,
        origin: run.origin.clone(),
        result_mode,
        doc: result_doc(result),
        // A trial sends nothing anywhere (03 G21).
        targets: if trial { Vec::new() } else { blueprint.goes_to },
        item_facts: serde_json::to_value(&input.item).unwrap_or_default(),
        subject_key: run.item_key.clone(),
        trust: eos_domain::routine::trust::of_run(Some(version.trust), &input),
        freedom_confirmed,
        goes_to_confirmed,
    })
}
