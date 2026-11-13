//! Starting a worker, and continuing one whose session ended
//! (`core/src/use-cases/SpawnWorker.ts`, `ResumeWorker.ts`).
//!
//! This is the spawn chokepoint: the row, the worktree, the boot prompt's
//! sender tag, the system prompt and the session all come from here, so
//! every kind of agent (orchestrator, worker, sub-worker, focused chat)
//! starts the same way.

use std::path::PathBuf;

use eos_contracts::stream::topics::{WORKER_CHANGE, WORKER_SPAWN};
use eos_contracts::{FOCUSED_ROLE, NameSource, SessionFactsRole, WorkerEventType, WorkerState};
use eos_core::Error;
use eos_core::agent::{LaunchSpec, SpawnFacts};
use eos_core::git::{WorktreeCreate, WorktreeCreated};
use eos_core::store::{NewWorker, WorktreeRemoval};
use eos_domain::Worker;
use eos_domain::effort::resolve_effort;
use eos_domain::envelope::{SenderClass, apply_sender_tag};
use eos_domain::message_id::{prefix_operator_turn, starts_with_slash_command};
use eos_domain::model::resolve_catalog_model;
use eos_domain::worker::state_name;
use serde::Serialize;
use serde_json::json;

use crate::service::Sessions;
use crate::transition::transition_state;

/// What to start.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SpawnRequest {
    /// The first message; empty starts a session that waits for one.
    pub prompt: String,
    pub cwd: Option<String>,
    /// Work in a fresh worktree of this repository instead of `cwd`.
    pub worktree_from: Option<String>,
    pub branch: Option<String>,
    pub name: Option<String>,
    pub name_source: Option<NameSource>,
    pub parent_id: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub is_orchestrator: bool,
    /// `git`, `focused`; `None` for a plain worker.
    pub role: Option<String>,
    /// Work in this worker's worktree instead of a new one.
    pub workspace_of: Option<String>,
    pub carry_uncommitted: bool,
    pub hydrate_env: bool,
    pub collaborate: bool,
    pub backend_profile: Option<String>,
    pub worker_definition: Option<String>,
    /// The tool scope baked at spawn, as JSON text.
    pub tool_scope: Option<String>,
    /// `cwd` is a scratch folder made for this worker, deleted with it.
    pub scratch: bool,
    pub permission_mode: Option<String>,
    /// The id to use instead of a fresh one.
    pub fixed_id: Option<String>,
    /// Record the prompt as the chat's first message of the user (a spawn by
    /// the operator; an agent's directive shows through its own tool call).
    pub record_prompt: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spawned {
    pub id: String,
    /// The message id the boot prompt went out with.
    pub boot_msg_id: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SpawnAnnounce<'a> {
    worker_id: &'a str,
    row_id: i64,
}

fn role_of(is_orchestrator: bool, role: Option<&str>) -> SessionFactsRole {
    match (is_orchestrator, role) {
        (true, _) => SessionFactsRole::Orchestrator,
        (false, Some("git")) => SessionFactsRole::Git,
        (false, Some(FOCUSED_ROLE)) => SessionFactsRole::Focused,
        (false, _) => SessionFactsRole::Worker,
    }
}

fn facts_of(row: &Worker) -> SpawnFacts {
    SpawnFacts {
        worker_id: row.id.clone(),
        role: role_of(row.is_orchestrator, row.agent_role.as_deref()),
        parent_id: row.parent_id.clone(),
        name: row.name.clone(),
        model: row.model.clone().unwrap_or_else(|| "opus".to_owned()),
        effort: row.effort.clone(),
        permission_mode: row.permission_mode.clone(),
        cwd: row.cwd.clone(),
        worktree_dir: row.worktree_dir.clone(),
        worktree_from: row.worktree_from.clone(),
        branch: row.branch.clone(),
        attached: row.workspace_owner_id.is_some(),
        collaborate: row.collaborate,
        worker_definition: row.worker_definition.clone(),
        backend_profile: row.backend_profile.clone(),
    }
}

fn launch_of(facts: &SpawnFacts, cwd: String, system_prompt: Option<String>) -> LaunchSpec {
    LaunchSpec {
        worker_id: facts.worker_id.clone(),
        cwd,
        additional_dirs: Vec::new(),
        model: facts.model.clone(),
        effort: facts.effort.clone(),
        role: facts.role,
        parent_id: facts.parent_id.clone(),
        collaborate: facts.collaborate,
        worker_definition: facts.worker_definition.clone(),
        system_prompt,
        prompt: None,
        resume: None,
        credential: None,
    }
}

