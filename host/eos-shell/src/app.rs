//! The app's life: one instance, the window, the dashboard view, the menu, quitting.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Once, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use eos_bridge::artifacts::ArtifactViews;
use eos_bridge::artifacts::stills::StillStore;
use eos_bridge::artifacts::urls::Viewer;
use eos_bridge::chromium::{self, Tuning};
use eos_bridge::hosts::{HostParts, HostViews, MachineItem, machine_items};
use eos_bridge::instance::{self, Acquired, Request};
use eos_bridge::lan_guard::{self, SystemProxy};
use eos_bridge::panel::Panel;
use eos_bridge::power::WakeDetector;
use eos_bridge::recovery::{AfterCrash, Recovery};
use eos_bridge::urlspace::{APP_HOST, RAW_HOST};
use eos_bridge::{Bridge, EditCommand, Parts, Service, migrate};
use eos_platform::{SCREEN_SAVER_BUNDLE, ScreenSaver};
use serde_json::{Value, json};
use tauri::{Manager, RunEvent, WindowEvent};
use tauri_runtime_cef::cef::{ContentSettingTypes, ContentSettingValues, ImplBrowser, ImplBrowserHost};
use tauri_runtime_cef::{Cef, ProxyConfig, SecretStorage, WebRtcIpHandling, WebviewCefExt};

use crate::host::{Host, Opener, frame_command, open_external, target_of};
use crate::log::log;
use crate::menu::Command;
use crate::native::{appkit, notify};
use crate::splash::Splash;
use crate::views::{ArtifactShell, Cdp, HostShell, Previewer, ViewPorts, Views, create};
use crate::window::StateKeeper;
use crate::{Hooks, Options, Ports, menu, scheme, window};

/// Chromium's names for why a renderer ended, as the Electron shell reported them.
fn reason_name(reason: &tauri::webview::WebContentProcessTerminationReason) -> &'static str {
    use tauri::webview::WebContentProcessTerminationReason as Reason;
    match reason {
        Reason::Killed => "killed",
        Reason::OutOfMemory => "oom",
        Reason::LaunchFailed => "launch-failed",
        Reason::IntegrityFailure => "integrity-failure",
        Reason::Abnormal => "abnormal-exit",
        Reason::Normal => "clean-exit",
        _ => "crashed",
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Chromium as the app runs it. `None` when the launch list is malformed: a switch that
/// would silently not apply is a bug to fix, not something to run with.
fn engine(options: &Options, system: &SystemProxy) -> Option<Cef> {
    let launch = chromium::launch(&Tuning {
        mute_audio: options.quiet,
        network_in_process: options.network_in_process,
        paint_when_covered: options.paint_when_covered,
        // Diagnostics: every request Chromium makes, with its URL, into a file.
        net_log: std::env::var_os("EOS_SHELL_NETLOG").map(Into::into),
    });
    let problems = launch.problems();
    if !problems.is_empty() {
        eprintln!("eos: the Chromium launch list is malformed: {}", problems.join("; "));
        return None;
    }
    let mut cef = Cef::default()
        .root_cache_path(options.data_dir.join("profile"))
        // WebRTC may only use a configured proxy (the switch in the launch list is the
        // same rule for the profiles this preference does not reach).
        .webrtc_ip_handling(WebRtcIpHandling::DisableNonProxiedUdp)
        .command_line_args(launch.switches)
        .disable_features(launch.disable_features)
        .enable_features(launch.enable_features)
        // Requests: every profile starts with the guarded proxy script, which decides per
        // request, before DNS and before connect, and carries the system's proxy settings.
        .proxy(ProxyConfig::PacScript { url: lan_guard::script_url(false, system) })
        // Chromium's own check comes after the connection, too late for the system's
        // dialog; it stays as the second line, answering "no" without a prompt.
        .default_content_setting(ContentSettingTypes::LOCAL_NETWORK_ACCESS, ContentSettingValues::BLOCK)
        .default_content_setting(ContentSettingTypes::LOCAL_NETWORK, ContentSettingValues::BLOCK)
        // Banners are the shell's own; no page shows one.
        .default_content_setting(ContentSettingTypes::NOTIFICATIONS, ContentSettingValues::BLOCK);
    if options.mock_keychain {
        cef = cef.secret_storage(SecretStorage::Mock);
    }
    Some(cef)
}

/// The claude.ai sign-in windows, for a test run whose artifact views show a stand-in
/// (`Ports::sign_in`): the run clicks the stand-in's buttons in them as the user would.
#[derive(Clone)]
pub struct SignInWindows(std::sync::Weak<Shell>);

impl std::fmt::Debug for SignInWindows {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SignInWindows").finish_non_exhaustive()
    }
}

