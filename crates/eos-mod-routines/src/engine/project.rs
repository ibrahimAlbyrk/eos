//! A project run (01 G10): one run that goes milestone by milestone. The
//! lead hands each in with `complete_milestone`; it passes the check and the
//! gate as any result does, and once the gate is done with it the run goes
//! back to work on the next one, until the last. The run's progress counts
//! the milestones done. Each milestone starts a new round of results, so
//! its check has its own two rounds; a version kept meanwhile is taken up at
//! the next milestone, and the team is told so (01 G5).

use std::sync::Arc;

use eos_contracts::{Blueprint, Milestone, RoutineKind};
use eos_core::Error;
use eos_core::store::{Outbox, RunMove, StoredRun, Tx};
use eos_domain::routine::numbers::Outcome;
use eos_domain::routine::run::{RunState, Station};
use serde_json::json;

use super::{Engine, move_run, note};
use crate::routes::{readable, showing_version};

/// On the run's timeline: a milestone began, with the first round of its result.
pub(crate) const MILESTONE_BEGAN: &str = "milestone";
/// On the run's timeline: the gate was done with a milestone.
const MILESTONE_DONE: &str = "milestone_done";

/// The blueprint of the version `run` runs, when it is a project's.
pub(crate) fn blueprint_in(tx: &dyn Tx, run: &StoredRun) -> Result<Option<Blueprint>, Error> {
    let Some(version_id) = &run.version_id else { return Ok(None) };
    let Some(version) = tx.routine_versions().find(&run.routine_id, version_id)? else { return Ok(None) };
    Ok(readable(&version)?.filter(|blueprint| blueprint.kind == RoutineKind::Project && blueprint.project.is_some()))
}

/// The milestone the run works on: the first not done.
pub(crate) fn current<'a>(blueprint: &'a Blueprint, run: &StoredRun) -> Option<&'a Milestone> {
    let done = usize::try_from(run.progress_done.unwrap_or(0)).unwrap_or(usize::MAX);
    blueprint.project.as_ref()?.milestones.get(done)
}

/// The first round of the milestone the run works on, from its timeline:
/// a check counts its rounds from there.
pub(crate) fn first_round_in(tx: &dyn Tx, run_id: &str) -> Result<i64, Error> {
    let began = tx.runs().events(run_id)?.into_iter().rev().find(|event| event.kind == MILESTONE_BEGAN);
    let round = began.and_then(|event| event.data).and_then(|data| {
        serde_json::from_str::<serde_json::Value>(&data).ok().and_then(|data| data["attempt"].as_i64())
    });
    Ok(round.unwrap_or(1))
}

/// Counts the project run's milestones from 0 as it goes to work.
pub(crate) fn begin_in(tx: &dyn Tx, run: &StoredRun) -> Result<(), Error> {
    let Some(blueprint) = blueprint_in(tx, run)? else { return Ok(()) };
    if run.progress_total.is_none() {
        let total = blueprint.project.as_ref().map_or(0, |project| project.milestones.len());
        tx.runs().set_progress(&run.id, 0, total as i64)?;
    }
    Ok(())
}

