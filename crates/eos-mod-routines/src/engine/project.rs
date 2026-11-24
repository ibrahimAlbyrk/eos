//! A project run (01 G10): one run that goes milestone by milestone. The
//! lead hands each in with `complete_milestone`; it passes the check and the
//! gate as any result does, and once the gate is done with it the run goes
//! back to work on the next one, until the last. The run's progress counts
//! the milestones done. Each milestone starts a new round of results, so
//! its check has its own two rounds; a version kept meanwhile is taken up at
//! the next milestone, and the team is told so (01 G5). A project has no
//! cap per run: once its routine or all routines spent the day's budget it
//! pauses, and the next day it goes on. Its sessions idle for half an hour
//! are suspended; a message brings them back.

use std::sync::Arc;

use eos_contracts::WorkerState;
use eos_contracts::{Blueprint, Milestone, RoutineKind};
use eos_core::Error;
use eos_core::store::{Outbox, RunMove, StoredRun, Tx};
use eos_domain::routine::numbers::Outcome;
use eos_domain::routine::run::{Reason, RunState, Station};
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

/// What a project run's lead hears when a new day lets it work again.
const NEW_DAY: &str = "A new day: the routine's budget lets this run work again. Carry on where you left off.";
/// A project's sessions idle this long are suspended; any message revives them.
pub(crate) const IDLE_SUSPEND_MS: i64 = 30 * 60 * 1000;

/// Whether the routine of `run`, or every routine together, has spent
/// what it may spend on `day`.
fn day_spent_in(tx: &dyn Tx, blueprint: &Blueprint, run: &StoredRun, day: &str, cap_usd: f64) -> Result<bool, Error> {
    let spent = super::budget::spent_in(tx, day)?;
    Ok(spent.of_routine(&run.routine_id) >= blueprint.limits.per_day_usd.0 || spent.total >= cap_usd)
}

/// A project run at work that has spent the day's budget is paused until
/// the next day, with one notice (01 §4.10). True when it was paused; its
/// sessions are the caller's to quiet once the job has committed.
pub(crate) fn pause_at_day_cap_in(
    engine: &Arc<Engine>,
    tx: &dyn Tx,
    out: &mut Outbox,
    run: &StoredRun,
    day: &str,
    cap_usd: f64,
) -> Result<bool, Error> {
    let Some(blueprint) = blueprint_in(tx, run)? else { return Ok(false) };
    if !day_spent_in(tx, &blueprint, run, day, cap_usd)? {
        return Ok(false);
    }
    let now = engine.clock.now_ms();
    let routine_spent = super::budget::spent_in(tx, day)?.of_routine(&run.routine_id) >= blueprint.limits.per_day_usd.0;
    let paused = RunMove { state: RunState::Paused, station: run.station, reason: Some(Reason::DayCap), at: now };
    move_run(tx, out, run, paused)?;
    super::budget::day_cap_notice_in(tx, out, engine, routine_spent.then_some(run.routine_id.as_str()), now)?;
    tracing::info!(run_id = %run.id, routine_id = %run.routine_id, "a project run spent the day's budget and paused");
    Ok(true)
}

/// The project runs paused at the day's budget that the day now allows,
/// back at work: answers each one's lead to revive and tell.
pub(crate) fn resume_new_day_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    day: &super::budget::Day,
    now: i64,
) -> Result<Vec<(String, String)>, Error> {
    let mut resumed = Vec::new();
    for run in tx.runs().paused_for(Reason::DayCap)? {
        let Some(blueprint) = blueprint_in(tx, &run)? else { continue };
        if day_spent_in(tx, &blueprint, &run, &day.day, day.cap_usd)? {
            continue;
        }
        let work = RunMove { state: RunState::Running, station: Some(Station::Work), reason: None, at: now };
        move_run(tx, out, &run, work)?;
        tracing::info!(run_id = %run.id, routine_id = %run.routine_id, "a project run went on in a new day");
        if let Some(lead) = run.lead_id {
            resumed.push((run.id, lead));
        }
    }
    Ok(resumed)
}

