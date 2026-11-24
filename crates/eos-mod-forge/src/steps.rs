//! The Forge's part of its routine's runs (01 G49): the build folder its
//! team works in, and the milestones Eos runs itself (`forge.test`,
//! `forge.propose`).

use std::path::PathBuf;
use std::sync::Arc;

use eos_core::os::FileSystem;
use eos_core::routine::{StepResult, SystemStepCall, SystemSteps};
use eos_core::{BoxFuture, Error};
use serde_json::json;

/// The hosts the builder's shell reaches without asking: package registries.
/// Any other host the engine's sandbox asks Eos's gate about.
pub const REGISTRY_HOSTS: [&str; 6] =
    ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "crates.io", "static.crates.io", "index.crates.io"];

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

pub struct ForgeSteps {
    files: Arc<dyn FileSystem>,
    /// `<data folder>/scratch`.
    scratch: PathBuf,
}

impl std::fmt::Debug for ForgeSteps {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ForgeSteps").field("scratch", &self.scratch).finish_non_exhaustive()
    }
}

impl ForgeSteps {
    pub fn new(files: Arc<dyn FileSystem>, scratch: PathBuf) -> Self {
        Self { files, scratch }
    }

    async fn prepare(&self, run_id: &str) -> Result<Option<String>, Error> {
        if run_id.is_empty() || !run_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err(Error::Validation(format!("run id {run_id:?} names no folder")));
        }
        let folder = build_folder(&self.scratch, run_id);
        self.files.write_text(&folder.join(".claude/settings.json"), &sandbox_settings(), true).await?;
        tracing::info!(run_id, "a Forge run's build folder was made");
        Ok(Some(folder.to_string_lossy().into_owned()))
    }
}

impl SystemSteps for ForgeSteps {
    fn run(&self, call: SystemStepCall) -> BoxFuture<'_, Result<StepResult, Error>> {
        let reason = format!("No part of this Eos runs the step `{}`.", call.step);
        Box::pin(std::future::ready(Ok(StepResult::Failed { reason })))
    }

    fn prepare_folder<'a>(&'a self, run_id: &'a str) -> BoxFuture<'a, Result<Option<String>, Error>> {
        Box::pin(self.prepare(run_id))
    }
}
