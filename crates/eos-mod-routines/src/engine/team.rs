//! A team run (01 §4.7, G12, G14): the lead starts, follows up, stops and
//! lists the specialists of its routine's Who. A specialist is the lead's
//! worker (`eos-run-specialist`) whose boot prompt Eos renders from the
//! blueprint: its brief, the lead's task and the item. Its model, effort,
//! fence and folder come from the blueprint, never from the lead. Its
//! report reaches the lead as a worker's report; one of a specialist that
//! reads outside text arrives inside the untrusted wrapper.

use std::sync::Arc;

use eos_contracts::{Blueprint, RoutineAgent, RunInput, WorkerState};
use eos_core::Error;
use eos_core::routine::{RunRef, Specialist};
use eos_core::store::StoredRoutineSession;
use eos_domain::routine::run::{Reason, RunState, Station};
use eos_domain::run_scope::RunRole;
use eos_sessions::MessageInput;

use super::brief::{model_of, no_clone};
use super::launch::fence_of;
use super::spawn::{self, RunSession};
use super::workspace::{self, NO_CLONE_HEADLINE, NoPlace};
use super::{Engine, fail, item_text};
use crate::routes::readable;

/// The definition a specialist starts as.
pub(crate) const SPECIALIST_DEFINITION: &str = "eos-run-specialist";
const SPECIALIST: &str = "specialist";

/// What a lead's team call reads of its run.
struct Team {
    run: RunRef,
    blueprint: Blueprint,
    input: RunInput,
    /// The run's specialist sessions, oldest first.
    sessions: Vec<StoredRoutineSession>,
    /// The lead's folder, for a specialist that shares it.
    lead_dir: Option<String>,
}

impl Team {
    fn agent(&self, key: &str) -> Result<&RoutineAgent, Error> {
        let agent = self.blueprint.who.agents.iter().find(|agent| agent.key == key && !agent.lead);
        agent.ok_or_else(|| Error::Validation(format!("agent: this routine has no specialist {key}")))
    }

    fn session_of(&self, key: &str) -> Option<&StoredRoutineSession> {
        self.sessions.iter().rev().find(|session| session.agent_key.as_deref() == Some(key))
    }
}

/// The team of the run `worker_id` leads, while the run is at work.
async fn team(engine: &Engine, worker_id: &str) -> Result<Team, Error> {
    let id = worker_id.to_owned();
    engine
        .store
        .read(move |tx| {
            let run = tx.routine_sessions().run_of(&id)?;
            let run = run.filter(|run| run.role == RunRole::Lead);
            let Some(run) = run else { return Err(Error::Conflict("only a team's lead starts specialists".into())) };
            let stored = tx.runs().find(&run.run_id)?;
            let stored = stored.filter(|r| (r.state, r.station) == (RunState::Running, Some(Station::Work)));
            let Some(stored) = stored else { return Err(Error::Conflict("the run is not at work".into())) };
            let version = tx.routine_versions().find(&run.routine_id, &run.version_id)?;
            let Some(blueprint) = version.as_ref().map(readable).transpose()?.flatten() else {
                return Err(Error::not_found("version", run.version_id.clone()));
            };
            let input: RunInput = serde_json::from_str(&stored.input)
                .map_err(|_| Error::storage(format!("run {} has no input", run.run_id)))?;
            let sessions = tx.routine_sessions().by_run(&run.run_id)?;
            let sessions = sessions.into_iter().filter(|session| session.role == SPECIALIST).collect();
            let lead_dir = tx.workers().find(&id)?.and_then(|lead| lead.work_dir().map(str::to_owned));
            Ok(Team { run, blueprint, input, sessions, lead_dir })
        })
        .await
}

pub(crate) async fn start(engine: &Arc<Engine>, worker_id: &str, key: &str, task: &str) -> Result<(), Error> {
    let team = team(engine, worker_id).await?;
    let agent = team.agent(key)?.clone();
    if team.session_of(key).is_some() {
        return Err(Error::Conflict(format!("{key} was started already: send it more with message_specialist")));
    }
    let (run_id, blueprint, input) = (&team.run.run_id, &team.blueprint, &team.input);
    let lead_dir = team.lead_dir.as_deref();
    let place = match workspace::place(engine, run_id, blueprint, input, key, agent.workspace, lead_dir).await {
        Ok(place) => place,
        Err(NoPlace::NoClone) => {
            no_clone(engine, run_id).await?;
            fail(engine, run_id, Reason::Invalid, Some(NO_CLONE_HEADLINE.to_owned())).await?;
            return Err(Error::Conflict(NO_CLONE_HEADLINE.into()));
        }
        Err(NoPlace::Failed(error)) => return Err(error),
    };
    let (model, effort) = model_of(blueprint, &agent, input);
    let session = RunSession {
        run_id: run_id.clone(),
        routine_id: team.run.routine_id.clone(),
        role: RunRole::Specialist,
        role_word: SPECIALIST,
        agent_key: Some(agent.key.clone()),
        definition: SPECIALIST_DEFINITION,
        name: format!("{} · {}", blueprint.name, agent.name),
        model,
        effort,
        trust: team.run.trust,
        fence: fence_of(&agent),
        place,
        parent_id: Some(worker_id.to_owned()),
        reads_outside: agent.reads_outside,
        pack: None,
        at: (RunState::Running, Station::Work),
    };
    let render = |folder: &str| render(engine, blueprint, &agent, input, task, folder);
    let Some(started) = spawn::start(engine, session, render).await? else {
        return Err(Error::Conflict("the run is not at work".into()));
    };
    tracing::info!(run_id = %team.run.run_id, worker_id = %started, agent_key = key, "a specialist started");
    Ok(())
}

