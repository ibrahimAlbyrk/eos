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
use eos_core::capability::{ActionError, Checkout};
use eos_domain::git::project_key::{git_key, normalize_remote, split_git_key};

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
            // Under the clone's real path, where git makes the worktree, also when the project
            // was added through a link.
            let root = std::fs::canonicalize(&repo.root).unwrap_or_else(|_| Path::new(&repo.root).to_owned());
            let dir = root.join(".eos").join("worktrees").join(&branch);
            Ok(Place::Worktree {
                repo: repo.root,
                branch,
                start_point: repo.sha,
                dir: dir.to_string_lossy().into_owned(),
            })
        }
    }
}

/// Why a run's repository was not found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Missing {
    /// No project here is a clone of it; its remote (`github.com/acme/game`)
    /// when it is known.
    NoClone(Option<String>),
    /// The capability that tells where an item's code is does not take calls.
    NotReady(String),
    /// Where an item's code is could not be read now.
    Unknown,
}

/// The capability an item comes from: `github` for `github.pull_request`.
fn capability_of(item: &ItemRef) -> String {
    item.kind.split('.').next().unwrap_or_default().to_owned()
}

/// The item's repository on this computer and where the item's code is;
/// else the routine's `project.repo`. Nothing is fetched.
pub(crate) async fn find(
    engine: &Engine,
    blueprint: &Blueprint,
    input: &RunInput,
) -> Result<(String, Option<Checkout>), Missing> {
    let mut missing = Missing::NoClone(None);
    for item in input.item.iter().chain(input.items.iter().flatten()) {
        let checkout = match engine.reads.checkout(item).await {
            Ok(checkout) => checkout,
            // An item whose capability names no code, such as a file or a day.
            Err(ActionError::NotFound) => continue,
            Err(ActionError::NotReady(_)) => {
                missing = Missing::NotReady(capability_of(item));
                continue;
            }
            Err(_) => {
                missing = Missing::Unknown;
                continue;
            }
        };
        let Some(remote) = normalize_remote(&checkout.remote) else { continue };
        let root = engine.keys.find_path(&git_key(&remote, "")).await.ok_or(Missing::NoClone(Some(remote)))?;
        return Ok((root, Some(checkout)));
    }
    let Some(project) = &blueprint.project else { return Err(missing) };
    let Some((remote, _)) = split_git_key(&project.repo) else { return Ok((project.repo.clone(), None)) };
    let root = engine.keys.find_path(&project.repo).await.ok_or_else(|| Missing::NoClone(Some(remote.to_owned())))?;
    Ok((root, None))
}

/// The item's repository on this computer, its pull request's head fetched
/// when `fetch`; else the routine's `project.repo`.
async fn repository(engine: &Engine, blueprint: &Blueprint, input: &RunInput, fetch: bool) -> Result<Repo, NoPlace> {
    let (root, checkout) = find(engine, blueprint, input).await.map_err(|_| NoPlace::NoClone)?;
    if fetch && let Some(checkout) = &checkout {
        let fetched = engine.remotes.fetch_ref(Path::new(&root), &checkout.remote, &checkout.refspec).await;
        if !fetched.ok {
            return Err(Error::Conflict("the pull request's head could not be fetched".into()).into());
        }
    }
    Ok(Repo { root, sha: checkout.map(|checkout| checkout.sha) })
}
