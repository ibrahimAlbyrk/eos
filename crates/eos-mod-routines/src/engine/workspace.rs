//! Where each of a run's agents works (01 §4.7): `none` in a scratch folder
//! of its own, `read` in the repository with file edits denied, `worktree`
//! in its own worktree of the repository (for a pull request, at the head
//! its capability names, fetched with the user's git), `shared` in the
//! lead's worktree. The repository is the user's local clone of the item's
//! remote, found through the project keys, or the routine's `project.repo`;
//! Eos does not clone. A run whose agent needs a repository it cannot find
//! fails as `invalid`.

use std::path::Path;

use eos_contracts::{AgentWorkspace, Blueprint, ItemRef, RunInput};
use eos_core::Error;
use eos_domain::git::project_key::{git_key, normalize_remote};

use super::Engine;

/// The run event of a repository with no local clone.
pub(crate) const NO_LOCAL_CLONE: &str = "no_local_clone";
/// What the user reads first when it happens.
pub(crate) const NO_CLONE_HEADLINE: &str = "Add a local clone of this repository as a project, then run it again.";

/// Where a session works.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Place {
    /// A scratch folder made for it.
    Scratch,
    /// A folder that exists: the repository, or the lead's worktree.
    Folder { dir: String, read_only: bool },
    /// A worktree the session's spawn makes, at `dir`.
    Worktree { repo: String, branch: String, start_point: Option<String>, dir: String },
}

/// The repository a run works on, and the commit its item is at.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Repo {
    root: String,
    sha: Option<String>,
}

/// Why no place could be found.
#[derive(Debug)]
pub(crate) enum NoPlace {
    /// The repository is not cloned on this computer.
    NoClone,
    Failed(Error),
}

impl From<Error> for NoPlace {
    fn from(error: Error) -> Self {
        Self::Failed(error)
    }
}

/// The branch of an agent's worktree in a run.
pub(crate) fn branch_of(run_id: &str, agent_key: &str) -> String {
    format!("eos/run/{run_id}/{agent_key}")
}

/// Where `agent_key` of the run works. `lead_dir` is the lead's folder, for
/// `shared`; the lead itself shares nothing and gets its own worktree.
pub(crate) async fn place(
    engine: &Engine,
    run_id: &str,
    blueprint: &Blueprint,
    input: &RunInput,
    agent_key: &str,
    workspace: AgentWorkspace,
    lead_dir: Option<&str>,
) -> Result<Place, NoPlace> {
    match (workspace, lead_dir) {
        (AgentWorkspace::None, _) => Ok(Place::Scratch),
        (AgentWorkspace::Shared, Some(dir)) => Ok(Place::Folder { dir: dir.to_owned(), read_only: false }),
        (AgentWorkspace::Read, _) => {
            let repo = repository(engine, blueprint, input, false).await?;
            Ok(Place::Folder { dir: repo.root, read_only: true })
        }
        (AgentWorkspace::Worktree | AgentWorkspace::Shared, _) => {
            let repo = repository(engine, blueprint, input, true).await?;
            let branch = branch_of(run_id, agent_key);
            let dir = Path::new(&repo.root).join(".eos").join("worktrees").join(&branch);
            Ok(Place::Worktree {
                repo: repo.root,
                branch,
                start_point: repo.sha,
                dir: dir.to_string_lossy().into_owned(),
            })
        }
    }
}

/// The item's repository on this computer, its pull request's head fetched
/// when `fetch`; else the routine's `project.repo`.
async fn repository(engine: &Engine, blueprint: &Blueprint, input: &RunInput, fetch: bool) -> Result<Repo, NoPlace> {
    let items: Vec<&ItemRef> = input.item.iter().chain(input.items.iter().flatten()).collect();
    for item in items {
        let Ok(checkout) = engine.reads.checkout(item).await else { continue };
        let Some(remote) = normalize_remote(&checkout.remote) else { continue };
        let root = engine.keys.find_path(&git_key(&remote, "")).await.ok_or(NoPlace::NoClone)?;
        if fetch {
            let fetched = engine.remotes.fetch_ref(Path::new(&root), &checkout.remote, &checkout.refspec).await;
            if !fetched.ok {
                return Err(Error::Conflict("the pull request's head could not be fetched".into()).into());
            }
        }
        return Ok(Repo { root, sha: Some(checkout.sha) });
    }
    let Some(project) = &blueprint.project else { return Err(NoPlace::NoClone) };
    let root = if project.repo.starts_with("git:") {
        engine.keys.find_path(&project.repo).await.ok_or(NoPlace::NoClone)?
    } else {
        project.repo.clone()
    };
    Ok(Repo { root, sha: None })
}
