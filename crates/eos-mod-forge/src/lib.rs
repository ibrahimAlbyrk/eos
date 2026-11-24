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
//!   engine's sandbox, and the milestones Eos runs itself: `forge.test`
//!   (offline tests under the sandbox's audit, secrets planted) and
//!   `forge.propose` (one `capability_install` item, the version kept as
//!   `proposed`). The files proposed are the ones tested and reviewed.
//! - The proposal's routes, this computer's dashboard only: the live test
//!   the user starts, and Install, Decline or another way. Install takes
//!   exactly the proposed files; a version whose health fails within a day
//!   goes back to the one before, and the user is told.
//! - [`ForgeModule`]: keeps the routine (its sessions are described by the
//!   `forge-*` worker definitions) and serves `POST /api/forge`
//!   `{need, routineId?, capabilityId?, fromSurface?}` → `{runId}`.
//! - [`ForgeModule::forge`]: the port behind `request_capability` and
//!   `forge_report`. A need written with outside text in it is refused, so
//!   a Forge run always starts trusted.
//!
//! Logs carry run ids and stages; never needs, reports or settings.

mod answer;
mod blueprint;
mod package;
mod proposal;
mod request;
mod rollback;
mod routes;
mod steps;
mod tested;

use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use eos_capabilities::{CAPABILITIES_CHANGE, CapabilityService};
use eos_contracts::CapabilitiesChange;
use eos_core::shell::SecretPrompt;
use eos_domain::capability::health::{HealthState, StateCode};
use eos_runtime::bus::{Bus, RecvError};

use eos_contracts::WorkerDefinitionRecord;
use eos_core::capability::CapabilityCalls;
use eos_core::forge::Forge;
use eos_core::routine::{BuiltinRoutines, RunStarter};
use eos_core::store::Store;
use eos_core::{BoxFuture, Clock};
use eos_runtime::module::{Module, ModuleError};
use eos_runtime::router::RouteDef;

pub use answer::LIVE_CALLS_MAX;
pub use blueprint::{SLUG, blueprint};
pub use proposal::{PRODUCER, PROPOSAL_EVENT};
pub use request::report_event;
pub use rollback::{ROLLBACK_WITHIN_MS, ROLLED_BACK};
pub use steps::{ForgeSteps, ForgeStepsParts, PROPOSE_STEP, REGISTRY_HOSTS, TEST_STEP, build_folder};
pub use tested::TEST_EVENT;

/// How many capability changes wait for the rollback watch.
const CHANGES_QUEUED: usize = 64;

pub struct ForgeParts {
    pub store: Arc<dyn Store>,
    pub clock: Arc<dyn Clock>,
    pub runs: Arc<dyn RunStarter>,
    pub builtins: Arc<dyn BuiltinRoutines>,
    pub capabilities: Arc<dyn CapabilityCalls>,
    /// The `forge-*` worker definitions the routine's sessions are made from.
    pub definitions: Vec<WorkerDefinitionRecord>,
    /// The routine's system steps, also given to the routines.
    pub steps: Arc<ForgeSteps>,
    /// Installs and rolls back what the user said yes to.
    pub service: Arc<CapabilityService>,
    /// The window shell's secret prompt; none without a window.
    pub prompt: Option<Arc<dyn SecretPrompt>>,
    pub bus: Bus,
}

impl std::fmt::Debug for ForgeParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ForgeParts").finish_non_exhaustive()
    }
}

pub struct ForgeModule {
    service: Arc<request::ForgeService>,
    proposals: Arc<answer::Proposals>,
    builtins: Arc<dyn BuiltinRoutines>,
    definitions: Vec<WorkerDefinitionRecord>,
    bus: Bus,
    watch: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl std::fmt::Debug for ForgeModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ForgeModule").finish_non_exhaustive()
    }
}

impl ForgeModule {
    pub fn new(parts: ForgeParts) -> Self {
        let ForgeParts {
            store,
            clock,
            runs,
            builtins,
            capabilities,
            definitions,
            steps,
            service: installer,
            prompt,
            bus,
        } = parts;
        let service = Arc::new(request::ForgeService {
            store,
            clock,
            runs,
            capabilities,
            routine: OnceLock::new(),
            steps: steps.clone(),
        });
        let proposals = Arc::new(answer::Proposals::new(steps, installer, prompt, service.clone()));
        Self { service, proposals, builtins, definitions, bus, watch: Mutex::new(None) }
    }

    /// From now on, a version the Forge installed that fails its health
    /// within a day goes back to the one before.
    fn watch(&self) {
        let mut changes = self.bus.subscribe(CAPABILITIES_CHANGE, CHANGES_QUEUED);
        // Weakly: a closed app lets its database go while this waits.
        let proposals = Arc::downgrade(&self.proposals);
        let task = tokio::spawn(async move {
            loop {
                let change = match changes.recv().await {
                    Ok(event) => event.payload_as::<CapabilitiesChange>(),
                    Err(RecvError::Lagged(missed)) => {
                        tracing::debug!(missed, "capability changes were missed");
                        continue;
                    }
                    Err(RecvError::Closed) => return,
                };
                let Ok(change) = change else { continue };
                let state = HealthState::parse(&change.state).unwrap_or(HealthState::Ready);
                let code = change.state_code.as_deref().and_then(StateCode::parse);
                if !rollback::failing(state, code.as_ref()) {
                    continue;
                }
                let Some(proposals) = proposals.upgrade() else { return };
                if let Err(error) = rollback::back_if_young(&proposals.steps, &proposals.capabilities, &change.id).await
                {
                    tracing::warn!(capability = %change.id, %error, "a failing new version could not go back");
                }
            }
        });
        *self.watch.lock().unwrap_or_else(PoisonError::into_inner) = Some(task);
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
        routes::all(&self.service, &self.proposals)
    }

    fn after_ready(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        Box::pin(async move {
            self.keep().await?;
            self.watch();
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let task = self.watch.lock().unwrap_or_else(PoisonError::into_inner).take();
            if let Some(task) = task {
                task.abort();
                let _ = task.await;
            }
        })
    }
}
