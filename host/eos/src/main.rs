//! The Eos application: starts the window shell and hands it the core.
//!
//! The core is `eos-app`, built from the data folder (`data_folder`); the shell reaches its
//! router in process. A build with the `dev-run` feature is a development or test run on a
//! copy of real data (see `dev.rs`).

#[cfg(feature = "dev-run")]
mod dev;
mod follow;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use eos_bridge::cli::{CliGateway, CliParts};
use eos_bridge::dashboard_life::DASHBOARD_RELEASE_AFTER_MS;
use eos_bridge::launch::{bundle_id_of, data_folder, link_scheme, logs_folder, owns_doors, reaches_network};
use eos_bridge::splash::update_caption;
use eos_bridge::{Bridge, Classify, Core, LateCore, NoCore, RouterCore};
use eos_contracts::update::UpdateApply;
use eos_core::BoxFuture;
use eos_core::net::updates::UpdateApplier;
use eos_shell::{Hooks, Options, Ports, QuitCheck};
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

/// The identifier in the bundle's `Info.plist` (`Contents/Info.plist`); `None` outside a bundle.
fn bundle_id() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let plist = std::fs::read_to_string(exe.parent()?.parent()?.join("Info.plist")).ok()?;
    bundle_id_of(&plist).map(str::to_string)
}

/// The command a Code-mode pane's memory hooks run: this bundle's own `eos`, told which
/// app to ask when the shell folder was named (a test run). `None` outside a bundle.
fn memory_hook() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let helper = exe.parent()?.parent()?.join("Helpers/eos");
    if !helper.is_file() {
        return None;
    }
    let quote = |s: &str| format!("'{}'", s.replace('\'', r"'\''"));
    let named = env("EOS_SHELL_DATA").map(|dir| format!("EOS_SHELL_DATA={} ", quote(&dir))).unwrap_or_default();
    Some(format!("{named}{} memory hook", quote(&helper.to_string_lossy())))
}

/// What kind of build this is, for the log: `release`, or a `dev-run` build (`test`, or
/// `debug` with debug assertions).
const BUILD: &str = if RELEASE {
    "release"
} else if cfg!(debug_assertions) {
    "debug"
} else {
    "test"
};

fn options(core_home: Option<&Path>) -> Options {
    let named = env("EOS_SHELL_DATA");
    let data_dir =
        named.clone().map_or_else(|| home().join("Library/Application Support/com.ibrahimalbyrk.eos"), PathBuf::from);
    let logs = logs_folder(&data_dir, named.is_some(), core_home, &home(), RELEASE);
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
        logs,
        resources: bundled_resources(),
        ui_dist: env("EOS_UI_DIST").map(PathBuf::from).or_else(bundled_dist).unwrap_or_else(|| PathBuf::from("dist")),
        electron_profile,
        args: std::env::args().skip(1).collect(),
        quiet: env("EOS_SHELL_QUIET").is_some(),
        mock_keychain: env("EOS_SHELL_MOCK_KEYCHAIN").is_some(),
        network_in_process: env("EOS_SHELL_NETWORK_IN_PROCESS").is_some(),
        paint_when_covered: env("EOS_SHELL_PAINT_WHEN_COVERED").is_some(),
        artifact_origin: artifact_origin(),
        sign_in_provider: artifact_origin().and(sign_in_provider()),
        // The measuring probe drives the dashboard: a dev run only.
        probe: cfg!(feature = "dev-run") && env("EOS_SHELL_PROBE").is_some(),
        dashboard_release_after: dashboard_release_after(),
        // A test or dev run is another app to the system: it owns no door.
        doors: owns_doors(bundle_id().as_deref(), RELEASE),
        dev_run: !RELEASE,
    }
}

/// How long the window stays hidden before the dashboard's view is released. A test run may
/// shorten it (`EOS_DEV_DASHBOARD_RELEASE_MS`).
fn dashboard_release_after() -> Duration {
    let shortened = if cfg!(feature = "dev-run") {
        env("EOS_DEV_DASHBOARD_RELEASE_MS").and_then(|ms| ms.parse().ok())
    } else {
        None
    };
    Duration::from_millis(shortened.unwrap_or(DASHBOARD_RELEASE_AFTER_MS))
}

/// A page on this computer standing in for claude.ai in the artifact views, for a test run:
/// read only by a dev run, and only a loopback address.
fn artifact_origin() -> Option<String> {
    if !cfg!(feature = "dev-run") {
        return None;
    }
    env("EOS_DEV_ARTIFACT_ORIGIN").filter(|origin| origin.starts_with("http://127.0.0.1:"))
}

