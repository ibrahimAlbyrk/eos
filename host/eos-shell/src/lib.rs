//! The window shell: Tauri 3 on CEF. This is the only crate that sees Tauri or CEF types;
//! what it offers the rest of the app is plain data, the core's view ports and the bridge.
//!
//! The binary calls [`run`] with its [`Options`] and [`Hooks`]; the shell owns the process
//! from there: single instance, the window (shown or kept hidden as the launch decides,
//! `eos_bridge::launch`) and its menu, the menu-bar item, the dashboard view with the
//! in-process handler of the app's own origin, child views for the core, and quitting.

mod app;
mod catch;
mod host;
mod log;
mod menu;
mod native;
mod probe;
mod quit;
mod scheme;
mod splash;
mod tray;
mod views;
mod window;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use eos_bridge::{Bridge, Core};
use eos_core::accounts::Browser;
use eos_core::os::{DockBadge, WorkHold};
use eos_core::plugin::PluginPreviewer;
use eos_core::shell::{BrowserPanel, BrowserViews, Capture, FilePicker};

pub use crate::app::SignInWindows;
pub use crate::probe::Probe;
pub use crate::tray::{MenuState, NextRun};

/// How the shell is started.
#[derive(Debug, Clone)]
pub struct Options {
    /// The app's name, as the menu shows it.
    pub name: String,
    pub version: String,
    /// The shell's own data folder: the Chromium profile, window state, one-time markers
    /// and the single-instance socket.
    pub data_dir: PathBuf,
    /// The app's logs (`shell.log`, `core.log`; `eos_bridge::launch::logs_folder`), opened
    /// once this process is the running app. `None`: stderr only.
    pub logs: Option<PathBuf>,
    /// The built dashboard (`app/ui/dist`).
    pub ui_dist: PathBuf,
    /// What the app ships beside its executable (`Contents/Resources`); `None` outside a bundle.
    pub resources: Option<PathBuf>,
    /// The Electron app's profile folder, read once to carry `localStorage` over.
    pub electron_profile: Option<PathBuf>,
    /// The launch's arguments, without the program name.
    pub args: Vec<String>,
    /// Start without taking the focus or a Dock icon, with audio muted. For automated runs;
    /// they also set `TAURI_CEF_NO_ACTIVATE=1` in the environment (see `host/patches`).
    pub quiet: bool,
    /// Keep Chromium's cookie key out of the login keychain. For runs on test data.
    pub mock_keychain: bool,
    /// Run Chromium's network service inside the browser process: one process and about
    /// 14 MB less, at the price of its crash isolation and its own sandbox. Off by default.
    pub network_in_process: bool,
    /// Keep painting while other windows cover the app's. For memory measurements.
    pub paint_when_covered: bool,
    /// A local page standing in for claude.ai in the artifact views (a test run's server,
    /// `http://127.0.0.1:<port>`). The binary sets it only in a build with the dev proxy.
    pub artifact_origin: Option<String>,
    /// A local page standing in for the identity provider whose popup the claude.ai
    /// sign-in window opens (a test run's server, `http://localhost:<port>`). Set only with
    /// [`artifact_origin`](Self::artifact_origin), in a build with the dev proxy.
    pub sign_in_provider: Option<String>,
    /// Start the measuring probe (`Ports::probe`): for responsiveness runs only.
    pub probe: bool,
    /// How long the window stays hidden before the dashboard's view is released
    /// (`eos_bridge::dashboard_life`). Shorter only in a test run.
    pub dashboard_release_after: Duration,
    /// Whether this app may be a login item (Start at login): the installed app only. A
    /// test or dev run has another identity and never registers one.
    pub login_item: bool,
    /// A development or test run: its menu-bar item says "(dev)", beside the installed app's.
    pub dev_run: bool,
}

/// What the shell offers the core.
#[derive(Clone)]
pub struct Ports {
    pub views: Arc<dyn BrowserViews>,
    /// The dashboard's browser panel: where a view comes on screen.
    pub panel: Arc<dyn BrowserPanel>,
    pub capture: Arc<dyn Capture>,
    pub picker: Arc<dyn FilePicker>,
    /// Draws a plugin's surface in a hidden view of the dashboard's bundle.
    pub previewer: Arc<dyn PluginPreviewer>,
    /// Opens a web page outside the app, the way the shell opens every external link.
    pub opener: Arc<dyn Browser>,
    /// Keeps the app out of App Nap while routines run or wait: one system activity per
    /// reason while any hold of it lives.
    pub work_hold: Arc<dyn WorkHold>,
    /// The number on the app's Dock icon.
    pub dock_badge: Arc<dyn DockBadge>,
    /// What the menu-bar item shows; the item follows each state handed in.
    pub menu_state: Arc<dyn Fn(MenuState) + Send + Sync>,
    /// The runtime the shell's own tasks run on.
    pub rt: tokio::runtime::Handle,
    /// Quits the app as its menu does: the shutdown hook runs, then the process exits.
    pub quit: Arc<dyn Fn() + Send + Sync>,
    /// The restart splash: `Some(caption)` shows it above every window until the app quits,
    /// `None` closes it again (the restart failed). Blocking.
    pub splash: Arc<dyn Fn(Option<String>) + Send + Sync>,
    /// Hides the window as its close button does. For a test run's script.
    pub hide_window: Arc<dyn Fn() + Send + Sync>,
    /// The measuring probe, when `Options::probe` asked for it.
    pub probe: Option<Arc<Probe>>,
    /// The claude.ai sign-in windows, when the artifact views show a stand-in.
    pub sign_in: Option<SignInWindows>,
}

impl std::fmt::Debug for Ports {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ports").finish_non_exhaustive()
    }
}

/// What quitting now would interrupt.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct QuitCheck {
    /// Runs of routines working now. They continue when the app opens again.
    pub active_runs: u32,
}

/// What the app passes in. Every method is called at most a few times, from shell threads.
pub trait Hooks: Send + Sync + 'static {
    /// Builds the core's router from the shell's ports. Called once, before the first page.
    fn core(&self, ports: &Ports) -> Arc<dyn Core>;

    /// The bridge exists and answers requests, whether or not the window shows. Called once.
    fn bridge_ready(&self, _bridge: &Arc<Bridge>, _ports: &Ports) {}

    /// The dashboard is loading: the window was shown. A hidden start (at login,
    /// `--background`) calls this only when the window is first shown.
    fn dashboard_loaded(&self) {}

    /// The window was brought back: a click on the Dock icon, a later launch, a link. Not for
    /// the showing that loads the dashboard: [`Hooks::dashboard_loaded`] stands for it.
    fn window_shown(&self) {}

    /// The Mac slept for about this long and is awake again.
    fn woke(&self, _away: Duration) {}

    /// The system handed the app a link (`eos://pair/…`).
    fn open_url(&self, _url: &str) {}

    /// What a Quit the user asked for (the app menu, the menu-bar item) would interrupt; the
    /// shell asks before it quits when runs work. Called on the main thread: answers at once.
    fn quit_check(&self) -> QuitCheck {
        QuitCheck::default()
    }

    /// The app is quitting: stop everything. Called once; the process exits when it returns.
    fn shutdown(&self) {}
}

/// Runs the app until it quits and returns the process's exit code. A launch that finds the
/// app already running hands its request over and returns at once.
pub fn run(options: Options, hooks: Arc<dyn Hooks>) -> i32 {
    app::run(options, hooks)
}
