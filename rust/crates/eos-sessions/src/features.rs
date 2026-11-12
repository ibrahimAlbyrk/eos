//! What the features on top of sessions hold of the service
//! ([`WorkerSessions`], [`TopLevelAgents`]).

use std::sync::Arc;

use eos_contracts::WorkerState;
use eos_core::agent::{AgentCapabilities, AgentSession, WorkerSessions};
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
        Box::pin(async move {
            let id = worker_id.to_owned();
            let Some(worker) = self.store().read(move |tx| tx.workers().find(&id)).await? else { return Ok(()) };
            let at_rest = matches!(worker.state, WorkerState::Suspended | WorkerState::Done);
            let resumable = worker.session_id.as_deref().is_some_and(|s| !s.is_empty());
            if at_rest && resumable && !self.is_live(worker_id) {
                self.resume(worker_id).await?;
            }
            Ok(())
        })
    }

    fn settled<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, ()> {
        Sessions::settled(self, worker_id)
    }
}

/// "Restart when they finish": the chats the user talks to (no parent) that
/// are in a turn, by their rows (`manager/modules/updates/index.ts`).
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
