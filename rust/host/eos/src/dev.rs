//! A development or test run (`dev-run`): the app on a copy of real data.
//!
//! - The core answers behind the dev guard (`eos_bridge::dev`): nothing that could start an
//!   agent, a model call or a command, reach another computer, or change files outside the
//!   data folder. `EOS_DEV_ALLOW_AGENTS=1` lets those through, for a run meant to try them.
//! - `EOS_DEV_SCRIPT` / `EOS_DEV_SCRIPT_OUT`: a list of steps to run on test views once the
//!   app is up, and where to write what they returned (see [`script`]).

mod script;

use std::path::PathBuf;
use std::sync::Arc;

use eos_bridge::dev::Guarded;
use eos_bridge::{Bridge, Core, RouterCore};
use eos_runtime::router::Router;
use eos_shell::Ports;

use crate::env;

/// The core behind the guard.
pub(crate) fn guarded(rust: Arc<RouterCore>) -> Arc<dyn Core> {
    let guarded = Guarded::new(rust).allow_agents(env("EOS_DEV_ALLOW_AGENTS").as_deref() == Some("1"));
    // The core's data folder is a copy of real data: the Files panel may write there only.
    match env("EOS_HOME") {
        Some(home) => {
            Arc::new(guarded.data_folder(std::fs::canonicalize(&home).unwrap_or_else(|_| PathBuf::from(home))))
        }
        None => Arc::new(guarded),
    }
}

/// `router`: the Rust core's, when it runs, for the script's browser steps.
pub(crate) fn started(bridge: &Arc<Bridge>, ports: &Ports, router: Option<Arc<Router>>) {
    if let (Some(steps), Some(out)) = (env("EOS_DEV_SCRIPT"), env("EOS_DEV_SCRIPT_OUT")) {
        let run = script::run(PathBuf::from(steps), PathBuf::from(out), bridge.clone(), ports.clone(), router);
        ports.rt.spawn(run);
    }
}
