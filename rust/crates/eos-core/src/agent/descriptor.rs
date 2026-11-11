//! What a backend is and can do. Callers branch on these facts, never on the
//! backend's name (`BackendDescriptor` / `AgentCapabilities` of
//! `core/src/ports/AgentBackend.ts`).

use eos_contracts::{
    UiBackendDescriptor, UiBackendDescriptorBilling, UiBackendDescriptorCapabilities, UiBackendDescriptorCatalog,
    UiBackendDescriptorSessionStore, UiBackendDescriptorWireDialect,
};

/// What a session can do. The wire shape the dashboard gates on is the same
/// record, so there is one type for both.
pub type AgentCapabilities = UiBackendDescriptorCapabilities;

/// Where a session's model comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelSource {
    /// The model the request names (the composer's picker).
    Request,
    /// Fixed by the backend profile.
    Profile,
}

/// The credential a backend needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendAuth {
    Subscription,
    ApiKey,
    None,
}

/// One backend's facts: the single source for everything that used to be
/// derived from its name.
#[derive(Debug, Clone, PartialEq)]
pub struct BackendDescriptor {
    /// The value of a worker row's `backend_kind`.
    pub kind: String,
    pub label: String,
    pub billing: UiBackendDescriptorBilling,
    pub model_source: ModelSource,
    pub capabilities: AgentCapabilities,
    /// The model list the picker shows for it.
    pub catalog: Option<UiBackendDescriptorCatalog>,
    pub auth: BackendAuth,
    /// Selectable now.
    pub enabled: bool,
    /// The format of its conversation store: two backends with the same store
    /// (other than `None`) can continue each other's conversations.
    pub session_store: UiBackendDescriptorSessionStore,
    pub wire_dialect: Option<UiBackendDescriptorWireDialect>,
}

impl BackendDescriptor {
    /// As the dashboard's configuration lists it.
    pub fn to_ui(&self) -> UiBackendDescriptor {
        UiBackendDescriptor {
            kind: self.kind.clone(),
            label: self.label.clone(),
            enabled: self.enabled,
            billing: self.billing,
            session_store: self.session_store,
            wire_dialect: self.wire_dialect,
            catalog: self.catalog,
            capabilities: self.capabilities.clone(),
        }
    }
}