fn base36(mut n: i64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(DIGITS[(n.rem_euclid(36)) as usize]);
        n /= 36;
        if n <= 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8_lossy(&out).into_owned()
}

impl Sessions {
    /// The effort `model` can apply for what was asked.
    fn effort_for(&self, model: &str, requested: Option<&str>) -> Option<String> {
        let models = self.0.deps.models.models();
        let levels = resolve_catalog_model(&models, model).and_then(|m| m.effort_levels.clone());
        resolve_effort(requested, levels.as_deref())
    }

    /// Starts a worker: its row, its worktree when it gets one, and its
    /// session with the boot prompt on the way.
    pub async fn spawn(&self, request: SpawnRequest) -> Result<Spawned, Error> {
        let deps = &self.0.deps;
        let mut request = request;
        // What the row must agree with before anything is made.
        let (parent, target) = {
            let (parent_id, target_id) = (request.parent_id.clone(), request.workspace_of.clone());
            self.store()
                .read(move |tx| {
                    let parent = parent_id.map(|id| tx.workers().find(&id)).transpose()?.flatten();
                    let target = target_id.map(|id| tx.workers().find(&id)).transpose()?.flatten();
                    Ok((parent, target))
                })
                .await?
        };
        if let Some(parent_id) = request.parent_id.as_deref().filter(|_| !request.is_orchestrator)
            && parent.is_none()
        {
            // A caller removed mid-turn must not leave an orphan behind.
            return Err(Error::not_found("worker", parent_id));
        }
        let mut attached_dir = None;
        // Attach: work in an existing worker's worktree. Refused while that
        // worker is busy: two agents editing one tree mid-turn is a race.
        if let Some(target_id) = request.workspace_of.clone() {
            let target = target.ok_or_else(|| Error::not_found("worker", &target_id))?;
            if let Some(parent_id) = &request.parent_id
                && target.parent_id.as_deref() != Some(parent_id)
            {
                return Err(Error::PermissionDenied(format!("worker {target_id} is not managed by {parent_id}")));
            }
            let (Some(from), Some(branch), Some(dir)) = (target.worktree_from, target.branch, target.worktree_dir)
            else {
                return Err(Error::Conflict("workspaceOf target has no worktree to attach to".into()));
            };
            if matches!(target.state, WorkerState::Spawning | WorkerState::Working) {
                return Err(Error::Conflict("workspaceOf target is busy — attach when it is idle".into()));
            }
            request.cwd = None;
            request.worktree_from = Some(from);
            request.branch = Some(branch);
            attached_dir = Some(dir);
        }

        let id = request
            .fixed_id
            .clone()
            .unwrap_or_else(|| if request.is_orchestrator { deps.ids.orchestrator_id() } else { deps.ids.worker_id() });
        let model = request.model.clone().unwrap_or_else(|| "opus".to_owned());
        let effort = self.effort_for(&model, Some(request.effort.as_deref().unwrap_or("xhigh")));
        // A worktree worker always has its branch on its row: that is what
        // lets a removal clean up. The id keeps two same-named workers apart.
        let attached = request.workspace_of.is_some();
        let branch = match (&request.worktree_from, &request.branch) {
            (Some(_), None) => {
                let label = request.name.as_deref().map(|n| format!("{n}-")).unwrap_or_default();
                Some(format!("eos-{label}{id}-{}", base36(self.now())))
            }
            (_, branch) => branch.clone(),
        };

        // There is no boot child to make the worktree: it is made here, so
        // the session starts in the isolated tree and never in the source.
        let mut worktree_dir = attached_dir;
        let mut fork_base = None;
        if let (Some(repo), Some(branch), false) = (&request.worktree_from, &branch, attached) {
            let create = WorktreeCreate {
                repo_root: PathBuf::from(repo),
                branch: branch.clone(),
                worktree_dir: None,
                carry_uncommitted: request.carry_uncommitted,
                hydrate_env: request.hydrate_env,
            };
            match deps.worktrees.create(&create).await {
                WorktreeCreated::Created { worktree_dir: dir, fork_base_sha } => {
                    worktree_dir = Some(dir.to_string_lossy().into_owned());
                    fork_base = fork_base_sha;
                }
                WorktreeCreated::Refused { reason } => {
                    return Err(Error::Rule(format!("worktree create failed: {reason}")));
                }
            }
        }
        let cwd = request.cwd.clone().or(worktree_dir.clone()).or(request.worktree_from.clone()).unwrap_or_default();
        if cwd.is_empty() {
            return Err(Error::Validation("a worker needs a folder to work in".into()));
        }

        let name_source =
            request.name_source.unwrap_or(if request.name.is_some() { NameSource::User } else { NameSource::Default });
        let row = NewWorker {
            id: id.clone(),
            prompt: request.prompt.clone(),
            cwd: request.cwd.clone(),
            worktree_from: request.worktree_from.clone(),
            branch: branch.clone(),
            name: request.name.clone(),
            name_source,
            pid: None,
            port: 0,
            started_at: self.now(),
            // A worker someone spawned is always that someone's.
            parent_id: request.parent_id.clone(),
            model: model.clone(),
            effort: effort.clone(),
            is_orchestrator: request.is_orchestrator,
            backend_kind: deps.runtime.descriptor().kind.clone(),
            backend_profile: request.backend_profile.clone(),
            agent_role: request.role.clone(),
            worker_definition: request.worker_definition.clone(),
            tool_scope: request.tool_scope.clone(),
            with_gateway: false,
            collaborate: request.collaborate,
            worktree_dir: worktree_dir.clone(),
            workspace_owner_id: request.workspace_of.clone(),
            workspace_ready: true,
            scratch: request.scratch,
        };
        // The row first, then the session: an agent's first events find
        // their worker. The boot prompt takes the worker's first message id.
        let parent_name = parent.as_ref().map(|p| p.name.clone().unwrap_or_else(|| p.id.clone()));
        let (prompt, mode, record_prompt) =
            (request.prompt.clone(), request.permission_mode.clone(), request.record_prompt);
        let from_agent = request.parent_id.clone().filter(|_| !request.is_orchestrator);
        let now = self.now();
        let (boot_prompt, boot_msg_id) = self
            .store()
            .write(move |tx, out| {
                tx.workers().insert(&row)?;
                if let Some(sha) = &fork_base {
                    tx.workers().set_fork_base_sha(&row.id, sha)?;
                }
                let has_prompt = !prompt.trim().is_empty();
                if has_prompt {
                    // A spawn with a prompt is the start of a turn.
                    tx.workers().set_turn_started_at(&row.id, now)?;
                }
                if let Some(mode) = &mode {
                    tx.workers().update_permission_mode(&row.id, mode)?;
                }
                // Who wrote the boot prompt: the agent that spawned this
                // worker (tagged as its message), or the operator (as typed).
                let boot = if !has_prompt {
                    (prompt, None)
                } else if let Some(parent_id) = &from_agent {
                    let msg_id = tx.message_ids().next_inbound(&row.id)?;
                    let attrs = [
                        ("from", parent_name.clone().or(Some(parent_id.clone()))),
                        ("from-id", Some(parent_id.clone())),
                        ("id", Some(msg_id.to_string())),
                    ];
                    (apply_sender_tag(&prompt, SenderClass::Agent, &attrs), Some(msg_id))
                } else if starts_with_slash_command(&prompt) {
                    (prompt, None)
                } else {
                    let msg_id = tx.message_ids().next_inbound(&row.id)?;
                    (prefix_operator_turn(&prompt, Some(msg_id), None), Some(msg_id))
                };
                let row_id = tx.events().append_json(&row.id, now, WorkerEventType::Spawn, &json!({"pid": null}))?;
                out.push(WORKER_SPAWN, &SpawnAnnounce { worker_id: &row.id, row_id });
                if record_prompt && has_prompt {
                    let mut said = json!({"text": row.prompt});
                    if let (Some(id), Some(fields)) = (boot.1, said.as_object_mut()) {
                        fields.insert("msgId".into(), id.to_string().into());
                    }
                    let row_id = tx.events().append_json(&row.id, now, WorkerEventType::UserMessage, &said)?;
                    out.push(WORKER_CHANGE, &json!({"workerId": row.id, "rowId": row_id, "type": "user_message"}));
                }
                Ok(boot)
            })
            .await?;
        if let Some(folder) = request.cwd.as_deref().or(request.worktree_from.as_deref()).filter(|_| !request.scratch) {
            deps.recents.push(folder);
        }

        let facts = SpawnFacts {
            worker_id: id.clone(),
            role: role_of(request.is_orchestrator, request.role.as_deref()),
            parent_id: request.parent_id.clone(),
            name: request.name.clone(),
            model,
            effort,
            permission_mode: request.permission_mode.clone(),
            cwd: request.cwd.clone(),
            worktree_dir: worktree_dir.clone(),
            worktree_from: request.worktree_from.clone(),
            branch: branch.clone(),
            attached,
            collaborate: request.collaborate,
            worker_definition: request.worker_definition.clone(),
            backend_profile: request.backend_profile.clone(),
        };
        let system_prompt = deps.prompts.system_prompt(&facts);
        let mut launch = launch_of(&facts, cwd, system_prompt);
        launch.prompt = Some(boot_prompt).filter(|p| !p.trim().is_empty());
        if let Err(e) = deps.runtime.start(launch, self.sink()).await {
            // Nothing started: the row and what hung on it go again.
            let worktree = (!attached).then(|| request.worktree_from.clone().zip(branch)).flatten();
            let (gone, now) = (id.clone(), self.now());
            let undone = self
                .store()
                .write(move |tx, _| {
                    if let Some((repo_root, branch)) = worktree {
                        let removal = WorktreeRemoval {
                            id: gone.clone(),
                            worker_id: gone.clone(),
                            repo_root,
                            worktree_dir,
                            branch,
                            scheduled_at: now,
                        };
                        tx.worktree_removals().enqueue(&removal)?;
                    }
                    tx.events().delete_by_worker(&gone)?;
                    tx.message_ids().delete_by_worker(&gone)?;
                    tx.workers().delete(&gone)
                })
                .await;
            if let Err(undo) = undone {
                tracing::error!(worker_id = %id, error = %undo, "a worker that failed to start could not be removed");
            }
            return Err(e);
        }
        // It may be the peer an earlier worker already asked for by name.
        if let Some(parent_id) = request.parent_id.as_deref().filter(|_| request.collaborate) {
            self.bind_awaiting_peers(parent_id).await;
        }
        Ok(Spawned { id, boot_msg_id })
    }

