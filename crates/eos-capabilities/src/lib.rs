//! The capability service: what Eos can reach for the user and how a call of
//! one of its actions goes.
//!
//! [`CapabilityService`] is the registry of Eos's built-in capabilities
//! (handed in as code) and of the packages installed from the tables and
//! files; it answers `CapabilityRegistry` and `CapabilityCalls`. A call is
//! found, its caller's grant and the capability's state are checked, its
//! input is held to the action's schema, it waits for a slot, runs (the
//! built-in, or the package's runner once its files still hash to the
//! pinned hash), its output is held to its schema, the capability's secrets
//! are cut out, text from outside is marked, and one `capability_calls` row
//! is written with the health it leaves behind; a state change is announced
//! on [`CAPABILITIES_CHANGE`] after that write commits. A call the service
//! refused for its sign-in, or whose answer broke its shape, asks for an
//! early health check ([`CapabilityService::early_checks`]). The user
//! switches a capability off and on and sets its settings; the items its
//! `[[candidates]]` actions offer are gathered for the user to pick. A
//! built-in the user signs in to by a code is handed out for the sign-in,
//! and the account's label is kept once it is done. No
//! class gate here: the policy decides an agent's call before the tool
//! runs, and a delivery calls after the Needs-you gate.
//!
//! Routines read through it too: the built-ins' signal sources
//! ([`CapabilityService::signal_sources`], each poll a call of the source's
//! action with the cursor kept opaque), what a source's failure does to its
//! capability (`CapabilityHealth`), items to pick and past ones, how items
//! are recognised, whether a result fits the action that sends it, what a
//! routine lacks and where a pull request's code is (`CapabilityReads`),
//! and the channels deliveries go out through
//! ([`CapabilityService::channels`]). A source's items reach a run marked
//! as outside text.
//!
//! Logs carry the capability's id, the action, its class, the caller's kind,
//! the outcome, the error's kind and the duration; never input, output,
//! secrets, settings or account labels.

mod call;
mod candidates;
mod channels;
mod describe;
mod early;
mod health;
mod install;
mod limits;
mod mail;
mod manage;
mod output;
mod pull;
mod reads;
mod registry;
mod sign_in;
mod sources;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use eos_core::capability::{
    ActionCall, ActionError, ActionResult, ActionRunner, BuiltinCapability, CapabilityCalls, CapabilityDescription,
    CapabilityFiles, CapabilityGrants, CapabilitySecrets,
};
use eos_core::delivery::Channels;
use eos_core::signals::SignalSources;
use eos_core::store::Store;
use eos_core::{BoxFuture, Clock, Error, Ids};

pub use candidates::CANDIDATES_MAX;
pub use install::Install;

/// The topic a capability's state or version change is announced on, with
/// `eos_contracts::CapabilitiesChange`.
pub const CAPABILITIES_CHANGE: &str = "capabilities:change";

/// What the service is built on.
pub struct CapabilityPorts {
    pub store: Arc<dyn Store>,
    pub files: Arc<dyn CapabilityFiles>,
    pub secrets: Arc<dyn CapabilitySecrets>,
    pub grants: Arc<dyn CapabilityGrants>,
    /// Runs `script` and `mcp` packages; without it their actions are not
    /// ready (`sandbox_unavailable`).
    pub runner: Option<Arc<dyn ActionRunner>>,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn Ids>,
}

impl std::fmt::Debug for CapabilityPorts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CapabilityPorts").field("runner", &self.runner.is_some()).finish_non_exhaustive()
    }
}

pub struct CapabilityService {
    ports: CapabilityPorts,
    builtins: HashMap<String, Arc<dyn BuiltinCapability>>,
    limits: limits::Limits,
    /// Per installed version, the stamp its files had when they last hashed
    /// to the pinned hash: an unchanged stamp spares the hashing.
    stamps: Mutex<HashMap<(String, String), String>>,
    early: early::EarlyChecks,
}

impl std::fmt::Debug for CapabilityService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut builtins: Vec<&str> = self.builtins.keys().map(String::as_str).collect();
        builtins.sort_unstable();
        f.debug_struct("CapabilityService").field("builtins", &builtins).finish_non_exhaustive()
    }
}

impl CapabilityService {
    /// `builtins`: Eos's own capabilities, by the ids their manifests give.
    pub fn new(ports: CapabilityPorts, builtins: Vec<Arc<dyn BuiltinCapability>>) -> Self {
        let builtins = builtins.into_iter().map(|builtin| (builtin.manifest().id.clone(), builtin)).collect();
        Self { ports, builtins, limits: limits::Limits::default(), stamps: Mutex::default(), early: Default::default() }
    }

    /// The signal sources the built-ins declare, by `<capability>.<source>`.
    pub fn signal_sources(self: &Arc<Self>) -> Arc<dyn SignalSources> {
        Arc::new(sources::Sources(self.clone()))
    }

    /// The channels deliveries go out through.
    pub fn channels(self: &Arc<Self>) -> Arc<dyn Channels> {
        Arc::new(channels::BuiltinChannels(self.clone()))
    }
}

impl CapabilityCalls for CapabilityService {
    fn call(&self, call: ActionCall) -> BoxFuture<'_, Result<ActionResult, ActionError>> {
        Box::pin(self.run_call(call))
    }

    fn describe<'a>(
        &'a self,
        worker_id: &'a str,
        id: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Vec<CapabilityDescription>, Error>> {
        Box::pin(self.describe_for(worker_id, id))
    }
}
