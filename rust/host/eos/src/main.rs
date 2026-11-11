//! The Eos application: starts the window shell and hands it the core.
//!
//! The core is `eos-app`, built from the data folder named by `EOS_HOME`; the shell reaches
//! its router in process. While routes are still being ported, the `dev-proxy` feature sends
//! every route the router does not declare to an isolated Node daemon (see `dev.rs`).

#[cfg(feature = "dev-proxy")]
mod dev;

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use eos_bridge::{Bridge, Classify, Core, RouterCore};
use eos_shell::{Hooks, Options, Ports};

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
    }
}

/// How long quitting waits for the modules to stop before it gives up on them.
const SHUTDOWN: Duration = Duration::from_secs(5);

struct Eos {
    /// The core's data folder. There is no default while the port is under way: the app
    /// must never open the real `~/.eos` by accident.
    home: Option<PathBuf>,
    app: OnceLock<(Arc<eos_app::App>, tokio::runtime::Handle)>,
    #[cfg(feature = "dev-proxy")]
    dev: dev::Dev,
}

impl Eos {
    /// Builds and starts the core; `None` when there is no data folder or it did not start.
    fn start_core(&self, ports: &Ports) -> Option<Arc<RouterCore>> {
        let Some(home) = &self.home else {
            eprintln!("eos: EOS_HOME is not set: running without the Rust core");
            return None;
        };
        // Building the app spawns its own tasks.
        let _runtime = ports.rt.enter();
        let app = match eos_app::App::build(eos_app::Options::new(home)) {
            Ok(app) => Arc::new(app),
            Err(e) => {
                eprintln!("eos: the core could not be built: {e}");
                return None;
            }
        };
        if let Err(e) = ports.rt.block_on(app.start()) {
            eprintln!("eos: the core did not start: {e}");
            return None;
        }
        let callers = app.callers().clone();
        let ui_token = callers.ui_token().to_owned();
        let classify: Classify = Arc::new(move |token| callers.classify(token));
        let core = Arc::new(RouterCore::new(app.router(), ui_token, classify, ports.rt.clone()));
        let _ = self.app.set((app, ports.rt.clone()));
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

    fn started(&self, _bridge: &Arc<Bridge>, _ports: &Ports) {
        #[cfg(feature = "dev-proxy")]
        self.dev.started(_bridge, _ports);
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
    let hooks = Eos {
        home: env("EOS_HOME").map(PathBuf::from),
        app: OnceLock::new(),
        #[cfg(feature = "dev-proxy")]
        dev: dev::Dev::from_env(),
    };
    std::process::exit(eos_shell::run(options(), Arc::new(hooks)));
}
