//! Stand-ins for the agent engine, which is not linked into the app yet.

use eos_contracts::UiBackendDescriptor;
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
