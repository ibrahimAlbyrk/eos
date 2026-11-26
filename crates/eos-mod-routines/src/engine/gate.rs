//! The gate a handed-in result passes (01 §4.9, 03 §4.8), called inside the
//! run's own write job so the decision, the run's state and its event
//! commit together; and the gate an action of a run's agent that reaches
//! past this computer passes, by the same facts (D73).

use std::sync::Arc;

use eos_core::Error;
use eos_core::capability::{NO_GATE, RunAction, RunActionDecision};
use eos_core::routine::{GateDecision, GateInput, GateMode};
use eos_core::store::{Outbox, RunMove, StoredRun, Tx};
use eos_domain::result_doc::{action_doc, page_issue_doc};
use eos_domain::routine::numbers::Outcome;
use eos_domain::routine::run::{Reason, RunState, Station};
use eos_surface::IssueKind;
use serde_json::json;

use super::check::{NOTHING, result_doc};
use super::control::confirmed_in;
use super::versions::{SourceFacts, untrusted_for};
use super::{Engine, failures, move_run};
use crate::routes::readable;

/// The facts the source of the signal that started the run read, empty for a
/// run without one or after retention cleared them.
fn signal_facts_in(tx: &dyn Tx, input: &eos_contracts::RunInput) -> Result<eos_contracts::Facts, Error> {
    let Some(id) = input.trigger.as_ref().and_then(|trigger| trigger.signal_id.parse::<i64>().ok()) else {
        return Ok(eos_contracts::Facts::new());
    };
    let facts = tx.signals().find(id)?.and_then(|signal| signal.signal.facts_json);
    Ok(facts.and_then(|json| serde_json::from_str(&json).ok()).unwrap_or_default())
}

/// Hands the result of `run` to the gate and moves the run by its
/// decision; whether the run is back at work after (a project's next
/// milestone).
pub(crate) fn pass_in(
    engine: &Arc<Engine>,
    tx: &dyn Tx,
    out: &mut Outbox,
    run: &StoredRun,
    untrusted: &SourceFacts,
    now: i64,
) -> Result<bool, Error> {
    hand_over(engine, tx, out, run, untrusted, now)?;
    Ok(tx.runs().find(&run.id)?.is_some_and(|run| run.state == RunState::Running))
}

/// Hands the result of `run` to the gate and moves the run by its
/// decision. A result with nothing to send skips the gate (01 G20).
fn hand_over(
    engine: &Arc<Engine>,
    tx: &dyn Tx,
    out: &mut Outbox,
    run: &StoredRun,
    untrusted: &SourceFacts,
    now: i64,
) -> Result<(), Error> {
    let result = tx.run_results().by_run(&run.id)?.into_iter().find(|r| r.attempt == run.attempt);
    let result = result.ok_or_else(|| Error::not_found("run result", run.id.clone()))?;
    if result.kind == NOTHING {
        return done(engine, tx, out, run, Outcome::Nothing, now);
    }
    let input = gate_input(tx, run, untrusted, |blueprint| {
        Ok(page_doc_in(tx, run, blueprint, &result)?.unwrap_or_else(|| result_doc(&result)))
    })?;
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
    if super::project::advance_in(engine, tx, out, run, outcome, now)? {
        return Ok(());
    }
    tx.runs().set_outcome(&run.id, outcome)?;
    let done = RunMove { state: RunState::Done, station: run.station, reason: None, at: now };
    move_run(tx, out, run, done)?;
    failures::ended_in(engine, tx, out, &run.id, now)
}

/// The channel and action a page issue is sent with: the mail the issue draws.
/// What a routine that makes a page makes, and the kind its lead hands in.
const PAGE: &str = "page";
const PAGE_CHANNEL: &str = "mail";
const PAGE_ACTION: &str = "send_mail";

/// The result of a run of a routine that makes a page: the page issue the
/// run filled, as fields the gate checks and the issue the channel draws;
/// none when the run handed in something else or filled no page.
fn page_doc_in(
    tx: &dyn Tx,
    run: &StoredRun,
    blueprint: &eos_contracts::Blueprint,
    result: &eos_core::store::StoredRunResult,
) -> Result<Option<eos_contracts::ResultDoc>, Error> {
    if blueprint.makes.kind != PAGE || result.kind != PAGE {
        return Ok(None);
    }
    let issues = tx.surface_issues().of_run(&run.id)?;
    let Some(issue) = issues.into_iter().filter(|issue| issue.kind == IssueKind::Page).max_by_key(|issue| issue.rev)
    else {
        return Ok(None);
    };
    let body: serde_json::Value = serde_json::from_str(&issue.body_json).unwrap_or_default();
    let pdf = blueprint.makes.pdf;
    Ok(Some(page_issue_doc((&issue.surface_id, &issue.id), &body["data"], pdf, PAGE_CHANNEL, PAGE_ACTION)))
}

/// What the gate decides `run`'s result or action by, with `doc_of` the
/// result as it goes.
fn gate_input(
    tx: &dyn Tx,
    run: &StoredRun,
    untrusted: &SourceFacts,
    doc_of: impl FnOnce(&eos_contracts::Blueprint) -> Result<eos_contracts::ResultDoc, Error>,
) -> Result<GateInput, Error> {
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
    // A trial sends nothing anywhere (03 G21); a surface's run only shows.
    let surface_run = eos_contracts::SurfaceRunKind::is_surface_word(&run.kind);
    let trial = run.kind == "trial" || surface_run;
    let untrusted_facts = untrusted_for(untrusted, &blueprint);
    let result_mode = match (run.kind.as_str(), input.result) {
        ("trial", _) => GateMode::Trial,
        _ if surface_run => GateMode::ShowOnly,
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
        doc: doc_of(&blueprint)?,
        targets: if trial { Vec::new() } else { blueprint.goes_to },
        item_facts: serde_json::to_value(&input.item).unwrap_or_default(),
        signal_facts: signal_facts_in(tx, &input)?,
        untrusted_facts,
        subject_key: run.item_key.clone(),
        trust: eos_domain::routine::trust::of_run(Some(version.trust), &input),
        freedom_confirmed,
        goes_to_confirmed,
    })
}

/// Passes an action a run's agent calls that reaches past this computer
/// through the gate (D73), in a write job of its own, as the run's result
/// would: the same Freedom, mode and facts. A worker that works for no run
/// sends nothing.
pub(crate) async fn action(engine: &Arc<Engine>, action: &RunAction) -> Result<RunActionDecision, Error> {
    let untrusted = super::versions::untrusted_facts(engine).await?;
    let (job, action, now) = (engine.clone(), action.clone(), engine.clock.now_ms());
    engine
        .store
        .write(move |tx, out| {
            let refused = || RunActionDecision::Refused { reason: NO_GATE.to_owned() };
            let Some(found) = tx.routine_sessions().run_of(&action.worker_id)? else { return Ok(refused()) };
            let Some(run) = tx.runs().find(&found.run_id)? else { return Ok(refused()) };
            let doc = action_doc(&action.capability, &action.action, &action.input);
            let input = gate_input(tx, &run, &untrusted, |_| Ok(doc))?;
            job.gate.action_in(tx, out, now, job.ids.as_ref(), &input, &action)
        })
        .await
}
