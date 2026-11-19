//! How a run's sessions start (01 G15, G46; D51): in `AcceptEdits`, fenced
//! by 03's run scope, without the folder's MCP servers, and, for a run that
//! reads outside text, in an empty folder Eos owns with the workspace as a
//! further root, so nothing of a checkout's project configuration loads. Each
//! start gets a new such folder: what an agent left in the folder of an
//! earlier start would load as instructions at a resume.
//! What a worker's row does not hold is kept here by worker and handed to
//! every start of its session, a resume after a restart included.

use std::path::PathBuf;

use eos_contracts::tool_scope::CALL_CAPABILITY_TOOL;
use eos_contracts::{RoutineAgent, ToolScope};
use eos_core::Error;
use eos_core::agent::LaunchSpec;
use eos_domain::run_scope::{RunRole, Trust, scope_for};
use eos_workers::resolve::{is_restrictive, tool_scope};

use super::Engine;

/// The permission mode of every run session: 03's run scope decides above
/// it, `policy.yaml` within what the scope lets through.
pub(crate) const RUN_PERMISSION_MODE: &str = "acceptEdits";

/// What a run session's start needs beyond its worker row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RunLaunch {
    pub(crate) routine_id: String,
    pub(crate) run_id: String,
    pub(crate) trust: Trust,
}

/// An agent's own fence, when it has one.
pub(crate) fn fence_of(agent: &RoutineAgent) -> Option<ToolScope> {
    let fence = tool_scope(Some(&agent.tools.allow), Some(&agent.tools.deny), None);
    is_restrictive(&fence).then_some(fence)
}

/// The tool scope a run session is spawned with, as its row stores it: the
/// run scope narrowed by the agent's own fence; edits stay in `edit_folder`.
pub(crate) fn run_scope(
    role: RunRole,
    trust: Trust,
    fence: Option<&ToolScope>,
    edit_folder: &str,
) -> Result<String, Error> {
    let scope = scope_for(role, trust, &[CALL_CAPABILITY_TOOL], fence, edit_folder);
    serde_json::to_string(&scope).map_err(|e| Error::storage(e.to_string()))
}

/// Shapes the start of `spec` when its worker is a run session.
pub(crate) fn shape(engine: &Engine, spec: &mut LaunchSpec) {
    let Some(launch) = Engine::locked(&engine.launches).get(&spec.worker_id).cloned() else { return };
    spec.folder_mcp = false;
    if launch.trust == Trust::Untrusted {
        let work = match engine.folders.work_dir(&launch.routine_id, &launch.run_id) {
            Ok(work) => work,
            Err(error) => {
                // The session still starts there and finds no folder: never in the checkout.
                tracing::error!(worker_id = %spec.worker_id, %error, "a run's working folder could not be made");
                work_path(&launch)
            }
        };
        let workspace = std::mem::replace(&mut spec.cwd, work.to_string_lossy().into_owned());
        if !spec.additional_dirs.contains(&workspace) {
            spec.additional_dirs.push(workspace);
        }
    }
}

/// Where the working folder is, by the data folder's layout, when it could
/// not be made.
fn work_path(launch: &RunLaunch) -> PathBuf {
    PathBuf::from("routines").join(&launch.routine_id).join("runs").join(&launch.run_id).join("work")
}

/// The run sessions of every run that has not ended, read again after a
/// restart.
pub(crate) async fn rebuild(engine: &Engine) -> Result<(), Error> {
    let launches = engine
        .store
        .read(|tx| {
            let mut launches = Vec::new();
            for session in tx.routine_sessions().of_live_runs()? {
                if let Some(run) = tx.routine_sessions().run_of(&session.worker_id)? {
                    let launch = RunLaunch { routine_id: run.routine_id, run_id: run.run_id, trust: run.trust };
                    launches.push((session.worker_id, launch));
                }
            }
            Ok(launches)
        })
        .await?;
    let count = launches.len();
    Engine::locked(&engine.launches).extend(launches);
    tracing::info!(sessions = count, "run sessions read again");
    Ok(())
}