impl SignInWindows {
    fn artifacts(&self) -> Result<Arc<ArtifactShell>, String> {
        let shell = self.0.upgrade().ok_or("the shell is closing")?;
        shell.artifacts.get().cloned().ok_or_else(|| "no artifact views".to_owned())
    }

    /// A DevTools call on the open sign-in window of `profile`.
    pub async fn cdp(&self, profile: &str, method: &str, params: Value) -> Result<Value, String> {
        self.artifacts()?.sign_in_cdp(profile, method, params).await
    }

    /// Closes the open sign-in window of `profile`, as its close button does.
    pub fn close(&self, profile: &str) -> Result<(), String> {
        if self.artifacts()?.close_sign_in(profile) {
            Ok(())
        } else {
            Err(format!("no sign-in window for {profile:?}"))
        }
    }
}

struct Shell {
    options: Options,
    /// The system's proxy settings as they were at launch.
    system_proxy: SystemProxy,
    hooks: Arc<dyn Hooks>,
    rt: tokio::runtime::Runtime,
    app: OnceLock<tauri::AppHandle>,
    window: OnceLock<tauri::Window>,
    views: OnceLock<Arc<Views>>,
    artifacts: OnceLock<Arc<ArtifactShell>>,
    hosts: OnceLock<Arc<HostShell>>,
    bridge: OnceLock<Arc<Bridge>>,
    keeper: OnceLock<StateKeeper>,
    quitting: AtomicBool,
    splash: Splash,
    /// Which views were reloaded after their renderer died, lately.
    recovery: std::sync::Mutex<Recovery>,
    shut_down: Once,
    /// A link that arrived before the bridge existed (the link that launched the app).
    early_link: std::sync::Mutex<Option<String>>,
}

pub(crate) fn run(options: Options, hooks: Arc<dyn Hooks>) -> i32 {
    // A CEF helper process started from this executable (not the case on macOS, where the
    // helper apps have their own).
    if std::env::args().any(|arg| arg.starts_with("--type=")) {
        tauri_runtime_cef::run_cef_helper_process();
        return 0;
    }
    let request = Request::from_args(&options.args);
    let socket = options.data_dir.join("shell.sock");
    let hand_over = |stream| match instance::ask(stream, &request) {
        Ok(answer) => {
            println!("{answer}");
            0
        }
        Err(e) => {
            eprintln!("eos: the running app did not answer: {e}");
            1
        }
    };
    if request.is_control() {
        // `--quit` or `--status`: talk to the running app, never become it.
        return match instance::connect(&socket) {
            Some(stream) => hand_over(stream),
            None => {
                println!("{}", json!({ "running": false }));
                i32::from(request == Request::Status)
            }
        };
    }
    let instance = match instance::acquire(&socket) {
        Ok(Acquired::Running(stream)) => return hand_over(stream),
        Ok(Acquired::First(instance)) => instance,
        Err(e) => {
            eprintln!("eos: cannot use {}: {e}", socket.display());
            return 1;
        }
    };
    crate::log::init(&options.data_dir);
    let rt = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("eos-shell")
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("eos: no runtime: {e}");
            return 1;
        }
    };
    let system_proxy = SystemProxy::read();
    if system_proxy.automatic {
        log(
            "lan",
            "the system uses a proxy script or auto-discovery, which the app cannot follow: it connects directly",
        );
    }
    crate::views::remove_throwaway_profiles(&options.data_dir.join("profile"));
    let Some(cef) = engine(&options, &system_proxy) else { return 1 };
    let shell = Arc::new(Shell {
        options,
        system_proxy,
        hooks,
        rt,
        app: OnceLock::new(),
        window: OnceLock::new(),
        views: OnceLock::new(),
        artifacts: OnceLock::new(),
        hosts: OnceLock::new(),
        bridge: OnceLock::new(),
        keeper: OnceLock::new(),
        quitting: AtomicBool::new(false),
        recovery: std::sync::Mutex::default(),
        splash: Splash::default(),
        shut_down: Once::new(),
        early_link: std::sync::Mutex::new(None),
    });

    let for_setup = shell.clone();
    let for_menu = shell.clone();
    let for_crash = shell.clone();
    let built = tauri::Builder::default()
        .runtime(cef)
        .on_menu_event(move |_app, event| {
            if let Some(command) = Command::from_id(event.id().as_ref()) {
                for_menu.menu(command);
            }
        })
        .setup(move |app| {
            for_setup.setup(app.handle())?;
            Ok(())
        })
        .on_web_content_process_terminate(move |webview, termination| {
            for_crash.renderer_gone(webview, reason_name(&termination.reason));
        })
        .build(tauri::generate_context!());
    let app = match built {
        Ok(app) => app,
        Err(e) => {
            log("shell", &format!("startup failed: {e}"));
            return 1;
        }
    };

    let for_instance = shell.clone();
    instance.serve(move |request| for_instance.asked(request).to_string());
    shell.clone().watch_for_wake();
    if let Request::Open(url) = request {
        shell.open_url(&url);
    }

    let for_events = shell.clone();
    app.run(move |_handle, event| for_events.event(event));
    0
}

