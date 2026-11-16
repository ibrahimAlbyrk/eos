//! What the features on top of sessions hold of the service
//! ([`WorkerSessions`], [`TopLevelAgents`]).

use std::sync::Arc;

use eos_contracts::WorkerState;
use eos_core::agent::{AgentCapabilities, AgentSession, LiveCompaction, WorkerSessions};
use eos_core::net::updates::TopLevelAgents;
use eos_core::{BoxFuture, Error};

use crate::service::Sessions;

impl WorkerSessions for Sessions {
    fn capabilities(&self) -> &AgentCapabilities {
        &self.descriptor().capabilities
    }

    fn session(&self, worker_id: &str) -> Option<Arc<dyn AgentSession>> {
        Sessions::session(self, worker_id)
    }

    fn revive<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(Sessions::revive(self, worker_id))
    }

    fn settled<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, ()> {
        Sessions::settled(self, worker_id)
    }
}

impl LiveCompaction for Sessions {
    fn apply(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let Ok(active) = self.store().read(|tx| tx.workers().list_active()).await else { return };
            // All at once: a session in a long turn holds up only itself.
            futures_util::future::join_all(active.iter().filter_map(|row| {
                let session = Sessions::session(self, &row.id)?;
                let compact_at = self.compact_at(row.model.as_deref().unwrap_or_default());
                Some(async move {
                    if let Err(e) = session.set_compact_at(compact_at).await {
                        tracing::warn!(worker_id = %row.id, error = %e, "the live session did not take the compaction settings");
                    }
                })
            }))
            .await;
        })
    }
}

/// "Restart when they finish": the chats the user talks to (no parent) that are
/// in a turn, by their rows.
impl TopLevelAgents for Sessions {
    fn working(&self) -> BoxFuture<'_, usize> {
        Box::pin(async move {
            let active = self.store().read(|tx| tx.workers().list_active()).await;
            active.map_or(0, |workers| {
                workers.iter().filter(|w| w.parent_id.is_none() && w.state == WorkerState::Working).count()
            })
        })
    }
}