/// The gate is done with the milestone a project run handed in, as
/// `outcome`. Before the last, the run goes back to work on the next one and
/// true is answered; its lead hears of it after this job commits. On the
/// last, or for any other run, false: the run ends as usual.
pub(crate) fn advance_in(
    engine: &Arc<Engine>,
    tx: &dyn Tx,
    out: &mut Outbox,
    run: &StoredRun,
    outcome: Outcome,
    now: i64,
) -> Result<bool, Error> {
    let Some(blueprint) = blueprint_in(tx, run)? else { return Ok(false) };
    let Some(finished) = current(&blueprint, run).cloned() else { return Ok(false) };
    let total = blueprint.project.as_ref().map_or(0, |project| project.milestones.len()) as i64;
    let done = run.progress_done.unwrap_or(0) + 1;
    tx.runs().set_progress(&run.id, done, total)?;
    let data = json!({"key": finished.key, "outcome": outcome.as_str()}).to_string();
    tx.runs().append_event(&run.id, now, MILESTONE_DONE, Some(&data))?;
    if done >= total {
        return Ok(false);
    }
    // A version kept meanwhile is taken up here, at the milestone's edge.
    let head = showing_version(tx, &run.routine_id)?;
    let switched = head.filter(|head| Some(&head.id) != run.version_id.as_ref());
    let blueprint = match &switched {
        Some(head) => {
            tx.runs().bind_version(&run.id, &head.id)?;
            readable(head)?.filter(|b| b.kind == RoutineKind::Project && b.project.is_some()).unwrap_or(blueprint)
        }
        None => blueprint,
    };
    let moved = StoredRun { progress_done: Some(done), ..run.clone() };
    let Some(next) = current(&blueprint, &moved).cloned() else { return Ok(false) };
    let round = run.attempt + 1;
    tx.runs().set_attempt(&run.id, round)?;
    let began = json!({"key": next.key, "attempt": round}).to_string();
    tx.runs().append_event(&run.id, now, MILESTONE_BEGAN, Some(&began))?;
    let work = RunMove { state: RunState::Running, station: Some(Station::Work), reason: None, at: now };
    move_run(tx, out, run, work)?;
    let text = next_text(&finished.title, outcome, &next, switched.is_some());
    tell_lead_after(engine, run, text);
    Ok(true)
}

fn next_text(finished: &str, outcome: Outcome, next: &Milestone, switched: bool) -> String {
    let ended = match outcome {
        Outcome::Discarded => "the user set it aside",
        Outcome::Shown => "it was shown to the user",
        Outcome::Expired | Outcome::Replaced => "it waited for the user and was not taken up",
        _ => "it went through",
    };
    let mut text = format!(
        "Milestone \"{finished}\" is done: {ended}. Now work on the next milestone, `{}`: {}. It is done when: {}. \
         Hand it in with complete_milestone.",
        next.key, next.title, next.done_when
    );
    if switched {
        text.push_str(" The routine was changed since the last milestone: from now on its latest version holds.");
    }
    text
}

/// Tells the run's lead `text` once the job it was written in has committed.
fn tell_lead_after(engine: &Arc<Engine>, run: &StoredRun, text: String) {
    let (engine, run_id, lead) = (engine.clone(), run.id.clone(), run.lead_id.clone());
    let Some(tasks) = engine.tasks.clone() else {
        tracing::warn!(run_id, "a project run's lead could not be told of its next milestone: no runtime");
        return;
    };
    tasks.spawn(async move {
        // The next write job runs after the one that moved the run.
        if engine.store.write(|_, _| Ok(())).await.is_err() {
            return;
        }
        let Some(lead) = lead else { return };
        Engine::locked(&engine.held).remove(&lead);
        if let Err(error) = note(&engine, &lead, &run_id, &text).await {
            tracing::warn!(run_id, %error, "a project run's lead could not be told of its next milestone");
        }
    });
}

/// The milestones as the lead's brief lists them, with how to hand each in.
pub(crate) fn brief_text(blueprint: &Blueprint) -> Option<String> {
    let project = blueprint.project.as_ref().filter(|_| blueprint.kind == RoutineKind::Project)?;
    let milestones: Vec<String> = project
        .milestones
        .iter()
        .map(|milestone| format!("- `{}`: {}. Done when: {}", milestone.key, milestone.title, milestone.done_when))
        .collect();
    Some(format!(
        "The project: {}\nRepository: {} (base branch {})\n\nMilestones, in order. Work on one at a time and hand \
         each in with complete_milestone (never submit_result); Eos checks it and tells you when to go on:\n{}",
        project.brief,
        project.repo,
        project.base_branch,
        milestones.join("\n")
    ))
}
