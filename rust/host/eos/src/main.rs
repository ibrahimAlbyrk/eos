//! The Eos application: starts the window shell and hands it the core.
//!
//! The core is `eos-app`, built from the data folder (`data_folder`); the shell reaches its
//! router in process. While routes are still being ported, the `dev-proxy` feature sends
//! every route the router does not declare to an isolated Node daemon (see `dev.rs`).

#[cfg(feature = "dev-proxy")]
mod dev;
mod follow;

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use eos_bridge::launch::{data_folder, reaches_network};
use eos_bridge::splash::update_caption;
use eos_bridge::{Bridge, Classify, Core, RouterCore};
use eos_contracts::update::UpdateApply;
use eos_core::BoxFuture;
use eos_core::net::updates::UpdateApplier;
use eos_shell::{Hooks, Options, Ports};
use eos_update::handover::{ApplierLauncher, Handover};

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn home() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
}

/// The dashboard next to the executable in a bundle (`Contents/Resources/dist`).
fn bundled_dist() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dist = exe.parent()?.parent()?.join("Resources").join("dist");
    dist.join("index.html").is_file().then_some(dist)
}

/// What ships beside the program in a bundle (`Contents/Resources`): the esbuild that builds
/// plugins and the skill that teaches agents to write them. `None` outside a bundle, where
/// the core falls back to the repository it was built in.
fn bundled_resources() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let resources = exe.parent()?.parent()?.join("Resources");
    resources.is_dir().then_some(resources)
}

fn options() -> Options {
    let data_dir = env("EOS_SHELL_DATA")
        .map_or_else(|| home().join("Library/Application Support/com.ibrahimalbyrk.eos"), PathBuf::from);
    // The Electron app's profile, for the one-time carry-over. `none` skips it.
    let electron_profile = match env("EOS_ELECTRON_PROFILE").as_deref() {
        Some("none") => None,
        Some(path) => Some(PathBuf::from(path)),
        None => Some(home().join("Library/Application Support/Eos")),
    };
    Options {
        name: "Eos".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        data_dir,
        ui_dist: env("EOS_UI_DIST").map(PathBuf::from).or_else(bundled_dist).unwrap_or_else(|| PathBuf::from("dist")),
        electron_profile,
        args: std::env::args().skip(1).collect(),
        quiet: env("EOS_SHELL_QUIET").is_some(),
        mock_keychain: env("EOS_SHELL_MOCK_KEYCHAIN").is_some(),
        network_in_process: env("EOS_SHELL_NETWORK_IN_PROCESS").is_some(),
        paint_when_covered: env("EOS_SHELL_PAINT_WHEN_COVERED").is_some(),
        artifact_origin: artifact_origin(),
        // The measuring probe drives the dashboard: a build with the dev proxy only.
        probe: cfg!(feature = "dev-proxy") && env("EOS_SHELL_PROBE").is_some(),
    }
}

/// A page on this computer standing in for claude.ai in the artifact views, for a test run:
/// read only by a build with the dev proxy, and only a loopback address.
fn artifact_origin() -> Option<String> {
    if !cfg!(feature = "dev-proxy") {
        return None;
    }
    env("EOS_DEV_ARTIFACT_ORIGIN").filter(|origin| origin.starts_with("http://127.0.0.1:"))
}

/// A release build: no dev proxy, so every route is the Rust core's.
const RELEASE: bool = cfg!(not(feature = "dev-proxy"));

/// The update hand-over with its splash: shown before the applier starts, up until the app
/// has quit; closed again when the restart failed (the dashboard says why).
struct WithSplash {
    launcher: ApplierLauncher,
    splash: Arc<dyn Fn(Option<String>) + Send + Sync>,
}

impl UpdateApplier for WithSplash {
    fn apply<'a>(&'a self, apply: &'a UpdateApply) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let (splash, caption) = (self.splash.clone(), update_caption(&apply.from.0, &apply.version.0));
            let _ = tokio::task::spawn_blocking(move || splash(Some(caption))).await;
            let applied = self.launcher.apply(apply).await;
            if applied.is_err() {
                let splash = self.splash.clone();
                let _ = tokio::task::spawn_blocking(move || splash(None)).await;
            }
            applied
        })
    }
}

/// How long quitting waits for the modules to stop before it gives up on them.
const SHUTDOWN: Duration = Duration::from_secs(5);
/// How long after a wake the updater is told (as today).
const AFTER_WAKE: Duration = Duration::from_secs(10);

struct Eos {
    /// The core's data folder (`data_folder`).
    home: Option<PathBuf>,
    /// The built dashboard, which a computer controlling this one loads too.
    dist: PathBuf,
    app: OnceLock<(Arc<eos_app::App>, tokio::runtime::Handle)>,
    /// The core's own runtime (`eos_app::runtime`): the shell's small one stays free for
    /// the window's bridges whatever the core is doing.
    rt: tokio::runtime::Runtime,
    #[cfg(feature = "dev-proxy")]
    dev: dev::Dev,
}

