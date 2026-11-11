//! Development only (`dev-proxy`): an isolated Node daemon answers the routes the Rust
//! router does not declare yet.
//!
//! - `EOS_DEV_DAEMON_URL` / `EOS_DEV_DAEMON_RAW_URL`: the daemon's two origins.
//! - `EOS_DEV_DAEMON_HOME`: its data folder; its ui-token is read from there.
//! - `EOS_DEV_RUST_STREAM`: let the Rust runtime serve the event stream too (by default the
//!   daemon keeps it, see `eos_bridge::dev::STREAM_ROUTES`).
//! - `EOS_DEV_SCRIPT` / `EOS_DEV_SCRIPT_OUT`: a list of steps to run on test views once the
//!   app is up, and where to write what they returned (see [`script`]).

mod script;

use std::path::PathBuf;
use std::sync::Arc;

use eos_bridge::dev::{
    DevDaemon, DevDaemonConfig, Driver, HostChannel, Hybrid, STREAM_ROUTES, spawn_host_channel, spawn_notifications,
};
use eos_bridge::{Bridge, Core, NoCore, RouterCore};
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
        match rust {
            Some(rust) if env("EOS_DEV_RUST_STREAM").is_some() => Arc::new(Hybrid::new(rust, daemon)),
            Some(rust) => Arc::new(Hybrid::new(rust, daemon).hold_back(STREAM_ROUTES)),
            None => daemon,
        }
    }

    pub(crate) fn started(&self, bridge: &Arc<Bridge>, ports: &Ports) {
        // The daemon's browser verbs are served from the shell's views.
        let (driver, events) = Driver::new(ports.views.clone(), bridge.panel().clone(), ports.rt.clone());
        let url =
            format!("{}/browser/host?uiToken={}", self.config.api_base.replacen("http", "ws", 1), self.config.ui_token);
        let channel =
            HostChannel { url, driver, picker: ports.picker.clone(), app_version: env!("CARGO_PKG_VERSION").into() };
        spawn_host_channel(channel, events, &ports.rt);
        spawn_notifications(self.config.clone(), bridge.clone(), &ports.rt);
        if let (Some(steps), Some(out)) = (env("EOS_DEV_SCRIPT"), env("EOS_DEV_SCRIPT_OUT")) {
            ports.rt.spawn(script::run(PathBuf::from(steps), PathBuf::from(out), bridge.clone(), ports.clone()));
        }
    }
}
