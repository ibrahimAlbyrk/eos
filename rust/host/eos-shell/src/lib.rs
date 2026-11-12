//! The window shell: Tauri 3 on CEF. This is the only crate that sees Tauri or CEF types;
//! what it offers the rest of the app is plain data, the core's view ports and the bridge.
//!
//! The binary calls [`run`] with its [`Options`] and [`Hooks`]; the shell owns the process
//! from there: single instance, the window and its menu, the dashboard view with the
//! in-process handler of the app's own origin, child views for the core, and quitting.

mod app;
mod host;
mod log;
mod menu;
mod native;
mod scheme;
mod views;
mod window;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use eos_bridge::{Bridge, Core};
use eos_core::shell::{BrowserViews, Capture, FilePicker};

/// How the shell is started.
#[derive(Debug, Clone)]
pub struct Options {
    /// The app's name, as the menu shows it.
    pub name: String,
    pub version: String,
    /// The shell's own data folder: the Chromium profile, window state, one-time markers,
    /// the single-instance socket and the log.
    pub data_dir: PathBuf,
    /// The built dashboard (`app/ui/dist`).
    pub ui_dist: PathBuf,
    /// The Electron app's profile folder, read once to carry `localStorage` over.
    pub electron_profile: Option<PathBuf>,
    /// The launch's arguments, without the program name.
    pub args: Vec<String>,
    /// Start without taking the focus or a Dock icon, with audio muted. For automated runs;
    /// they also set `TAURI_CEF_NO_ACTIVATE=1` in the environment (see `host/patches`).
    pub quiet: bool,
    /// Keep Chromium's cookie key out of the login keychain. For runs on test data.
    pub mock_keychain: bool,
}

/// What the shell offers the core.
#[derive(Clone)]
pub struct Ports {
    pub views: Arc<dyn BrowserViews>,
    pub capture: Arc<dyn Capture>,
    pub picker: Arc<dyn FilePicker>,
    /// The runtime the shell's own tasks run on.
    pub rt: tokio::runtime::Handle,
    /// Quits the app as its menu does: the shutdown hook runs, then the process exits.
    pub quit: Arc<dyn Fn() + Send + Sync>,
}

impl std::fmt::Debug for Ports {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ports").finish_non_exhaustive()
    }
}

/// What the app passes in. Every method is called at most a few times, from shell threads.
pub trait Hooks: Send + Sync + 'static {
    /// Builds the core's router from the shell's ports. Called once, before the first page.
    fn core(&self, ports: &Ports) -> Arc<dyn Core>;

    /// The dashboard is loading: the bridge exists and requests are being answered.
    fn started(&self, _bridge: &Arc<Bridge>, _ports: &Ports) {}

    /// The window was brought back: a click on the Dock icon, a later launch, a link.
    fn window_shown(&self) {}

    /// The Mac slept for about this long and is awake again.
    fn woke(&self, _away: Duration) {}

    /// The system handed the app a link (`eos://pair/…`).
    fn open_url(&self, _url: &str) {}

    /// The app is quitting: stop everything. Called once; the process exits when it returns.
    fn shutdown(&self) {}
}

/// Runs the app until it quits and returns the process's exit code. A launch that finds the
/// app already running hands its request over and returns at once.
pub fn run(options: Options, hooks: Arc<dyn Hooks>) -> i32 {
    app::run(options, hooks)
}
