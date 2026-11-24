//! The Forge's part of its routine's runs (01 G49): the build folder its
//! team works in, and the milestones Eos runs itself (`forge.test`,
//! `forge.propose`).

use std::path::PathBuf;
use std::sync::{Arc, OnceLock, Weak};

use eos_capability_host::Trial;
use eos_core::os::{FileSystem, TimeZone};
use eos_core::routine::{RoutineControl, StepResult, SystemStepCall, SystemSteps};
use eos_core::store::Store;
use eos_core::{BoxFuture, Clock, Error, Ids};
use serde_json::json;

/// The hosts the builder's shell reaches without asking: package registries.
/// Any other host the engine's sandbox asks Eos's gate about.
pub const REGISTRY_HOSTS: [&str; 6] =
    ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "crates.io", "static.crates.io", "index.crates.io"];

/// What npm is held to in the build folder.
const NPM_SETTINGS: &str = "ignore-scripts=true\nsave-exact=true\n";

/// The system step that tests the package.
pub const TEST_STEP: &str = "forge.test";
/// The system step that proposes it to the user.
pub const PROPOSE_STEP: &str = "forge.propose";

/// The build folder of the Forge run `run_id`, in the scratch area.
pub fn build_folder(scratch: &std::path::Path, run_id: &str) -> PathBuf {
    scratch.join(format!("forge-{run_id}"))
}

/// The engine's sandbox for every shell command in the build folder: on,
/// failing when the OS sandbox is missing, never bypassed by a command,
/// writes held to the folder, the network to `REGISTRY_HOSTS`, no Apple
/// Events. The folder's project settings are where the engine reads it;
/// the builder's own file edits never reach them (its scope).
fn sandbox_settings() -> String {
    let settings = json!({"sandbox": {
        "enabled": true,
        "failIfUnavailable": true,
        "allowUnsandboxedCommands": false,
        "autoAllowBashIfSandboxed": false,
        "allowAppleEvents": false,
        "network": {"allowedDomains": REGISTRY_HOSTS},
    }});
    format!("{settings:#}\n")
}

/// What the Forge's steps are made of.
/// Where a promoted App's code is in a Forge run's build folder.
pub(crate) const PROMOTED_APP_FOLDER: &str = "app";

pub struct ForgeStepsParts {
    pub store: Arc<dyn Store>,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn Ids>,
    /// The user's time zone, for the items the steps open.
    pub zone: Arc<dyn TimeZone>,
    pub files: Arc<dyn FileSystem>,
    /// `<data folder>/scratch`.
    pub scratch: PathBuf,
    /// Runs a package's tests under the sandbox.
    pub trial: Arc<Trial>,
}

impl std::fmt::Debug for ForgeStepsParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ForgeStepsParts").field("scratch", &self.scratch).finish_non_exhaustive()
    }
}

pub struct ForgeSteps {
    pub(crate) store: Arc<dyn Store>,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) ids: Arc<dyn Ids>,
    pub(crate) zone: Arc<dyn TimeZone>,
    files: Arc<dyn FileSystem>,
    pub(crate) scratch: PathBuf,
    pub(crate) trial: Arc<Trial>,
    /// Pauses a routine with too many items waiting; attached once the
    /// routines exist, which are made with these steps and hold them, so
    /// weakly.
    control: OnceLock<Weak<dyn RoutineControl>>,
}

impl std::fmt::Debug for ForgeSteps {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ForgeSteps").field("scratch", &self.scratch).finish_non_exhaustive()
    }
}

impl ForgeSteps {
    pub fn new(parts: ForgeStepsParts) -> Self {
        let ForgeStepsParts { store, clock, ids, zone, files, scratch, trial } = parts;
        Self { store, clock, ids, zone, files, scratch, trial, control: OnceLock::new() }
    }

    /// Hands in the routines' control, once they exist.
    pub fn attach(&self, control: Arc<dyn RoutineControl>) {
        let _ = self.control.set(Arc::downgrade(&control));
    }

    pub(crate) fn control(&self) -> Result<Arc<dyn RoutineControl>, Error> {
        self.control.get().and_then(Weak::upgrade).ok_or_else(|| Error::Conflict("the Forge is not ready yet".into()))
    }

    /// The build folder of `run_id`.
    pub(crate) fn folder(&self, run_id: &str) -> Result<PathBuf, Error> {
        if run_id.is_empty() || !run_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err(Error::Validation(format!("run id {run_id:?} names no folder")));
        }
        Ok(build_folder(&self.scratch, run_id))
    }

    /// Where the Forge's tests make their data and temp folders.
    pub(crate) fn tests_folder(&self) -> PathBuf {
        self.scratch.join("forge-tests")
    }

    /// Puts the App the user promotes into the run's build folder, under
    /// `app/`, for the team to build the Extension from.
    pub(crate) async fn hand_in_app(&self, run_id: &str, app: &eos_core::surface::PromotedApp) -> Result<(), Error> {
        let folder = self.folder(run_id)?.join(PROMOTED_APP_FOLDER);
        let manifest = serde_json::to_string_pretty(&app.manifest).map_err(|e| Error::storage(e.to_string()))?;
        self.files.write_text(&folder.join("index.html"), &app.html, true).await?;
        self.files.write_text(&folder.join("manifest.json"), &manifest, true).await?;
        Ok(())
    }

    async fn prepare(&self, run_id: &str) -> Result<Option<String>, Error> {
        let folder = self.folder(run_id)?;
        self.files.write_text(&folder.join(".claude/settings.json"), &sandbox_settings(), true).await?;
        // npm reads it from the folder it installs in: a package installed
        // here runs no install script.
        self.files.write_text(&folder.join(".npmrc"), NPM_SETTINGS, true).await?;
        tracing::info!(run_id, "a Forge run's build folder was made");
        Ok(Some(folder.to_string_lossy().into_owned()))
    }
}

impl SystemSteps for ForgeSteps {
    fn run(&self, call: SystemStepCall) -> BoxFuture<'_, Result<StepResult, Error>> {
        Box::pin(async move {
            match call.step.as_str() {
                TEST_STEP => crate::tested::step(self, &call.run_id).await,
                PROPOSE_STEP => crate::proposal::step(self, &call).await,
                other => Ok(StepResult::Failed { reason: format!("No part of this Eos runs the step `{other}`.") }),
            }
        })
    }

    fn prepare_folder<'a>(&'a self, run_id: &'a str) -> BoxFuture<'a, Result<Option<String>, Error>> {
        Box::pin(self.prepare(run_id))
    }
}