/// A page on this computer standing in for the identity provider of the claude.ai sign-in
/// window's popup, for a test run: read only by a dev run, and only a loopback address.
fn sign_in_provider() -> Option<String> {
    if !cfg!(feature = "dev-run") {
        return None;
    }
    env("EOS_DEV_SIGNIN_PROVIDER").filter(|origin| origin.starts_with("http://localhost:"))
}

/// A release build: not a dev run, so it opens the user's own data folder unasked and
/// reaches other computers from it (`eos_bridge::launch`).
const RELEASE: bool = cfg!(not(feature = "dev-run"));

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
/// How long quitting waits for a core that is still starting.
const SHUTDOWN_START: Duration = Duration::from_secs(10);
/// How long after a wake the updater is told (as today).
const AFTER_WAKE: Duration = Duration::from_secs(10);

struct Eos {
    /// The core's data folder (`data_folder`).
    home: Option<PathBuf>,
    /// The built dashboard, which a computer controlling this one loads too.
    dist: PathBuf,
    /// The core's own runtime (`eos_app::runtime`): the shell's small one stays free for
    /// the window's bridges whatever the core is doing.
    rt: tokio::runtime::Runtime,
    core: Arc<CoreState>,
    /// The shell's data folder: the terminal's socket goes there.
    shell_data: PathBuf,
    /// How the links the terminal is shown begin (`eos` or `eos-dev`).
    scheme: &'static str,
}

/// The core as the hooks see it, shared with the thread that builds and starts it: the
/// window and the dashboard's page load go on meanwhile (`eos_bridge::LateCore`).
#[derive(Default)]
struct CoreState {
    app: OnceLock<(Arc<eos_app::App>, tokio::runtime::Handle)>,
    /// The core while it starts; unset when there is none to start.
    late: OnceLock<Arc<LateCore>>,
    /// The menu-bar item's counts, once the core is up.
    duty: OnceLock<Arc<follow::Duty>>,
    /// The terminal's gateway, once the core is up; dropped at quit, which removes its socket.
    cli: Mutex<Option<CliGateway>>,
    started: Mutex<Started>,
}

/// What the shell's hooks announced before the core was up, and whether it is up (or failed).
#[derive(Default)]
struct Started {
    /// What `bridge_ready` was handed.
    bridge: Option<(Arc<Bridge>, Ports)>,
    /// Whether `dashboard_loaded` came.
    dashboard: bool,
    settled: bool,
}

impl CoreState {
    fn started(&self) -> std::sync::MutexGuard<'_, Started> {
        self.started.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The core is up or did not start: runs what the hooks announced meanwhile.
    fn settle(&self) {
        let (bridge, dashboard) = {
            let mut started = self.started();
            started.settled = true;
            (started.bridge.take(), std::mem::take(&mut started.dashboard))
        };
        if let Some((bridge, ports)) = bridge {
            self.on_bridge_ready(&bridge, &ports);
        }
        if dashboard {
            self.on_dashboard_loaded();
        }
    }

    /// The bridge answers and the core is up (or will never be), whether or not the window
    /// shows.
    fn on_bridge_ready(&self, bridge: &Arc<Bridge>, ports: &Ports) {
        if let (Some((app, rt)), Some(late)) = (self.app.get(), self.late.get()) {
            let bus = &app.runtime().kernel.bus;
            follow::events(bus, bridge, rt);
            let _ = self.duty.set(follow::Duty::start(bus, rt, late.clone(), ports.menu_state.clone()));
            // The panel's "pick an element" mode is the browser feature's.
            bridge.set_element_picker(app.element_picker());
        }
        #[cfg(feature = "dev-run")]
        dev::started(bridge, ports, self.app.get().map(|(app, _)| (app.router(), app.runtime().kernel.bus.clone())));
    }

    /// The dashboard is loading and the core is up (or will never be).
    fn on_dashboard_loaded(&self) {
        if let Some((app, _)) = self.app.get() {
            // After an update the applier waits for this, and puts the previous version
            // back without it. It opens the app with a plain launch, which loads the dashboard.
            app.mark_update_booted();
            app.update_signals().window_shown();
        }
        tracing::info!(target: "eos", "the window is up");
    }
}

/// Settles the late core when dropped, also by a panic: with `core` once it is set.
struct Settle {
    late: Arc<LateCore>,
    core: Option<Arc<dyn Core>>,
}

impl Drop for Settle {
    fn drop(&mut self) {
        self.late.settle(self.core.take());
    }
}