impl Shell {
    fn setup(self: &Arc<Self>, app: &tauri::AppHandle) -> tauri::Result<()> {
        let options = &self.options;
        if options.quiet {
            // An accessory app never activates: a test run must not take the user's focus.
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
        }
        let theme = Bridge::persisted_theme(&options.data_dir);
        let (window, state) = window::create(app, &options.data_dir, theme, options.quiet)?;
        let _ = app.set_menu(menu::build(app, &options.name, &options.version, &[], self.screen_saver().is_some())?);
        let _ = self.app.set(app.clone());
        let _ = self.window.set(window.clone());
        let _ = self.keeper.set(StateKeeper::new(&options.data_dir, state.fullscreen));

        let views = Views::new(
            app.clone(),
            window.clone(),
            self.rt.handle().clone(),
            self.system_proxy.clone(),
            options.data_dir.join("profile"),
        );
        let _ = self.views.set(views.clone());
        let view_ports: Arc<dyn eos_core::shell::BrowserViews> = Arc::new(ViewPorts(views.clone()));
        // The panel exists before the core: the browser feature holds it too.
        let panel = Panel::new(view_ports.clone(), self.rt.handle());
        let ports = Ports {
            views: view_ports,
            panel: Arc::new(panel.clone()),
            capture: Arc::new(ViewPorts(views.clone())),
            picker: Arc::new(ViewPorts(views.clone())),
            previewer: Arc::new(Previewer::new(views.clone())),
            opener: Arc::new(Opener),
            rt: self.rt.handle().clone(),
            quit: {
                let shell = Arc::downgrade(self);
                Arc::new(move || {
                    if let Some(shell) = shell.upgrade() {
                        shell.quit();
                    }
                })
            },
            splash: {
                let shell = Arc::downgrade(self);
                Arc::new(move |caption| {
                    let Some(shell) = shell.upgrade() else { return };
                    match caption {
                        Some(caption) => {
                            let (Some(app), dist) = (shell.app.get(), &shell.options.ui_dist) else { return };
                            if let Err(e) = shell.splash.show(app, dist, &caption) {
                                log("shell", &format!("the update splash could not open: {e}"));
                            }
                        }
                        None => shell.splash.close(),
                    }
                })
            },
            probe: options.probe.then(|| crate::probe::Probe::start(app.clone(), views.clone())),
            sign_in: options.artifact_origin.is_some().then(|| SignInWindows(Arc::downgrade(self))),
        };

        // The dashboard may only be the dashboard: any other place opens in the system
        // browser, and a page-opened window never opens here.
        let policy = create::Policy {
            popups: None,
            navigation: Box::new(|url| {
                let own = url.scheme() == "http" && url.host_str() == Some(APP_HOST);
                if !own && url.scheme() != "about" {
                    open_external(url);
                }
                own || url.as_str() == "about:blank"
            }),
            open_requested: Box::new(open_external),
        };
        let dashboard = window
            .add_child(create::builder("main", (0.0, 0.0), (state.width, state.height), None, policy).auto_resize())?;

        let core = self.hooks.core(&ports);
        let seed = migrate::plan(&options.data_dir, options.electron_profile.as_deref(), now_ms());
        if let Some(seed) = &seed {
            log(
                "migrate",
                &format!(
                    "carrying over {} localStorage keys from the Electron profile ({} unreadable)",
                    seed.keys.len(),
                    seed.undecodable
                ),
            );
        }
        let host = Arc::new(Host {
            window: window.clone(),
            views: views.clone(),
            rt: self.rt.handle().clone(),
            bridge: OnceLock::new(),
            quiet: options.quiet,
        });
        let bridge = Bridge::new(Parts {
            assets: options.ui_dist.clone(),
            data_dir: options.data_dir.clone(),
            core: core.clone(),
            host: host.clone(),
            panel,
            capture: ports.capture.clone(),
            rt: self.rt.handle().clone(),
            seed,
            now_ms,
        });
        let _ = host.bridge.set(Arc::downgrade(&bridge));
        let _ = self.bridge.set(bridge.clone());
        let artifacts = self.start_artifacts(&views, &bridge);
        self.start_hosts(&views, &bridge, core, host.clone(), artifacts);
        let early_link = self.early_link.lock().ok().and_then(|mut link| link.take());
        if let Some(url) = early_link {
            self.open_url(&url);
        }

        // A click on a banner: bring the app forward and open what the banner was about.
        let for_click = self.clone();
        notify::on_click(move |identifier| {
            for_click.show_window();
            if let Some(bridge) = for_click.bridge.get() {
                let (target, host) = target_of(&identifier);
                bridge.banner_clicked(target.as_ref(), host.as_deref());
            }
        });

        // Off the main thread: the handler must be on the view's request context before the
        // first request for the app's origin leaves, and registering waits on the main thread.
        let me = self.clone();
        std::thread::spawn(move || me.load_dashboard(dashboard, bridge, ports));
        Ok(())
    }

