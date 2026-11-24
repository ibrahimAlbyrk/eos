//! The host of capability packages that are code (06 §4.1): it runs the
//! actions of `script` and `mcp` packages as the [`ActionRunner`] the
//! capability service calls, each under the OS sandbox ([`Confinement`])
//! with exactly the reach its manifest declares. Nothing runs unconfined:
//! without the sandbox an action is refused as `sandbox_unavailable`.
//!
//! A script action is its `run` program, started in its package folder with
//! the call's input as JSON on stdin and its answer as JSON on stdout. An
//! MCP action is a tool of the package's one server, a confined child that
//! lives across calls; only the tools its manifest froze at review are
//! believed. Either sees only the environment the manifest gives it (its
//! secrets in their variables, `PATH` and `HOME`), may write only its
//! `data/` folder and its own temp folder. What the sandbox denied is logged
//! by kind and count; inputs, outputs, secrets and paths the code reached
//! are not.
//!
//! [`ActionRunner`]: eos_core::capability::ActionRunner
//! [`Confinement`]: eos_core::capability::Confinement

mod confined;
mod mcp;
mod script;
mod trial;

use mcp::McpHost;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use eos_core::capability::{ActionError, ActionRunner, Confinement, Package};
use eos_core::{BoxFuture, Clock, Ids, Sleeper};
use eos_domain::capability::manifest::Form;
use eos_kit_proc::Runner;
use serde_json::Value;
use zeroize::Zeroizing;

pub use confined::SANDBOX_UNAVAILABLE;
pub use mcp::{CRASH_WINDOW_MS, CRASHES_TO_BREAK, IDLE_STOP_MS, SERVER_CRASHED, SERVERS_ALIVE_MAX, TOOLS_CHANGED};
pub use script::{OUTPUT_MAX_BYTES, ScriptHost};
pub use trial::{LIVE_TIMEOUT, TESTS_TIMEOUT, TOLERATED_READS, Trial, TrialOutcome, judge};

/// Both forms behind one runner: a package's form picks its host.
#[derive(Debug)]
pub struct CapabilityHost {
    script: ScriptHost,
    mcp: McpHost,
}

/// What the host is made of.
pub struct HostParts {
    /// The data folder's `capabilities`.
    pub root: PathBuf,
    /// A folder of Eos's own scratch area.
    pub temp: PathBuf,
    pub confinement: Arc<dyn Confinement>,
    pub runner: Runner,
    pub ids: Arc<dyn Ids>,
    pub clock: Arc<dyn Clock>,
    pub sleeper: Arc<dyn Sleeper>,
}

impl std::fmt::Debug for HostParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostParts").field("root", &self.root).field("temp", &self.temp).finish_non_exhaustive()
    }
}

impl CapabilityHost {
    pub fn new(parts: HostParts) -> Self {
        let script = ScriptHost::new(
            &parts.root,
            &parts.temp,
            parts.confinement.clone(),
            parts.runner.clone(),
            parts.ids.clone(),
        );
        let layout = confined::Layout { root: parts.root, temp: parts.temp, confinement: parts.confinement };
        let mcp = McpHost::new(layout, parts.runner, parts.ids, parts.clock, parts.sleeper);
        Self { script, mcp }
    }
}

impl ActionRunner for CapabilityHost {
    fn run<'a>(
        &'a self,
        package: &'a Package,
        action: &'a str,
        input: Value,
        env: Vec<(String, Zeroizing<String>)>,
        timeout: Duration,
    ) -> BoxFuture<'a, Result<Value, ActionError>> {
        if package.manifest.form != Form::Mcp {
            return self.script.run(package, action, input, env, timeout);
        }
        Box::pin(async move {
            let Some(declared) = package.manifest.actions.iter().find(|a| a.name == action) else {
                return Err(ActionError::NotFound);
            };
            self.mcp.run(package, declared, input, env, timeout).await
        })
    }

    fn stop<'a>(&'a self, id: &'a str) -> BoxFuture<'a, ()> {
        self.mcp.stop(id);
        Box::pin(std::future::ready(()))
    }
}
