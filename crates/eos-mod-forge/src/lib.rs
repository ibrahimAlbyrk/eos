//! The Forge (06 G9): what Eos does when it cannot do something yet. A
//! Forge job is a run of the built-in project routine `forge` (hidden from
//! the user's routines, one run per need, three at once), whose milestones
//! are its stations: the researcher finds one to three ways, the user picks
//! one in Needs you, the builder makes the package in the run's build
//! folder, Eos tests it, the reviewer reads it and Eos proposes it. Nothing
//! is installed without the user's yes on that proposal.
//!
//! - [`ForgeSteps`]: the run's build folder `<data>/scratch/forge-<runId>/`,
//!   whose project settings put every shell command of the team under the
//!   engine's sandbox, and the milestones Eos runs itself.
//! - [`ForgeModule`]: keeps the routine (its sessions are described by the
//!   `forge-*` worker definitions) and serves `POST /api/forge`
//!   `{need, routineId?, capabilityId?, fromSurface?}` → `{runId}`.
//! - [`ForgeModule::forge`]: the port behind `request_capability` and
//!   `forge_report`. A need written with outside text in it is refused, so
//!   a Forge run always starts trusted.
//!
//! Logs carry run ids and stages; never needs, reports or settings.

mod blueprint;
mod request;
mod routes;
mod steps;

use std::sync::{Arc, OnceLock};

use eos_contracts::WorkerDefinitionRecord;
use eos_core::capability::CapabilityCalls;
use eos_core::forge::Forge;
use eos_core::routine::{BuiltinRoutines, RunStarter};
use eos_core::store::Store;
use eos_core::{BoxFuture, Clock};
use eos_runtime::module::{Module, ModuleError};
use eos_runtime::router::RouteDef;

pub use blueprint::{SLUG, blueprint};
pub use request::report_event;
pub use steps::{ForgeSteps, REGISTRY_HOSTS, build_folder};

pub struct ForgeParts {
    pub store: Arc<dyn Store>,
    pub clock: Arc<dyn Clock>,
    pub runs: Arc<dyn RunStarter>,
    pub builtins: Arc<dyn BuiltinRoutines>,
    pub capabilities: Arc<dyn CapabilityCalls>,
    /// The `forge-*` worker definitions the routine's sessions are made from.
    pub definitions: Vec<WorkerDefinitionRecord>,
}

impl std::fmt::Debug for ForgeParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ForgeParts").finish_non_exhaustive()
    }
}

pub struct ForgeModule {
    service: Arc<request::ForgeService>,
    builtins: Arc<dyn BuiltinRoutines>,
    definitions: Vec<WorkerDefinitionRecord>,
}

impl std::fmt::Debug for ForgeModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ForgeModule").finish_non_exhaustive()
    }
}

impl ForgeModule {
    pub fn new(parts: ForgeParts) -> Self {
        let ForgeParts { store, clock, runs, builtins, capabilities, definitions } = parts;
        let service = Arc::new(request::ForgeService { store, clock, runs, capabilities, routine: OnceLock::new() });
        Self { service, builtins, definitions }
    }

    /// What `request_capability` and `forge_report` ask.
    pub fn forge(&self) -> Arc<dyn Forge> {
        Arc::new(request::Port(self.service.clone()))
    }

    /// Keeps the `forge` routine as this version describes it.
    async fn keep(&self) -> Result<(), eos_core::Error> {
        let id = self.builtins.ensure(SLUG, blueprint(&self.definitions)?).await?;
        tracing::info!(routine_id = %id, "the Forge's routine is kept");
        let _ = self.service.routine.set(id);
        Ok(())
    }
}

impl Module for ForgeModule {
    fn id(&self) -> &'static str {
        "forge"
    }

    fn routes(&self) -> Vec<RouteDef> {
        routes::all(&self.service)
    }

    fn after_ready(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        Box::pin(async move { Ok(self.keep().await?) })
    }
}