fn render(
    engine: &Engine,
    blueprint: &Blueprint,
    agent: &RoutineAgent,
    input: &RunInput,
    task: &str,
    folder: &str,
) -> Result<String, Error> {
    let items: Vec<String> = input.item.iter().chain(input.items.iter().flatten()).map(item_text).collect();
    let pairs = [
        ("ROUTINE_NAME", blueprint.name.clone()),
        ("AGENT_NAME", agent.name.clone()),
        ("BRIEF", agent.brief.clone()),
        ("TASK", task.to_owned()),
        ("ITEM", if items.is_empty() { "No item.".into() } else { items.join("\n\n") }),
        ("CHECKOUT", folder.to_owned()),
    ];
    let values = pairs.into_iter().map(|(name, value)| (name.to_owned(), serde_json::Value::String(value))).collect();
    engine.prompts.render("routine/specialist-brief", &values, &eos_prompts::service::no_values())
}

/// The specialist `key` of the run `worker_id` leads, once started.
async fn started(engine: &Engine, worker_id: &str, key: &str) -> Result<(Team, String), Error> {
    let team = team(engine, worker_id).await?;
    team.agent(key)?;
    let Some(specialist) = team.session_of(key).map(|session| session.worker_id.clone()) else {
        return Err(Error::Conflict(format!("{key} has not started: start it with start_specialist")));
    };
    Ok((team, specialist))
}

pub(crate) async fn message(engine: &Engine, worker_id: &str, key: &str, text: &str) -> Result<(), Error> {
    let (team, specialist) = started(engine, worker_id, key).await?;
    engine.sessions.revive(&specialist).await?;
    let words = MessageInput {
        worker_id: specialist.clone(),
        text: text.to_owned(),
        queue_when_busy: true,
        origin: Some("run-lead".into()),
        ..MessageInput::default()
    };
    engine.sessions.dispatch(words).await?;
    tracing::info!(run_id = %team.run.run_id, worker_id = %specialist, agent_key = key, "a specialist was told more");
    Ok(())
}

pub(crate) async fn stop(engine: &Engine, worker_id: &str, key: &str) -> Result<(), Error> {
    let (team, specialist) = started(engine, worker_id, key).await?;
    let _ = engine.sessions.interrupt(&specialist).await;
    engine.sessions.suspend(&specialist, "routine_run").await?;
    tracing::info!(run_id = %team.run.run_id, worker_id = %specialist, agent_key = key, "a specialist was stopped");
    Ok(())
}

pub(crate) async fn list(engine: &Engine, worker_id: &str) -> Result<Vec<Specialist>, Error> {
    let team = team(engine, worker_id).await?;
    let ids: Vec<Option<String>> = team
        .blueprint
        .who
        .agents
        .iter()
        .filter(|agent| !agent.lead)
        .map(|agent| team.session_of(&agent.key).map(|session| session.worker_id.clone()))
        .collect();
    let lookup = ids.clone();
    let states = engine
        .store
        .read(move |tx| {
            let mut states = Vec::new();
            for id in lookup.iter().flatten() {
                states.push((id.clone(), tx.workers().find(id)?.map(|worker| worker.state)));
            }
            Ok(states)
        })
        .await?;
    let reports = Engine::locked(&engine.reports).clone();
    let team_agents = team.blueprint.who.agents.iter().filter(|agent| !agent.lead);
    Ok(team_agents
        .zip(ids)
        .map(|(agent, id)| {
            let state = id.as_ref().and_then(|id| states.iter().find(|(w, _)| w == id)).and_then(|(_, s)| *s);
            Specialist {
                agent: agent.key.clone(),
                name: agent.name.clone(),
                state: match (id.is_some(), state) {
                    (false, _) => "not_started",
                    (true, Some(WorkerState::Spawning | WorkerState::Working)) => "working",
                    (true, Some(WorkerState::Idle)) => "waiting",
                    (true, _) => "stopped",
                },
                last_report: id.and_then(|id| reports.get(&id).cloned()),
            }
        })
        .collect())
}

/// A run session's report on its way to the lead: its first line kept for
/// `list_specialists`; outside text marked as data when the specialist reads it.
pub(crate) fn shape_report(engine: &Engine, worker_id: &str, text: &mut String) {
    let Some(launch) = Engine::locked(&engine.launches).get(worker_id).cloned() else { return };
    let first = text.lines().next().unwrap_or_default().chars().take(200).collect();
    Engine::locked(&engine.reports).insert(worker_id.to_owned(), first);
    if launch.reads_outside {
        *text = eos_domain::untrusted::wrap(&format!("specialist:{worker_id}"), text);
    }
}