/// Builds and starts the core; `None` when it did not start.
fn start_core(
    home: &Path,
    dist: &Path,
    rt: &tokio::runtime::Handle,
    ports: &Ports,
    callers: eos_app::Callers,
    memory_hook: Option<String>,
) -> Option<(Arc<eos_app::App>, Arc<RouterCore>)> {
    // Building the app spawns its own tasks.
    let _runtime = rt.enter();
    let resources = bundled_resources();
    let real_data = *home == crate::home().join(".eos");
    // The data folder's kind, never its path.
    let data = if real_data { "own" } else { "other" };
    tracing::info!(target: "eos", version = env!("CARGO_PKG_VERSION"), build = BUILD, data, "the core is starting");
    let network = reaches_network(home, &crate::home(), RELEASE);
    // Only the user's own data folder knows every chat: a copy of it (a development run) lacks the
    // chats made since, so it must not judge which worktrees in the user's repositories are orphans.
    let mut options = eos_app::Options {
        // The PDF viewer ships beside the program, for the raw-content origin.
        pdfjs_root: resources.as_ref().map(|dir| dir.join("pdfjs")).filter(|dir| dir.is_dir()),
        resources,
        plugin_previewer: ports.previewer.clone(),
        page_probe: ports.page_probe.clone(),
        page_printer: ports.page_printer.clone(),
        shell: Some(eos_app::Shell {
            views: ports.views.clone(),
            panel: ports.panel.clone(),
            picker: ports.picker.clone(),
            opener: ports.opener.clone(),
            work_hold: ports.work_hold.clone(),
            dock_badge: ports.dock_badge.clone(),
        }),
        sweep_leftovers: real_data,
        relay: Some(eos_app::relay()),
        hook_client: Some(eos_app::hook_client()),
        keychain: Some(eos_app::keychain()),
        github: Some(
            eos_app::github()
                .inspect_err(|e| tracing::error!(target: "eos", error = %e, "the core could not be built"))
                .ok()?,
        ),
        slack: Some(
            eos_app::slack()
                .inspect_err(|e| tracing::error!(target: "eos", error = %e, "the core could not be built"))
                .ok()?,
        ),
        mail: Some(eos_app::mail()),
        memory_hook,
        reaches_network: network,
        dashboard: Some(dist.to_path_buf()).filter(|dist| dist.join("index.html").is_file()),
        callers: Some(callers),
        ..eos_app::Options::new(home)
    };
    // Restarting into an update: show the splash, leave the applier what it needs, start
    // it, quit.
    if let Some(exe) = &options.exec_path {
        let handover = Handover::beside(exe, home);
        let launcher = ApplierLauncher::new(handover, ports.quit.clone());
        options.update_applier = Some(Arc::new(WithSplash { launcher, splash: ports.splash.clone() }));
    }
    let began = Instant::now();
    let app = match eos_app::App::build(options) {
        Ok(app) => Arc::new(app),
        Err(e) => {
            tracing::error!(target: "eos", error = %e, "the core could not be built");
            return None;
        }
    };
    let built = began.elapsed();
    if let Err(e) = rt.block_on(app.start()) {
        tracing::error!(target: "eos", error = %e, "the core did not start");
        return None;
    }
    tracing::info!(
        target: "eos",
        ms = began.elapsed().as_millis() as u64,
        build_ms = built.as_millis() as u64,
        start_ms = (began.elapsed() - built).as_millis() as u64,
        network,
        "the core is ready"
    );
    let callers = app.callers().clone();
    let ui_token = callers.ui_token().to_owned();
    let classify: Classify = Arc::new(move |token, target| callers.classify_for(token, target));
    let core = Arc::new(
        RouterCore::new(app.router(), ui_token, classify, rt.clone())
            .with_raw(app.raw_router())
            .with_lane(app.runtime().kernel.ordered.clone())
            .with_wakes({
                let wakes = app.wakes();
                Arc::new(move || wakes.snapshot())
            }),
    );
    Some((app, core))
}