impl Eos {
    /// Builds and starts the core; `None` when there is no data folder or it did not start.
    fn start_core(&self, ports: &Ports) -> Option<Arc<RouterCore>> {
        let Some(home) = &self.home else {
            eprintln!("eos: EOS_HOME is not set (a development build has no default): running without the Rust core");
            return None;
        };
        // Building the app spawns its own tasks.
        let _runtime = self.rt.enter();
        let resources = bundled_resources();
        let real_data = *home == crate::home().join(".eos");
        let network = reaches_network(home, &crate::home(), RELEASE);
        // Only the user's own data folder knows every chat: a copy of it (a development run) lacks the
        // chats made since, so it must not judge which worktrees in the user's repositories are orphans.
        let mut options = eos_app::Options {
            // The PDF viewer ships beside the program, for the raw-content origin.
            pdfjs_root: resources.as_ref().map(|dir| dir.join("pdfjs")).filter(|dir| dir.is_dir()),
            resources,
            plugin_previewer: ports.previewer.clone(),
            shell: Some(eos_app::Shell {
                views: ports.views.clone(),
                panel: ports.panel.clone(),
                picker: ports.picker.clone(),
                opener: ports.opener.clone(),
            }),
            sweep_leftovers: real_data,
            relay: network.then(eos_app::relay),
            peer_network: network,
            dashboard: Some(self.dist.clone()).filter(|dist| dist.join("index.html").is_file()),
            ..eos_app::Options::new(home)
        };
        // Restarting into an update: show the splash, leave the applier what it needs, start
        // it, quit.
        if let Some(exe) = &options.exec_path {
            let handover = Handover::beside(exe, home);
            let launcher = ApplierLauncher::new(handover, ports.quit.clone());
            options.update_applier = Some(Arc::new(WithSplash { launcher, splash: ports.splash.clone() }));
        }
        let app = match eos_app::App::build(options) {
            Ok(app) => Arc::new(app),
            Err(e) => {
                eprintln!("eos: the core could not be built: {e}");
                return None;
            }
        };
        if let Err(e) = self.rt.block_on(app.start()) {
            eprintln!("eos: the core did not start: {e}");
            return None;
        }
        let callers = app.callers().clone();
        let ui_token = callers.ui_token().to_owned();
        let classify: Classify = Arc::new(move |token, target| callers.classify_for(token, target));
        let core = Arc::new(
            RouterCore::new(app.router(), ui_token, classify, self.rt.handle().clone()).with_raw(app.raw_router()),
        );
        let _ = self.app.set((app, self.rt.handle().clone()));
        Some(core)
    }
}

impl Hooks for Eos {
    fn core(&self, ports: &Ports) -> Arc<dyn Core> {
        let rust = self.start_core(ports);
        #[cfg(feature = "dev-proxy")]
        return self.dev.core(rust, ports);
        #[cfg(not(feature = "dev-proxy"))]
        match rust {
            Some(core) => core,
            None => Arc::new(eos_bridge::NoCore::default()),
        }
    }

    fn started(&self, bridge: &Arc<Bridge>, _ports: &Ports) {
        if let Some((app, rt)) = self.app.get() {
            follow::events(&app.runtime().kernel.bus, bridge, rt);
            // The panel's "pick an element" mode is the browser feature's.
            bridge.set_element_picker(app.element_picker());
            // After an update the applier waits for this, and puts the previous version
            // back without it.
            app.mark_update_booted();
            app.update_signals().window_shown();
        }
        #[cfg(feature = "dev-proxy")]
        self.dev.started(bridge, _ports, self.app.get().map(|(app, _)| app.router()));
    }

    fn window_shown(&self) {
        if let Some((app, _)) = self.app.get() {
            app.update_signals().window_shown();
        }
    }

    fn woke(&self, _away: Duration) {
        if let Some((app, rt)) = self.app.get() {
            // A link that died in the computer's sleep is probed at once.
            app.peering().kick();
            let signals = app.update_signals();
            // The network needs a moment after a wake.
            rt.spawn(async move {
                tokio::time::sleep(AFTER_WAKE).await;
                signals.woke();
            });
        }
    }

    fn shutdown(&self) {
        if let Some((app, rt)) = self.app.get() {
            let report = rt.block_on(app.shutdown(SHUTDOWN));
            tracing::info!(target: "eos", ?report, "the core stopped");
        }
    }
}

/// Logs go to stderr; `EOS_LOG` picks what is shown (`eos::bridge=debug` shows which side
/// served each request), warnings by default.
fn init_logs() {
    let filter = tracing_subscriber::EnvFilter::try_new(env("EOS_LOG").unwrap_or_else(|| "warn".into()))
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn"));
    let _ = tracing_subscriber::fmt().with_env_filter(filter).with_writer(std::io::stderr).with_ansi(false).try_init();
}

fn main() {
    init_logs();
    let options = options();
    let rt = match eos_app::runtime() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("eos: no runtime for the core: {e}");
            std::process::exit(1);
        }
    };
    let hooks = Eos {
        home: data_folder(env("EOS_HOME").map(PathBuf::from), &home(), RELEASE),
        dist: options.ui_dist.clone(),
        app: OnceLock::new(),
        rt,
        #[cfg(feature = "dev-proxy")]
        dev: dev::Dev::from_env(),
    };
    std::process::exit(eos_shell::run(options, Arc::new(hooks)));
}
