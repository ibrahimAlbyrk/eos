//! Starting one of a run's sessions (01 §4.7): in its place (a scratch
//! folder of its own, the repository, or a worktree its spawn makes), its
//! `routine_sessions` row written before the session starts (so the
//! first `worker:spawn` already finds it), its launch kept for every start
//! and resume, then a focused session of its reserved definition in
//! `AcceptEdits` under the run scope.

use eos_contracts::builtin_tools::FILE_EDIT_BUILTIN_TOOLS;
use eos_contracts::{NameSource, ToolScope};
use eos_core::Error;
use eos_core::store::StoredRoutineSession;
use eos_domain::routine::run::{RunState, Station};
use eos_domain::run_scope::{RunRole, Trust};
use eos_sessions::SpawnRequest;

use super::Engine;
use super::launch::{RUN_PERMISSION_MODE, RunLaunch, run_scope};
use super::workspace::Place;

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
    /// Where it works.
    pub(crate) place: Place,
    /// The lead whose worker it is; `None` for a focused session.
    pub(crate) parent_id: Option<String>,
    /// Its report reaches the lead marked as outside text.
    pub(crate) reads_outside: bool,
    /// Where the run must be when the row is written; elsewhere it moved on
    /// (stopped) and nothing starts.
    pub(crate) at: (RunState, Station),
    /// The notes its first start carries: a lead's, from memory.
    pub(crate) pack: Option<String>,
}

/// Starts the session; its first message is `prompt` of its folder. `None`
/// when the run moved on before the session could be recorded.
pub(crate) async fn start(
    engine: &Engine,
    session: RunSession,
    prompt: impl FnOnce(&str) -> Result<String, Error>,
) -> Result<Option<String>, Error> {
    let worker_id = engine.ids.worker_id();
    let scratch = match &session.place {
        Place::Scratch => Some(engine.scratch.create(&worker_id).await?),
        _ => None,
    };
    let folder = match (&scratch, &session.place) {
        (Some(folder), _) => folder.clone(),
        (None, Place::Folder { dir, .. } | Place::Worktree { dir, .. }) => dir.clone(),
        (None, Place::Scratch) => String::new(),
    };
    let drop_scratch = || async {
        if let Some(folder) = &scratch {
            engine.scratch.remove(folder).await;
        }
    };
    if !record(engine, &session, &worker_id).await? {
        drop_scratch().await;
        return Ok(None);
    }
    let started = spawn(engine, &session, &worker_id, &folder, prompt).await;
    if let Err(error) = started {
        Engine::locked(&engine.launches).remove(&worker_id);
        drop_scratch().await;
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
    let read_only = matches!(session.place, Place::Folder { read_only: true, .. });
    let fence = if read_only { Some(without_edits(session.fence.clone())) } else { session.fence.clone() };
    let scope = run_scope(session.role, session.trust, fence.as_ref(), folder)?;
    let launch = RunLaunch {
        routine_id: session.routine_id.clone(),
        run_id: session.run_id.clone(),
        trust: session.trust,
        reads_outside: session.reads_outside,
        agent_key: session.agent_key.clone(),
        pack: session.pack.clone(),
    };
    Engine::locked(&engine.launches).insert(worker_id.to_owned(), launch);
    let (cwd, worktree_from, branch, start_point) = match &session.place {
        Place::Worktree { repo, branch, start_point, .. } => {
            (None, Some(repo.clone()), Some(branch.clone()), start_point.clone())
        }
        _ => (Some(folder.to_owned()), None, None, None),
    };
    // A specialist is its lead's worker; the others are focused sessions.
    let role = session.parent_id.is_none().then(|| eos_contracts::FOCUSED_ROLE.to_owned());
    let request = SpawnRequest {
        prompt,
        cwd,
        worktree_from,
        branch,
        start_point,
        parent_id: session.parent_id.clone(),
        name: Some(session.name.clone()),
        name_source: Some(NameSource::Auto),
        model: Some(session.model.clone()),
        effort: Some(session.effort.clone()),
        role,
        worker_definition: Some(session.definition.to_owned()),
        scratch: session.place == Place::Scratch,
        fixed_id: Some(worker_id.to_owned()),
        skip_recents: true,
        permission_mode: Some(RUN_PERMISSION_MODE.to_owned()),
        tool_scope: Some(scope),
        ..SpawnRequest::default()
    };
    engine.sessions.spawn(request).await.map(drop)
}

/// `fence` with every file edit denied besides.
fn without_edits(fence: Option<ToolScope>) -> ToolScope {
    let mut fence = fence.unwrap_or(ToolScope { allow: Vec::new(), deny: Vec::new(), edit_regex: None });
    fence.deny.extend(FILE_EDIT_BUILTIN_TOOLS.iter().map(|tool| (*tool).to_owned()));
    fence
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
    let leads = !matches!(session.role, RunRole::Checker | RunRole::Specialist | RunRole::AppReviewer);
    let (id, at) = (session.run_id.clone(), session.at);
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