/// Revives and tells the leads [`resume_new_day_in`] answered.
pub(crate) async fn tell_resumed(engine: &Engine, resumed: Vec<(String, String)>) {
    for (run_id, lead) in resumed {
        let revived = if engine.sessions.is_live(&lead) { Ok(()) } else { engine.sessions.revive(&lead).await };
        if let Err(error) = revived.and(note(engine, &lead, &run_id, NEW_DAY).await) {
            tracing::warn!(run_id, %error, "a project run's lead could not be told of the new day");
        }
    }
}

/// Whether a session of `run` may be suspended when idle: any while the
/// result waits for the user or goes out; while the run works, only a
/// specialist, since a lead or a checker that stops then counts as one that
/// crashed.
fn may_rest(run: &StoredRun, worker_id: &str, agent: bool) -> bool {
    match run.state {
        RunState::WaitingForUser | RunState::Delivering => true,
        RunState::Running => agent && run.lead_id.as_deref() != Some(worker_id),
        _ => false,
    }
}

/// Suspends the idle sessions of project runs that showed no activity for
/// [`IDLE_SUSPEND_MS`]: a session in a turn is left alone, and a message to
/// a suspended one brings it back.
pub(crate) async fn suspend_idle(engine: &Engine) {
    let now = engine.clock.now_ms();
    let launches: Vec<(String, String, bool)> = Engine::locked(&engine.launches)
        .iter()
        .map(|(worker, launch)| (worker.clone(), launch.run_id.clone(), launch.agent_key.is_some()))
        .filter(|(worker, _, _)| engine.sessions.is_live(worker))
        .collect();
    if launches.is_empty() {
        return;
    }
    let last: Vec<Option<i64>> = {
        let activity = Engine::locked(&engine.activity);
        launches.iter().map(|(_, run_id, _)| activity.get(run_id).copied()).collect()
    };
    let idle = engine.store.read(move |tx| {
        let mut idle = Vec::new();
        for ((worker_id, run_id, agent), last) in launches.into_iter().zip(last) {
            let Some(run) = tx.runs().find(&run_id)? else { continue };
            if !may_rest(&run, &worker_id, agent) || blueprint_in(tx, &run)?.is_none() {
                continue;
            }
            let quiet_since = last.unwrap_or(run.updated_at).max(run.updated_at);
            let resting = tx.workers().find(&worker_id)?.is_some_and(|worker| worker.state == WorkerState::Idle);
            if resting && now - quiet_since >= IDLE_SUSPEND_MS {
                idle.push(worker_id);
            }
        }
        Ok(idle)
    });
    let idle = match idle.await {
        Ok(idle) => idle,
        Err(error) => {
            tracing::warn!(%error, "the project runs' sessions could not be read");
            return;
        }
    };
    for worker_id in idle {
        match engine.sessions.suspend(&worker_id, "routine_idle").await {
            Ok(()) => tracing::info!(worker_id, "an idle project session was suspended"),
            Err(error) => tracing::debug!(worker_id, %error, "an idle project session was not suspended"),
        }
    }
}

/// What the lead hears when the user starts a project that already runs,
/// without a note.
const STARTED_AGAIN: &str = "The user started this project again. Say where it stands, then carry on.";

/// A hand start of a project routine whose run is under way is a message to
/// its team (01 G10): the user's note, or that they started it again. None
/// for any other start.
pub(crate) async fn hand_start_in_flight(
    engine: &Engine,
    new: &eos_core::routine::NewRun,
) -> Result<Option<Vec<eos_core::routine::RunCreated>>, Error> {
    if new.origin != eos_core::routine::RunOrigin::Hand {
        return Ok(None);
    }
    let routine_id = new.routine_id.clone();
    let live = engine
        .store
        .read(move |tx| {
            for run in tx.runs().live_of(&routine_id)? {
                if run.lead_id.is_some() && blueprint_in(tx, &run)?.is_some() {
                    return Ok(Some(run));
                }
            }
            Ok(None)
        })
        .await?;
    let Some(run) = live else { return Ok(None) };
    let text = new.input.note.clone().unwrap_or_else(|| STARTED_AGAIN.to_owned());
    super::steer::message(engine, &run.id, &text).await?;
    Ok(Some(vec![eos_core::routine::RunCreated { id: run.id, state: RunState::Running, not_before: None }]))
}