impl Hooks for Eos {
    fn core(&self, ports: &Ports) -> Arc<dyn Core> {
        let Some(home) = self.home.clone() else {
            tracing::warn!(target: "eos", "EOS_HOME is not set (a development build has no default): running without the Rust core");
            self.core.settle();
            return Arc::new(NoCore::default());
        };
        // The token first: the dashboard's document carries it while the core still starts.
        let callers = eos_app::Callers::open(&home);
        let late = Arc::new(LateCore::new(callers.ui_token().to_owned()));
        let _ = self.core.late.set(late.clone());
        let (state, dist, rt, ports) = (self.core.clone(), self.dist.clone(), self.rt.handle().clone(), ports.clone());
        let (shell_data, scheme) = (self.shell_data.clone(), self.scheme);
        let memory_hook = memory_hook();
        let settling = late.clone();
        // On a thread of the core's own pool, at the core's thread class.
        drop(self.rt.spawn_blocking(move || {
            // Settled however this ends, a panic below included: with the core once it is up.
            let mut settle = Settle { late: settling, core: None };
            let up = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                start_core(&home, &dist, &rt, &ports, callers, memory_hook)
            }));
            match up {
                Ok(Some((app, core))) => {
                    let _ = state.app.set((app, rt.clone()));
                    #[cfg(feature = "dev-run")]
                    let core = dev::guarded(core);
                    // The terminal reaches the core as the dashboard does, guard included.
                    let version = env!("CARGO_PKG_VERSION").into();
                    match CliGateway::start(CliParts { core: core.clone(), data_dir: shell_data, scheme, version }, &rt)
                    {
                        Ok(gateway) => {
                            *state.cli.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(gateway)
                        }
                        Err(e) => tracing::warn!(target: "eos", error = %e, "the terminal's gateway did not start"),
                    }
                    settle.core = Some(core);
                }
                Ok(None) => {}
                // A core that panicked while it was built or started ends the app, as when it
                // started before the window: half-started, its tasks would go on beside a
                // dashboard told it has no core.
                Err(_) => {
                    tracing::error!(target: "eos", "the core panicked while it started");
                    eos_kit_log::flush(Duration::from_millis(500));
                    std::process::abort();
                }
            }
            state.settle();
        }));
        late
    }

    fn bridge_ready(&self, bridge: &Arc<Bridge>, ports: &Ports) {
        {
            let mut started = self.core.started();
            if !started.settled {
                started.bridge = Some((bridge.clone(), ports.clone()));
                return;
            }
        }
        self.core.on_bridge_ready(bridge, ports);
    }

    fn dashboard_loaded(&self) {
        {
            let mut started = self.core.started();
            if !started.settled {
                started.dashboard = true;
                return;
            }
        }
        self.core.on_dashboard_loaded();
    }

    fn window_shown(&self) {
        tracing::debug!(target: "eos", "the window was shown");
        if let Some((app, _)) = self.core.app.get() {
            app.update_signals().window_shown();
        }
    }

    fn open_url(&self, url: &str) {
        // A sign-in's link back goes to the core, never to the dashboard. Before the core is
        // up no attempt can wait for it.
        if let Some((app, rt)) = self.core.app.get() {
            let _entered = rt.enter();
            app.open_link(url);
        }
    }

    fn woke(&self, away: Duration) {
        if let Some((app, rt)) = self.core.app.get() {
            // Schedules catch up on what the sleep skipped.
            app.woke(away);
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

    fn quit_check(&self) -> QuitCheck {
        QuitCheck { active_runs: self.core.duty.get().map_or(0, |duty| duty.working()) }
    }

    fn shutdown(&self) {
        // The terminal first: its socket goes, and no command reaches a core that stops.
        drop(self.core.cli.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take());
        // A core still starting is let finish first (for a while), then stopped like any other.
        if let Some(late) = self.core.late.get()
            && !late.wait_settled(SHUTDOWN_START)
        {
            tracing::warn!(target: "eos", "quitting while the core still starts");
        }
        if let Some((app, rt)) = self.core.app.get() {
            let report = rt.block_on(app.shutdown(SHUTDOWN));
            tracing::info!(target: "eos", ms = report.took.as_millis() as u64, clean = report.clean(), "the core stopped");
        }
    }
}

/// Logs go to stderr at once, and to `core.log` once the shell opens the logs' folder as the
/// running app (`eos_kit_log`). `EOS_LOG` picks what is logged in both (`eos::bridge=debug`
/// in a dev run shows what became of each request); Eos's own info by default. A panic in
/// any thread is logged with its place before it unwinds.
fn init_logs() {
    eos_kit_log::init(env("EOS_LOG").as_deref());
    eos_kit_log::catch_panics();
}

fn main() {
    init_logs();
    let core_home = data_folder(env("EOS_HOME").map(PathBuf::from), &home(), RELEASE);
    let options = options(core_home.as_deref());
    let rt = match eos_app::runtime() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("eos: no runtime for the core: {e}");
            std::process::exit(1);
        }
    };
    let hooks = Eos {
        home: core_home,
        dist: options.ui_dist.clone(),
        rt,
        core: Arc::default(),
        shell_data: options.data_dir.clone(),
        scheme: link_scheme(options.doors),
    };
    std::process::exit(eos_shell::run(options, Arc::new(hooks)));
}
