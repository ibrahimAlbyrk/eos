//! Stand-ins for the agent engine, which is not linked into the app yet.

use eos_contracts::UiBackendDescriptor;
use eos_core::BoxFuture;
use eos_core::accounts::{SessionAccountSwitch, SessionCredential};
use eos_core::agent::BackendCatalog;

/// No backend can run a session until `eos-engine` exists, so none is listed:
/// the dashboard's model picker stays empty rather than offering a lane that
/// would fail. The engine's adapter replaces this.
pub(crate) struct NoBackends;

impl BackendCatalog for NoBackends {
    fn descriptors(&self) -> Vec<UiBackendDescriptor> {
        Vec::new()
    }
}

/// No session is live until `eos-engine` exists, so none can change account:
/// "Resume at" and "Use API key" answer as they do today for an agent whose
/// session is gone. The engine takes this place through `Accounts::attach_sessions`.
pub(crate) struct NoLiveSessions;

impl SessionAccountSwitch for NoLiveSessions {
    fn move_session<'a>(
        &'a self,
        _worker_id: &'a str,
        _credential: SessionCredential,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async { Err("this agent can't change account right now".to_owned()) })
    }
}
