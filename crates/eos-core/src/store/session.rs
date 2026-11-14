//! Which session an agent belongs to, read from the `workers` table. A session
//! is a root row and its descendants.

use std::collections::HashSet;

use super::WorkerRepo;
use crate::Error;

/// The id of the root of `id`'s parent chain. An unknown id is its own root;
/// a chain that loops ends at the row where it closes.
pub fn session_root(workers: &dyn WorkerRepo, id: &str) -> Result<String, Error> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut last = id.to_owned();
    let mut cursor = Some(id.to_owned());
    while let Some(current) = cursor {
        if !seen.insert(current.clone()) {
            break;
        }
        let Some(worker) = workers.find(&current)? else { break };
        last = current;
        cursor = worker.parent_id;
    }
    Ok(last)
}

/// The folder a session works on: its root row's checkout, else the
/// repository a worktree root forked from. `None` for an unknown id.
pub fn session_project(workers: &dyn WorkerRepo, id: &str) -> Result<Option<String>, Error> {
    let root = workers.find(&session_root(workers, id)?)?;
    Ok(root.and_then(|root| root.cwd.or(root.worktree_from)))
}

/// The agent a request names with `x-eos-agent-id`. Declared, not proven: it
/// attributes and scopes what the agent does, it never authorizes what only
/// the user may do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentCaller {
    pub id: String,
    pub name: Option<String>,
    /// The root of its session.
    pub session: String,
    /// The session's project folder.
    pub project: Option<String>,
    /// Its backend kind.
    pub kind: Option<String>,
}

/// The agent behind `header`, the value of `x-eos-agent-id`. `None` when the
/// header is absent, blank or names no worker.
pub fn agent_caller(workers: &dyn WorkerRepo, header: Option<&str>) -> Result<Option<AgentCaller>, Error> {
    let id = header.map(eos_domain::text::js_trim);
    let Some(id) = id.filter(|id| !id.is_empty()) else { return Ok(None) };
    let Some(worker) = workers.find(id)? else { return Ok(None) };
    Ok(Some(AgentCaller {
        id: id.to_owned(),
        name: worker.name,
        session: session_root(workers, id)?,
        project: session_project(workers, id)?,
        kind: worker.backend_kind,
    }))
}