    /// The claude.ai artifact views: their pool runs on the shell's runtime and tells the
    /// dashboard through its event stream.
    fn start_artifacts(&self, views: &Arc<Views>, bridge: &Arc<Bridge>) -> ArtifactViews {
        let viewer = self.options.artifact_origin.as_deref().map_or_else(Viewer::default, Viewer::at);
        let provider = self.options.sign_in_provider.as_deref().and_then(|p| tauri::Url::parse(p).ok());
        let surface = ArtifactShell::new(views.clone(), viewer.clone(), provider, self.options.quiet);
        let to_page = Arc::downgrade(bridge);
        let pool = ArtifactViews::start(
            surface.clone(),
            viewer,
            StillStore::new(self.options.data_dir.join("artifact-stills")),
            Arc::new(move |name, payload| {
                if let Some(bridge) = to_page.upgrade() {
                    bridge.events().emit(name, payload);
                }
            }),
            self.rt.handle(),
        );
        surface.report_to(pool.clone());
        bridge.set_artifacts(pool.clone());
        let _ = self.artifacts.set(surface);
        pool
    }

    /// The machine switcher and a view per paired computer. While one covers the dashboard
    /// the artifact views stay hidden.
    fn start_hosts(
        self: &Arc<Self>,
        views: &Arc<Views>,
        bridge: &Arc<Bridge>,
        core: Arc<dyn eos_bridge::Core>,
        window: Arc<Host>,
        artifacts: ArtifactViews,
    ) {
        let surface = HostShell::new(views.clone(), self.options.quiet);
        let to_page = Arc::downgrade(bridge);
        let rt = self.rt.handle().clone();
        let hosts = HostViews::new(HostParts {
            core,
            surface: surface.clone(),
            dist: self.options.ui_dist.clone(),
            shell: window,
            to_dashboard: Arc::new(move |name, payload| {
                if let Some(bridge) = to_page.upgrade() {
                    bridge.events().emit(name, payload);
                }
            }),
            changed: {
                let shell = Arc::downgrade(self);
                let shown: std::sync::Mutex<Vec<MachineItem>> = std::sync::Mutex::default();
                Arc::new(move |snapshot| {
                    let (artifacts, covered) = (artifacts.clone(), !snapshot["active"].is_null());
                    rt.spawn(async move { artifacts.set_covered(covered).await });
                    // Link-state ticks change nothing the menu shows: it is rebuilt only when
                    // the computers or the active one change.
                    let items = machine_items(snapshot);
                    let mut was = shown.lock().unwrap_or_else(|p| p.into_inner());
                    if *was != items
                        && let Some(shell) = shell.upgrade()
                    {
                        shell.rebuild_menu(items.clone());
                        *was = items;
                    }
                })
            },
            rt: self.rt.handle().clone(),
        });
        bridge.set_hosts(hosts.clone());
        let _ = self.hosts.set(surface);
        self.rt.spawn(async move { hosts.refresh().await });
    }

