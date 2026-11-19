//! Starting one of a run's sessions (01 §4.7): a scratch folder of its own,
//! its `routine_sessions` row written before the session starts (so the
//! first `worker:spawn` already finds it), its launch kept for every start
//! and resume, then a focused session of its reserved definition in
//! `AcceptEdits` under the run scope.

use eos_contracts::{NameSource, ToolScope};
use eos_core::Error;
use eos_core::store::StoredRoutineSession;
use eos_domain::routine::run::{RunState, Station};
use eos_domain::run_scope::{RunRole, Trust};
use eos_sessions::SpawnRequest;

use super::Engine;
use super::launch::{RUN_PERMISSION_MODE, RunLaunch, run_scope};

/// One session of a run to start.
pub(crate) struct RunSession {
    pub(crate) run_id: String,
    pub(crate) routine_id: String,
    pub(crate) role: RunRole,
    /// The word `routine_sessions.role` stores.
    pub(crate) role_word: &'static str,
    pub(crate) agent_key: Option<String>,
    pub(crate) definition: &'static str,
    pub(crate) name: String,
    pub(crate) model: String,
    pub(crate) effort: String,
    pub(crate) trust: Trust,
    /// The agent's own fence, which narrows the run scope.
    pub(crate) fence: Option<ToolScope>,
    /// Where the run must be when the row is written; elsewhere it moved on
    /// (stopped) and nothing starts.
    pub(crate) at: (RunState, Station),
}

/// Starts the session; its first message is `prompt` of its folder. `None`
/// when the run moved on before the session could be recorded.
pub(crate) async fn start(
    engine: &Engine,
    session: RunSession,
    prompt: impl FnOnce(&str) -> Result<String, Error>,
) -> Result<Option<String>, Error> {
    let worker_id = engine.ids.worker_id();
    let folder = engine.scratch.create(&worker_id).await?;
    if !record(engine, &session, &worker_id).await? {
        engine.scratch.remove(&folder).await;
        return Ok(None);
    }
    let started = spawn(engine, &session, &worker_id, &folder, prompt).await;
    if let Err(error) = started {
        Engine::locked(&engine.launches).remove(&worker_id);
        engine.scratch.remove(&folder).await;
        return Err(error);
    }
    tracing::info!(run_id = %session.run_id, worker_id, role = session.role_word, "a run session started");
    Ok(Some(worker_id))
}

async fn spawn(
    engine: &Engine,
    session: &RunSession,
    worker_id: &str,
    folder: &str,
    prompt: impl FnOnce(&str) -> Result<String, Error>,
) -> Result<(), Error> {
    let prompt = prompt(folder)?;
    let scope = run_scope(session.role, session.trust, session.fence.as_ref(), folder)?;
    let launch =
        RunLaunch { routine_id: session.routine_id.clone(), run_id: session.run_id.clone(), trust: session.trust };
    Engine::locked(&engine.launches).insert(worker_id.to_owned(), launch);
    let request = SpawnRequest {
        prompt,
        cwd: Some(folder.to_owned()),
        name: Some(session.name.clone()),
        name_source: Some(NameSource::Auto),
        model: Some(session.model.clone()),
        effort: Some(session.effort.clone()),
        role: Some(eos_contracts::FOCUSED_ROLE.to_owned()),
        worker_definition: Some(session.definition.to_owned()),
        scratch: true,
        fixed_id: Some(worker_id.to_owned()),
        skip_recents: true,
        permission_mode: Some(RUN_PERMISSION_MODE.to_owned()),
        tool_scope: Some(scope),
        ..SpawnRequest::default()
    };
    engine.sessions.spawn(request).await.map(drop)
}

/// The session's row, and the run's lead when it leads, written while the
/// run is where it was asked to be.
async fn record(engine: &Engine, session: &RunSession, worker_id: &str) -> Result<bool, Error> {
    let row = StoredRoutineSession {
        worker_id: worker_id.to_owned(),
        routine_id: session.routine_id.clone(),
        run_id: Some(session.run_id.clone()),
        role: session.role_word.into(),
        agent_key: session.agent_key.clone(),
        created_at: engine.clock.now_ms(),
    };
    let (id, at, leads) = (session.run_id.clone(), session.at, session.role != RunRole::Checker);
    engine
        .store
        .write(move |tx, _| {
            let there = tx.runs().find(&id)?.is_some_and(|run| (run.state, run.station) == (at.0, Some(at.1)));
            if there {
                tx.routine_sessions().insert(&row)?;
                if leads {
                    tx.runs().set_lead(&id, &row.worker_id)?;
                }
            }
            Ok(there)
        })
        .await
}
