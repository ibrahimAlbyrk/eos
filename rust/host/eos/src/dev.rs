//! Development only (`dev-proxy`): an isolated Node daemon answers the routes the Rust
//! router does not declare yet.
//!
//! - `EOS_DEV_DAEMON_URL` / `EOS_DEV_DAEMON_RAW_URL`: the daemon's two origins.
//! - `EOS_DEV_DAEMON_HOME`: its data folder; its ui-token is read from there.
//! - `EOS_DEV_ALLOW_AGENTS=1`: let the Rust core answer the requests that can start an agent, a
//!   model call or a command, reach another computer, or change files outside the data folder.
//!   Without it a dev run refuses them (`eos_bridge::dev::guard`).
//! - `EOS_DEV_SCRIPT` / `EOS_DEV_SCRIPT_OUT`: a list of steps to run on test views once the
//!   app is up, and where to write what they returned (see [`script`]).

mod script;

use std::path::PathBuf;
use std::sync::Arc;

use eos_bridge::dev::{DevDaemon, DevDaemonConfig, Hybrid, spawn_notifications};
use eos_bridge::{Bridge, Core, NoCore, RouterCore};
use eos_runtime::router::Router;
use eos_shell::Ports;

use crate::env;

pub(crate) struct Dev {
    config: DevDaemonConfig,
}

impl Dev {
    pub(crate) fn from_env() -> Self {
        let api_base = env("EOS_DEV_DAEMON_URL").unwrap_or_else(|| "http://127.0.0.1:7490".into());
        let raw_base = env("EOS_DEV_DAEMON_RAW_URL").unwrap_or_else(|| "http://127.0.0.1:7491".into());
        let ui_token = env("EOS_DEV_DAEMON_HOME")
            .and_then(|home| std::fs::read_to_string(PathBuf::from(home).join("ui-token")).ok())
            .map(|token| token.trim().to_string())
            .unwrap_or_default();
        Dev { config: DevDaemonConfig { api_base, raw_base, ui_token } }
    }

    /// The Rust router where it declares a route, the daemon everywhere else; the daemon
    /// alone when the Rust core is not running.
    pub(crate) fn core(&self, rust: Option<Arc<RouterCore>>, ports: &Ports) -> Arc<dyn Core> {
        let daemon = match DevDaemon::new(self.config.clone(), ports.rt.clone()) {
            Ok(daemon) => Arc::new(daemon),
            Err(_) => return Arc::new(NoCore { ui_token: self.config.ui_token.clone() }),
        };
        let Some(rust) = rust else { return daemon };
        // The Rust core runs agents itself: a dev run refuses what could start one, reach
        // another computer or change the user's own folders, unless it was started to try
        // exactly that.
        let hybrid = Hybrid::new(rust, daemon).allow_agents(env("EOS_DEV_ALLOW_AGENTS").as_deref() == Some("1"));
        // The core's data folder is a copy of real data: the Files panel may write there only.
        match env("EOS_HOME") {
            Some(home) => {
                Arc::new(hybrid.data_folder(std::fs::canonicalize(&home).unwrap_or_else(|_| PathBuf::from(home))))
            }
            None => Arc::new(hybrid),
        }
    }

    /// `router`: the Rust core's, when it runs, for the script's browser steps.
    pub(crate) fn started(&self, bridge: &Arc<Bridge>, ports: &Ports, router: Option<Arc<Router>>) {
        spawn_notifications(self.config.clone(), bridge.clone(), &ports.rt);
        if let (Some(steps), Some(out)) = (env("EOS_DEV_SCRIPT"), env("EOS_DEV_SCRIPT_OUT")) {
            let run = script::run(PathBuf::from(steps), PathBuf::from(out), bridge.clone(), ports.clone(), router);
            ports.rt.spawn(run);
        }
    }
}