    fn load_dashboard(&self, dashboard: tauri::Webview, bridge: Arc<Bridge>, ports: Ports) {
        let service: Arc<dyn Service> = bridge.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let registering = dashboard.with_cef_webview(move |w| {
            let _ = tx.send(scheme::register(&w.browser(), &[APP_HOST, RAW_HOST], service));
        });
        match (registering, rx.recv_timeout(Duration::from_secs(10))) {
            (Ok(()), Ok(Ok(()))) => log("shell", "in-process handler registered for the app's origin"),
            (_, other) => {
                log("shell", &format!("the in-process handler could not be registered: {other:?}"));
                return;
            }
        }
        match Cdp::attach(&dashboard, crate::probe::dashboard_event) {
            Ok(cdp) => {
                if let Some(views) = self.views.get() {
                    views.set_dashboard(dashboard.clone(), cdp);
                }
            }
            Err(e) => log("shell", &format!("no DevTools channel to the dashboard: {e}")),
        }
        match tauri::Url::parse(&format!("http://{APP_HOST}/index.html")).map(|url| dashboard.navigate(url)) {
            Ok(Ok(())) => log("shell", "dashboard loading"),
            other => log("shell", &format!("the dashboard did not load: {other:?}")),
        }
        self.hooks.started(&bridge, &ports);
    }

    // ---- the window ------------------------------------------------------------

    fn on_main(&self, f: impl FnOnce() + Send + 'static) {
        if let Some(app) = self.app.get() {
            let _ = app.run_on_main_thread(f);
        }
    }

    fn show_window(&self) {
        let Some(window) = self.window.get().cloned() else { return };
        // A quiet run never takes the user's focus, whatever asks for the window.
        let quiet = self.options.quiet;
        self.on_main(move || {
            let _ = window.show();
            let _ = window.unminimize();
            if !quiet {
                let _ = window.set_focus();
                appkit::activate_app();
            }
        });
        self.hooks.window_shown();
    }

    fn quit(&self) {
        self.quitting.store(true, Ordering::SeqCst);
        if let Some(app) = self.app.get() {
            app.exit(0);
        }
    }

    /// Runs once, when the app is really quitting.
    fn shut_down(&self) {
        self.shut_down.call_once(|| {
            log("shell", "quitting");
            if let (Some(window), Some(keeper)) = (self.window.get(), self.keeper.get()) {
                keeper.changed(window, true);
            }
            if self.options.quiet {
                // An automated run leaves nothing behind in Notification Center.
                notify::clear_delivered();
            }
            self.hooks.shutdown();
            let _ = std::fs::remove_file(self.options.data_dir.join("shell.sock"));
        });
    }

    fn open_url(&self, url: &str) {
        // The bridge is built during startup: a link that launched the app waits for it.
        if self.bridge.get().is_none() {
            if let Ok(mut early) = self.early_link.lock() {
                *early = Some(url.to_string());
            }
            return;
        }
        // Never the link itself in the log: an invite is a secret.
        log("shell", "a link was opened with the app");
        self.show_window();
        if url.starts_with("eos://pair/")
            && let Some(bridge) = self.bridge.get()
        {
            bridge.hosts_command("connect", Some(url));
        }
        self.hooks.open_url(url);
    }

    // ---- events ----------------------------------------------------------------

    fn event(&self, event: RunEvent) {
        match event {
            RunEvent::WindowEvent { label, event, .. } if label == "main" => match event {
                // Closing the window leaves the app running in the Dock.
                WindowEvent::CloseRequested { api, .. } if !self.quitting.load(Ordering::SeqCst) => {
                    api.prevent_close();
                    if let Some(window) = self.window.get() {
                        let _ = window.hide();
                    }
                }
                WindowEvent::Resized(_) | WindowEvent::Moved(_) => {
                    if let (Some(window), Some(keeper)) = (self.window.get(), self.keeper.get())
                        && let Some(fullscreen) = keeper.changed(window, false)
                        && let Some(bridge) = self.bridge.get()
                    {
                        bridge.fullscreen_changed(fullscreen);
                    }
                }
                _ => {}
            },
            // A window of its own showing a paired computer closed: its door goes.
            RunEvent::WindowEvent { label, event: WindowEvent::Destroyed, .. } => {
                if let Some(hosts) = self.bridge.get().and_then(|b| b.hosts()) {
                    hosts.window_closed(&label);
                }
            }
            // A click on the Dock icon.
            RunEvent::Reopen { .. } => self.show_window(),
            RunEvent::Opened { urls } => {
                for url in urls {
                    self.open_url(url.as_str());
                }
            }
            RunEvent::ExitRequested { .. } => self.quitting.store(true, Ordering::SeqCst),
            RunEvent::Exit => self.shut_down(),
            _ => {}
        }
    }