    /// The row of a worker whose conversation can be continued now. Anything
    /// else is refused when `strict` (an explicit resume), else left as it is
    /// (`None`: a chat that is live, or never had a session).
    pub(crate) async fn resumable(&self, worker_id: &str, strict: bool) -> Result<Option<Worker>, Error> {
        let id = worker_id.to_owned();
        let row = self.store().read(move |tx| tx.workers().find(&id)).await?;
        let Some(row) = row else {
            return if strict { Err(Error::not_found("worker", worker_id)) } else { Ok(None) };
        };
        let refused = if !matches!(row.state, WorkerState::Suspended | WorkerState::Done) {
            format!("worker is not resumable (state {})", state_name(row.state))
        } else if row.session_id.as_deref().is_none_or(str::is_empty) {
            "worker has no recorded session to resume".to_owned()
        } else if self.is_live(worker_id) {
            "worker process is still alive".to_owned()
        } else {
            return Ok(Some(row));
        };
        if strict { Err(Error::Conflict(refused)) } else { Ok(None) }
    }

    /// Continues the conversation of a worker whose session is over
    /// (`ResumeWorker.ts`); `false` when there was nothing to continue and
    /// `strict` is off. The worker comes back idle, with no new turn of its
    /// own. Runs only in the worker's start lane (`revive.rs`).
    pub(crate) async fn start_resumed(&self, worker_id: &str, strict: bool) -> Result<bool, Error> {
        let deps = &self.0.deps;
        let Some(row) = self.resumable(worker_id, strict).await? else { return Ok(false) };
        let session_id = row.session_id.clone().unwrap_or_default();
        let Some(cwd) = row.work_dir().map(str::to_owned).filter(|dir| deps.hooks.folder_exists(dir)) else {
            return Err(Error::Conflict("workspace directory no longer exists".into()));
        };
        let (id, now) = (worker_id.to_owned(), self.now());
        self.store().write(move |tx, out| transition_state(tx, out, now, &id, WorkerState::Spawning, "resume")).await?;

        let facts = facts_of(&row);
        let mut launch = launch_of(&facts, cwd, deps.prompts.system_prompt(&facts));
        launch.resume = Some(session_id.clone());
        let started = deps.runtime.start(launch, self.sink()).await;
        let (id, now) = (worker_id.to_owned(), self.now());
        if let Err(e) = started {
            self.store()
                .write(move |tx, out| transition_state(tx, out, now, &id, WorkerState::Suspended, "resume_failed"))
                .await?;
            return Err(e);
        }
        self.store()
            .write(move |tx, out| {
                tx.workers().reactivate(&id, None, 0)?;
                let payload = json!({"resumed": true, "sessionId": session_id, "pid": null});
                let row_id = tx.events().append_json(&id, now, WorkerEventType::Spawn, &payload)?;
                out.push(WORKER_SPAWN, &SpawnAnnounce { worker_id: &id, row_id });
                // The session is up and waits for a message.
                transition_state(tx, out, now, &id, WorkerState::Idle, "resume_ready")?;
                Ok(())
            })
            .await?;
        Ok(true)
    }
}
