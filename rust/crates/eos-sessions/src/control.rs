//! Acting on a worker that exists: interrupt, remove, suspend, change its
//! model or permission mode (`manager/commands/handlers/interrupt-worker.ts`,
//! `core/src/use-cases/KillWorker.ts`, `worker-teardown.ts`,
//! `SetWorkerModel.ts`, `SetWorkerPermissionMode.ts`).

use eos_contracts::stream::topics::{MESSAGE_RECALLED, WORKER_CHANGE, WORKER_REMOVED};
use eos_contracts::{PermissionMode, UiBackendDescriptorCatalog, WorkerEventType, WorkerState};
use eos_core::Error;
use eos_core::store::{Outbox, Tx, WorktreeRemoval};
use eos_domain::Worker;
use eos_domain::worker::state_name;
use serde::Serialize;
use serde_json::{Value, json};

use crate::service::{Changed, Sessions};
use crate::transition::transition_state;

/// How long a removed worker's worktree waits before it is deleted, so its
/// session's last writes are done.
pub const KILL_GRACE_MS: i64 = 2000;

/// A prompt an interrupt took back before the agent answered it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recalled {
    pub text: String,
    pub client_msg_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Removed {
    pub id: String,
    pub name: Option<String>,
    /// The state it was in.
    pub was_state: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelSet {
    pub model: String,
    pub effort: Option<String>,
    /// The live session took the change (else it holds from the next start).
    pub runtime_applied: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModeSet {
    pub mode: PermissionMode,
    /// The worker and, with `cascade`, everything below it.
    pub affected: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecalledAnnounce<'a> {
    worker_id: &'a str,
    text: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_msg_id: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemovedAnnounce<'a> {
    worker_id: &'a str,
}

/// A Claude-family model: a tier name (optionally with a version), a
/// `claude-…` id or an `anthropic/…` routed id.
fn is_claude_model(model: &str) -> bool {
    let m = model.to_lowercase();
    let tier = ["opus", "sonnet", "haiku", "fable"]
        .iter()
        .any(|t| m.strip_prefix(t).is_some_and(|rest| !rest.starts_with(|c: char| c.is_ascii_lowercase())));
    tier || m.starts_with("claude-") || m.starts_with("anthropic/")
}

/// `root` and every worker below it, parents before their children.
pub(crate) fn subtree(tx: &dyn Tx, root: &str) -> Result<Vec<String>, Error> {
    let mut all = vec![root.to_owned()];
    let mut at = 0;
    while at < all.len() {
        for child in tx.workers().find_children_ids(&all[at])? {
            if !all.contains(&child) {
                all.push(child);
            }
        }
        at += 1;
    }
    Ok(all)
}

/// Everything that hangs on a worker's row goes with it, in the same
/// transaction: a quit or a crash right after it leaves nothing behind (its
/// visual answers, the worker definitions it made). Its worktree is queued for
/// removal (that survives a restart).
fn cascade(tx: &dyn Tx, out: &mut Outbox, row: &Worker, now: i64) -> Result<(), Error> {
    if let (Some(repo_root), Some(branch)) = (&row.worktree_from, &row.branch) {
        tx.worktree_removals().enqueue(&WorktreeRemoval {
            id: row.id.clone(),
            worker_id: row.id.clone(),
            repo_root: repo_root.clone(),
            worktree_dir: row.worktree_dir.clone(),
            branch: branch.clone(),
            scheduled_at: now + KILL_GRACE_MS,
        })?;
    }
    tx.workers().delete(&row.id)?;
    tx.events().delete_by_worker(&row.id)?;
    tx.pending().delete_by_worker(&row.id)?;
    tx.message_queue().delete_by_worker(&row.id)?;
    tx.loops().delete_by_worker(&row.id)?;
    tx.message_ids().delete_by_worker(&row.id)?;
    tx.genui_views().remove_by_worker(&row.id)?;
    tx.worker_definitions().delete_for_owner(&row.id)?;
    out.push(WORKER_REMOVED, &RemovedAnnounce { worker_id: &row.id });
    Ok(())
}

impl Sessions {
    async fn find(&self, worker_id: &str) -> Result<Worker, Error> {
        let id = worker_id.to_owned();
        let row = self.store().read(move |tx| tx.workers().find(&id)).await?;
        row.ok_or_else(|| Error::not_found("worker", worker_id))
    }

    /// Stops the worker's running turn. What the user had queued is dropped
    /// with it. An interrupt before the agent answered anything takes the
    /// prompt back: the chat hands it to the composer again and the agent
    /// never reads it.
    pub async fn interrupt(&self, worker_id: &str) -> Result<Option<Recalled>, Error> {
        self.find(worker_id).await?;
        let Some(session) = self.session(worker_id) else {
            return Err(Error::Conflict("worker not running".into()));
        };
        if !session.capabilities().interrupt {
            return Err(Error::Conflict("backend does not support interrupt".into()));
        }
        self.0.turns.mark_interrupt(worker_id);
        // What it asked a peer, and what a peer asked it, ends with the turn.
        self.0.peers.cancel_by_worker(worker_id);
        let recall_row = self.0.turns.recallable(worker_id);
        let (id, now) = (worker_id.to_owned(), self.now());
        let recalled = self
            .store()
            .write(move |tx, out| {
                tx.message_queue().clear_pending_user_plane(&id)?;
                transition_state(tx, out, now, &id, WorkerState::Idle, "interrupt")?;
                out.push(WORKER_CHANGE, &Changed { worker_id: &id, queued: None });
                let Some(row) = recall_row.map(|row| tx.events().find(&id, row)).transpose()?.flatten() else {
                    return Ok(None);
                };
                let payload: Value =
                    row.payload.as_deref().and_then(|p| serde_json::from_str(p).ok()).unwrap_or_default();
                let text = payload["text"].as_str().unwrap_or_default().to_owned();
                let client_msg_id = payload["clientMsgIds"][0].as_str().map(str::to_owned);
                if let Some(client) = &client_msg_id {
                    // The same message may be sent again.
                    tx.message_queue().remove_dispatched_by_client_msg_id(&id, client)?;
                }
                let mut note = json!({"text": text, "recalledRowId": row.id});
                if let (Some(client), Some(fields)) = (&client_msg_id, note.as_object_mut()) {
                    fields.insert("clientMsgId".into(), client.clone().into());
                }
                let row_id = tx.events().append_json(&id, now, WorkerEventType::MessageRecalled, &note)?;
                out.push(WORKER_CHANGE, &json!({"workerId": id, "rowId": row_id, "type": "message_recalled"}));
                let announce =
                    RecalledAnnounce { worker_id: &id, text: &text, client_msg_id: client_msg_id.as_deref() };
                out.push(MESSAGE_RECALLED, &announce);
                Ok(Some(Recalled { text, client_msg_id }))
            })
            .await?;
        // The worker is idle on record before its session hears of it: the
        // turn's own end, which follows, then moves nothing.
        session.interrupt().await;
        if recalled.is_some() {
            self.0.turns.reset_output(worker_id);
            if let Err(e) = session.recall_last_user_turn().await {
                tracing::warn!(worker_id, error = %e, "a recalled prompt could not be taken out of the conversation");
            }
        }
        // Messages agents had queued for it still get their turn.
        self.settled(worker_id).await;
        Ok(recalled)
    }

    /// Ends the worker's session on purpose and parks it as SUSPENDED: its
    /// conversation can be continued later.
    pub async fn suspend(&self, worker_id: &str, reason: &str) -> Result<(), Error> {
        self.find(worker_id).await?;
        self.leaving(worker_id, true);
        let (id, now, why) = (worker_id.to_owned(), self.now(), reason.to_owned());
        let parked = self
            .store()
            .write(move |tx, out| {
                transition_state(tx, out, now, &id, WorkerState::Suspended, &why)?;
                tx.workers().clear_runtime(&id)
            })
            .await;
        if let Some(session) = self.0.deps.runtime.session(worker_id) {
            session.stop().await;
        }
        self.leaving(worker_id, false);
        parked
    }

    /// Closes every live session whose conversation can be continued and
    /// parks its worker (the app is quitting). Returns how many.
    pub async fn suspend_all(&self, reason: &str) -> usize {
        if self.descriptor().capabilities.resumable != Some(true) {
            return 0;
        }
        let Ok(rows) = self.store().read(|tx| tx.workers().list_all()).await else { return 0 };
        let mut parked = 0;
        for row in rows {
            let live = matches!(row.state, WorkerState::Spawning | WorkerState::Working | WorkerState::Idle);
            if !live || row.session_id.as_deref().is_none_or(str::is_empty) {
                continue;
            }
            match self.suspend(&row.id, reason).await {
                Ok(()) => parked += 1,
                Err(e) => tracing::warn!(worker_id = %row.id, error = %e, "a chat could not be parked"),
            }
        }
        parked
    }

    /// Removes a worker for good, the workers it spawned first: sessions
    /// stopped, rows and everything on them deleted, worktrees queued for
    /// removal, recorded conversations deleted.
    pub async fn kill(&self, worker_id: &str) -> Result<Removed, Error> {
        let root = self.find(worker_id).await?;
        // The whole subtree, children before their parents.
        let id = worker_id.to_owned();
        let mut order = self.store().read(move |tx| subtree(tx, &id)).await?;
        order.reverse();
        for id in order {
            self.leaving(&id, true);
            if let Some(session) = self.0.deps.runtime.session(&id) {
                session.stop().await;
            }
            let (gone, now) = (id.clone(), self.now());
            let removed = self
                .store()
                .write(move |tx, out| {
                    let Some(row) = tx.workers().find(&gone)? else { return Ok(None) };
                    cascade(tx, out, &row, now)?;
                    Ok(Some(row))
                })
                .await;
            self.leaving(&id, false);
            self.0.turns.forget(&id);
            self.0.peers.cancel_by_worker(&id);
            match removed {
                Ok(Some(row)) => {
                    self.0.deps.runtime.forget(&id).await;
                    self.0.deps.hooks.removed(&row);
                }
                Ok(None) => {}
                Err(e) if id == worker_id => return Err(e),
                Err(e) => tracing::warn!(worker_id = %id, error = %e, "a child worker could not be removed"),
            }
        }
        Ok(Removed { id: root.id, name: root.name, was_state: state_name(root.state).to_owned() })
    }

    /// Changes the worker's model (and effort) for its later turns.
    pub async fn set_model(&self, worker_id: &str, model: &str, effort: Option<&str>) -> Result<ModelSet, Error> {
        self.find(worker_id).await?;
        let descriptor = self.0.deps.runtime.descriptor();
        if descriptor.catalog == Some(UiBackendDescriptorCatalog::Claude) && !is_claude_model(model) {
            return Err(Error::Validation(format!("model \"{model}\" is not valid for provider {}", descriptor.label)));
        }
        let effort = effort.and_then(|e| self.effort_for_model(model, e));
        let mut runtime_applied = false;
        if let Some(session) = self.session(worker_id).filter(|s| s.capabilities().runtime_model_switch) {
            match session.set_model(model, effort.as_deref()).await {
                Ok(()) => runtime_applied = true,
                Err(e) => tracing::warn!(worker_id, error = %e, "the live session did not take the model change"),
            }
        }
        let (id, now, set) = (worker_id.to_owned(), self.now(), (model.to_owned(), effort.clone()));
        self.store()
            .write(move |tx, out| {
                tx.workers().update_model(&id, &set.0, set.1.as_deref())?;
                let note =
                    json!({"kind": "model_set", "model": set.0, "effort": set.1, "runtimeApplied": runtime_applied});
                tx.events().append_json(&id, now, WorkerEventType::Lifecycle, &note)?;
                out.push(WORKER_CHANGE, &Changed { worker_id: &id, queued: None });
                Ok(())
            })
            .await?;
        Ok(ModelSet { model: model.to_owned(), effort, runtime_applied })
    }

    fn effort_for_model(&self, model: &str, requested: &str) -> Option<String> {
        let models = self.0.deps.models.models();
        let levels = eos_domain::model::resolve_catalog_model(&models, model).and_then(|m| m.effort_levels.clone());
        eos_domain::effort::resolve_effort(Some(requested), levels.as_deref())
    }

    /// Changes the permission mode of a worker and, unless `cascade` is off,
    /// of everything it spawned. The policy reads the mode on every tool
    /// call, so it holds from the next call on.
    pub async fn set_permission_mode(
        &self,
        worker_id: &str,
        mode: PermissionMode,
        cascade: bool,
    ) -> Result<ModeSet, Error> {
        self.find(worker_id).await?;
        let name = serde_json::to_value(mode).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default();
        let (root, now) = (worker_id.to_owned(), self.now());
        let affected = self
            .store()
            .write(move |tx, out| {
                let affected = if cascade { subtree(tx, &root)? } else { vec![root.clone()] };
                for id in &affected {
                    tx.workers().update_permission_mode(id, &name)?;
                    let via = if *id == root { "direct" } else { "cascade" };
                    let note =
                        json!({"kind": "permission_mode_set", "mode": name, "runtimeApplied": false, "via": via});
                    tx.events().append_json(id, now, WorkerEventType::Lifecycle, &note)?;
                    out.push(WORKER_CHANGE, &Changed { worker_id: id, queued: None });
                }
                Ok(affected)
            })
            .await?;
        Ok(ModeSet { mode, affected })
    }
}