    /// The app menu again, with these computers in the Machines menu.
    fn rebuild_menu(&self, machines: Vec<MachineItem>) {
        let Some(app) = self.app.get().cloned() else { return };
        let (name, version) = (self.options.name.clone(), self.options.version.clone());
        let screen_saver = self.screen_saver().is_some();
        self.on_main(move || match menu::build(&app, &name, &version, &machines, screen_saver) {
            Ok(built) => drop(app.set_menu(built)),
            Err(e) => log("shell", &format!("the menu was not rebuilt: {e}")),
        });
    }

    /// A view's renderer died: the page is reloaded once, or told, as `eos_bridge::recovery`
    /// decides.
    fn renderer_gone(&self, webview: &tauri::Webview, reason: &str) {
        if self.quitting.load(Ordering::SeqCst) || reason == "clean-exit" {
            return;
        }
        let label = webview.label().to_owned();
        let decision = self.recovery.lock().unwrap_or_else(|p| p.into_inner()).after_crash(&label, Instant::now());
        match decision {
            AfterCrash::Reload => {
                log("shell", &format!("a renderer stopped ({reason}): {label} is reloaded"));
                let _ = webview.reload();
            }
            AfterCrash::LeaveDead => {
                log("shell", &format!("a renderer stopped again ({reason}): {label} is left as it is"));
            }
            AfterCrash::TellArtifacts => {
                if let Some(artifacts) = self.artifacts.get() {
                    artifacts.crashed(&label, reason);
                }
            }
            AfterCrash::Nothing => {}
        }
    }

    /// A menu command. Runs on the main thread.
    fn menu(&self, command: Command) {
        let (Some(views), Some(bridge)) = (self.views.get(), self.bridge.get()) else { return };
        match command {
            Command::Quit => self.quit(),
            Command::Reload => {
                if let Some(dashboard) = views.dashboard() {
                    let _ = dashboard.webview.reload();
                }
            }
            Command::DevTools => {
                if let Some(dashboard) = views.dashboard() {
                    if dashboard.webview.is_devtools_open() {
                        dashboard.webview.close_devtools();
                    } else {
                        dashboard.webview.open_devtools();
                    }
                }
            }
            Command::ConnectMachine => {
                self.show_window();
                if let Some(hosts) = bridge.hosts().cloned() {
                    self.rt.spawn(async move { hosts.switch_to(None).await });
                }
                bridge.hosts_command("connect", None);
            }
            Command::Machine(id) => {
                if let Some(hosts) = bridge.hosts().cloned() {
                    self.rt.spawn(async move { hosts.switch_to(id).await });
                }
            }
            Command::LockScreen => self.screen_saver_action(false),
            Command::InstallScreenSaver => self.screen_saver_action(true),
            Command::Edit(command) => self.edit(views, bridge, command),
        }
    }

    /// The system's screen saver and the folder holding the one the app ships, when both
    /// exist: the menu offers it only then.
    fn screen_saver(&self) -> Option<(&'static dyn ScreenSaver, PathBuf)> {
        let saver = eos_platform::host().screen_saver()?;
        let resources = self.options.resources.clone()?;
        resources.join(SCREEN_SAVER_BUNDLE).is_dir().then_some((saver, resources))
    }

    /// Installs the screen saver (a failure is shown in an alert) or starts it now. Off the
    /// main thread: both run system tools.
    fn screen_saver_action(&self, install: bool) {
        let (Some((saver, resources)), Some(app)) = (self.screen_saver(), self.app.get().cloned()) else { return };
        self.rt.spawn_blocking(move || {
            if !install {
                if let Err(e) = saver.start() {
                    log("shell", &format!("the screen saver did not start: {e}"));
                }
                return;
            }
            if let Err(e) = saver.install(&resources) {
                log("shell", &format!("the screen saver was not installed: {e}"));
                let detail = e.to_string();
                let _ = app.run_on_main_thread(move || {
                    appkit::error_alert("Couldn’t install the Eos screen saver", &detail);
                });
            }
        });
    }

