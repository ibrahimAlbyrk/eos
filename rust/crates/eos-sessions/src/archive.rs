//! Archiving a chat, bringing it back, and deleting archived ones for good
//! (`core/src/use-cases/ArchiveWorker.ts`, `RestoreWorker.ts`,
//! `PurgeWorker.ts`, `PurgeExpiredArchives.ts`).
//!
//! An archived worker is hidden, its session stopped, its data kept: its
//! worktree, its scratch folder and its conversation stay until it is purged.

use eos_contracts::WorkerState;
use eos_contracts::stream::topics::WORKER_CHANGE;
use eos_core::Error;
use eos_core::store::Tx;
use eos_domain::Worker;
use eos_domain::config::ArchiveRetention;
use eos_domain::worker::state_name;
use serde_json::json;

use crate::control::{Removed, subtree};
use crate::service::Sessions;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Archived {
    pub id: String,
    /// The worker and everything below it, children before their parents.
    pub archived: Vec<String>,
    pub was_state: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Restored {
    pub id: String,
    pub restored: Vec<String>,
}

/// How long an archived chat is kept; `None` keeps it until the user deletes it.
fn retention_ms(retention: ArchiveRetention) -> Option<i64> {
    match retention {
        ArchiveRetention::Off => None,
        ArchiveRetention::Daily => Some(DAY_MS),
        ArchiveRetention::Weekly => Some(7 * DAY_MS),
        ArchiveRetention::Monthly => Some(30 * DAY_MS),
    }
}

/// The archived workers whose parent is not archived (or gone): each stands
/// for its whole archived subtree.
fn archived_roots(tx: &dyn Tx) -> Result<Vec<Worker>, Error> {
    let mut roots = Vec::new();
    for worker in tx.workers().list_archived()? {
        let under_archived = match &worker.parent_id {
            Some(parent_id) => tx.workers().find(parent_id)?.is_some_and(|parent| parent.is_archived()),
            None => false,
        };
        if !under_archived {
            roots.push(worker);
        }
    }
    Ok(roots)
}

impl Sessions {
    /// A worker `actor_id` may act on: one it spawned.
    pub async fn owned_by(&self, actor_id: &str, worker_id: &str) -> Result<(), Error> {
        let id = worker_id.to_owned();
        let target = self.store().read(move |tx| tx.workers().find(&id)).await?;
        let target = target.ok_or_else(|| Error::not_found("worker", worker_id))?;
        if target.parent_id.as_deref() != Some(actor_id) {
            return Err(Error::PermissionDenied(format!("worker {worker_id} is not managed by {actor_id}")));
        }
        Ok(())
    }

    /// Archives a worker and everything below it: sessions stopped, what
    /// waited on the user dropped, rows kept and hidden.
    pub async fn archive(&self, worker_id: &str) -> Result<Archived, Error> {
        let id = worker_id.to_owned();
        let (root, mut order) = self
            .store()
            .read(move |tx| {
                let root = tx.workers().find(&id)?.ok_or_else(|| Error::not_found("worker", &id))?;
                if root.is_archived() {
                    return Err(Error::Conflict(format!("worker {id} is already archived")));
                }
                Ok((root, subtree(tx, &id)?))
            })
            .await?;
        order.reverse();
        let mut archived = Vec::new();
        for id in order {
            self.leaving(&id, true);
            if let Some(session) = self.0.deps.runtime.session(&id) {
                session.stop().await;
            }
            let (gone, now) = (id.clone(), self.now());
            let written = self
                .store()
                .write(move |tx, out| {
                    let Some(row) = tx.workers().find(&gone)? else { return Ok(None) };
                    tx.workers().set_archived(&gone, Some(now))?;
                    tx.workers().clear_runtime(&gone)?;
                    if !matches!(row.state, WorkerState::Done | WorkerState::Suspended) {
                        tx.workers().mark_done(&gone, now, None)?;
                    }
                    tx.pending().delete_by_worker(&gone)?;
                    out.push(WORKER_CHANGE, &json!({"workerId": gone, "reason": "archived"}));
                    Ok(Some(row))
                })
                .await;
            self.leaving(&id, false);
            self.0.turns.forget(&id);
            self.0.peers.cancel_by_worker(&id);
            match written {
                Ok(Some(row)) => {
                    self.0.deps.hooks.archived(&row);
                    archived.push(id);
                }
                Ok(None) => {}
                Err(e) if id == worker_id => return Err(e),
                Err(e) => tracing::warn!(worker_id = %id, error = %e, "a child worker could not be archived"),
            }
        }
        Ok(Archived { id: root.id, archived, was_state: state_name(root.state).to_owned() })
    }

    /// Brings an archived worker back, with everything below it. Only the
    /// topmost archived worker of a subtree can be restored.
    pub async fn restore(&self, worker_id: &str) -> Result<Restored, Error> {
        let id = worker_id.to_owned();
        self.store()
            .write(move |tx, out| {
                let root = tx.workers().find(&id)?.ok_or_else(|| Error::not_found("worker", &id))?;
                if !root.is_archived() {
                    return Err(Error::Conflict(format!("worker {id} is not archived")));
                }
                let mut above = root.parent_id.clone();
                while let Some(parent) = above.map(|p| tx.workers().find(&p)).transpose()?.flatten() {
                    if parent.is_archived() {
                        return Err(Error::Conflict(format!(
                            "worker {id} is inside an archived subtree — restore the topmost archived ancestor instead"
                        )));
                    }
                    above = parent.parent_id;
                }
                let mut restored = subtree(tx, &id)?;
                restored.reverse();
                for one in &restored {
                    tx.workers().set_archived(one, None)?;
                    out.push(WORKER_CHANGE, &json!({"workerId": one, "reason": "restored"}));
                }
                Ok(Restored { id: root.id, restored })
            })
            .await
    }

    /// Deletes an archived worker for good, with everything below it.
    pub async fn purge(&self, worker_id: &str) -> Result<Removed, Error> {
        let id = worker_id.to_owned();
        let row = self.store().read(move |tx| tx.workers().find(&id)).await?;
        let row = row.ok_or_else(|| Error::not_found("worker", worker_id))?;
        if !row.is_archived() {
            return Err(Error::Conflict(format!(
                "worker {worker_id} is not archived — only archived workers can be purged"
            )));
        }
        self.kill(worker_id).await
    }

    /// Purges the archived chats kept longer than `retention` allows and
    /// returns their ids. One that fails is tried again at the next sweep.
    pub async fn purge_expired_archives(&self, retention: ArchiveRetention) -> Result<Vec<String>, Error> {
        let Some(period) = retention_ms(retention) else { return Ok(Vec::new()) };
        let now = self.now();
        let expired = self
            .store()
            .read(move |tx| {
                let roots = archived_roots(tx)?;
                Ok(roots.into_iter().filter(|w| w.archived_at.is_some_and(|at| now - at >= period)).collect())
            })
            .await?;
        Ok(self.purge_roots(expired).await)
    }

    /// Purges every archived chat (the app is closing and the user asked for it).
    pub async fn purge_all_archived(&self) -> Result<Vec<String>, Error> {
        let roots = self.store().read(|tx| archived_roots(tx)).await?;
        Ok(self.purge_roots(roots).await)
    }

    async fn purge_roots(&self, roots: Vec<Worker>) -> Vec<String> {
        let mut purged = Vec::new();
        for root in roots {
            match self.purge(&root.id).await {
                Ok(_) => purged.push(root.id),
                Err(e) => tracing::warn!(worker_id = %root.id, error = %e, "an archived chat could not be purged"),
            }
        }
        purged
    }
}