    /// The Edit menu acts on whatever has the keyboard: the dashboard decides for itself
    /// (composer stack, terminal), an embedded view gets the native command, and anything
    /// else (a text field of a system panel) the standard action.
    fn edit(&self, views: &Views, bridge: &Bridge, command: EditCommand) {
        if views.dashboard().is_some_and(|d| appkit::view_has_focus(d.ns_view())) {
            return bridge.edit(command);
        }
        let embedded = views
            .all()
            .into_iter()
            .chain(self.artifacts.get().map(|a| a.natives()).unwrap_or_default())
            .chain(self.hosts.get().map(|h| h.natives()).unwrap_or_default());
        if let Some(view) = embedded.into_iter().find(|v| appkit::view_has_focus(v.ns_view())) {
            let _ = view.webview.with_cef_webview(move |w| frame_command(&w.browser(), command));
            return;
        }
        appkit::send_edit_action(command);
    }

    /// A later launch asked for something. Not on the main thread.
    fn asked(&self, request: Request) -> Value {
        match request {
            Request::Activate => {
                self.show_window();
                json!({ "ok": true })
            }
            Request::Open(url) => {
                self.open_url(&url);
                json!({ "ok": true })
            }
            Request::Quit => {
                self.quit();
                json!({ "ok": true })
            }
            Request::Status => self.status(),
        }
    }

    /// For `--status`, diagnostics and the smoke run: no user data.
    fn status(&self) -> Value {
        let window = self.window.get();
        let flag = |f: fn(&tauri::Window) -> tauri::Result<bool>| window.and_then(|w| f(w).ok());
        json!({
            "running": true,
            "pid": std::process::id(),
            "version": self.options.version,
            "bundle": appkit::bundle_identifier(),
            "window": {
                "visible": flag(tauri::Window::is_visible),
                "focused": flag(tauri::Window::is_focused),
                "fullscreen": flag(tauri::Window::is_fullscreen),
            },
            "menus": self.app.get().and_then(|app| app.menu()).and_then(|menu| menu.items().ok()).map(|items| {
                items.iter().filter_map(|item| item.as_submenu().and_then(|submenu| submenu.text().ok())).collect::<Vec<_>>()
            }),
            // The app menu's own items, by title (separators left out).
            "appMenu": self.app.get().and_then(|app| app.menu()).and_then(|menu| menu.items().ok()).and_then(|items| {
                let submenu = items.first()?.as_submenu()?.items().ok()?;
                Some(submenu.iter().filter_map(|item| item.as_menuitem().and_then(|m| m.text().ok())).collect::<Vec<_>>())
            }),
            "views": self.views.get().map(|v| v.status()),
            "transport": { "opened": scheme::OPENED.load(Ordering::Relaxed), "cancelled": scheme::CANCELLED.load(Ordering::Relaxed) },
            "bridge": self.bridge.get().map(|b| b.status()),
            "splash": self.splash.shown(),
        })
    }

    /// Tells the app when the Mac comes back from sleep, and follows the system's proxy
    /// settings (they change with the network the Mac is on).
    fn watch_for_wake(self: Arc<Self>) {
        const TICK: Duration = Duration::from_secs(5);
        const PROXY_EVERY: u32 = 6;
        std::thread::spawn(move || {
            let mut detector = WakeDetector::new(TICK);
            let mut tick = 0u32;
            loop {
                std::thread::sleep(TICK);
                tick = tick.wrapping_add(1);
                let woke = detector.tick(now_ms());
                if let Some(away) = woke {
                    log("shell", &format!("awake after about {} s", away.as_secs()));
                    self.hooks.woke(away);
                }
                if (woke.is_some() || tick.is_multiple_of(PROXY_EVERY))
                    && let Some(views) = self.views.get()
                {
                    views.system_proxy_changed(SystemProxy::read());
                }
            }
        });
    }
}

/// Reads the native view of a browser once it exists, for the menu's focus routing.
pub(crate) fn remember_native_view(webview: &tauri::Webview, slot: Arc<std::sync::atomic::AtomicUsize>) {
    let _ = webview.with_cef_webview(move |w| {
        if let Some(host) = w.browser().host() {
            slot.store(host.window_handle() as usize, Ordering::SeqCst);
        }
    });
}
