//! The app's life: one instance, the window, the dashboard view, the menu, quitting.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Once, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use eos_bridge::chromium::{self, Tuning};
use eos_bridge::instance::{self, Acquired, Request};
use eos_bridge::lan_guard::{self, SystemProxy};
use eos_bridge::panel::Panel;
use eos_bridge::power::WakeDetector;
use eos_bridge::urlspace::{APP_HOST, RAW_HOST};
use eos_bridge::{Bridge, EditCommand, Parts, Service, migrate};
use serde_json::{Value, json};
use tauri::{Manager, RunEvent, WindowEvent};
use tauri_runtime_cef::cef::{ContentSettingTypes, ContentSettingValues, ImplBrowser, ImplBrowserHost};
use tauri_runtime_cef::{Cef, ProxyConfig, SecretStorage, WebRtcIpHandling, WebviewCefExt};

use crate::host::{Host, Opener, frame_command, open_external, target_of};
use crate::log::log;
use crate::menu::Command;
use crate::native::{appkit, notify};
use crate::views::{Cdp, Previewer, ViewPorts, Views, create};
use crate::window::StateKeeper;
use crate::{Hooks, Options, Ports, menu, scheme, window};

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

struct Shell {
    options: Options,
    /// The system's proxy settings as they were at launch.
    system_proxy: SystemProxy,
    hooks: Arc<dyn Hooks>,
    rt: tokio::runtime::Runtime,
    app: OnceLock<tauri::AppHandle>,
    window: OnceLock<tauri::Window>,
    views: OnceLock<Arc<Views>>,
    bridge: OnceLock<Arc<Bridge>>,
    keeper: OnceLock<StateKeeper>,
    quitting: AtomicBool,
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
        bridge: OnceLock::new(),
        keeper: OnceLock::new(),
        quitting: AtomicBool::new(false),
        shut_down: Once::new(),
        early_link: std::sync::Mutex::new(None),
    });

    let for_setup = shell.clone();
    let for_menu = shell.clone();
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
        let _ = app.set_menu(menu::build(app, &options.name, &options.version)?);
        let _ = self.app.set(app.clone());
        let _ = self.window.set(window.clone());
        let _ = self.keeper.set(StateKeeper::new(&options.data_dir, state.fullscreen));

        let views = Views::new(app.clone(), window.clone(), self.rt.handle().clone(), self.system_proxy.clone());
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
        };

        // The dashboard may only be the dashboard: any other place opens in the system
        // browser, and a page-opened window never opens here.
        let policy = create::Policy {
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
            core,
            host: host.clone(),
            panel,
            capture: ports.capture.clone(),
            rt: self.rt.handle().clone(),
            seed,
            now_ms,
        });
        let _ = host.bridge.set(Arc::downgrade(&bridge));
        let _ = self.bridge.set(bridge.clone());
        let early_link = self.early_link.lock().ok().and_then(|mut link| link.take());
        if let Some(url) = early_link {
            self.open_url(&url);
        }

        // A click on a banner: bring the app forward and open what the banner was about.
        let for_click = self.clone();
        notify::on_click(move |identifier| {
            for_click.show_window();
            if let (Some(target), Some(bridge)) = (target_of(&identifier), for_click.bridge.get()) {
                bridge.banner_clicked(&target);
            }
        });

        // Off the main thread: the handler must be on the view's request context before the
        // first request for the app's origin leaves, and registering waits on the main thread.
        let me = self.clone();
        std::thread::spawn(move || me.load_dashboard(dashboard, bridge, ports));
        Ok(())
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
        match Cdp::attach(&dashboard, |_method, _params| {}) {
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
                bridge.hosts_command("connect", None);
            }
            Command::Edit(command) => self.edit(views, bridge, command),
        }
    }

    /// The Edit menu acts on whatever has the keyboard: the dashboard decides for itself
    /// (composer stack, terminal), an embedded view gets the native command, and anything
    /// else (a text field of a system panel) the standard action.
    fn edit(&self, views: &Views, bridge: &Bridge, command: EditCommand) {
        if views.dashboard().is_some_and(|d| appkit::view_has_focus(d.ns_view())) {
            return bridge.edit(command);
        }
        if let Some(view) = views.all().into_iter().find(|v| appkit::view_has_focus(v.ns_view())) {
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
            "views": self.views.get().map(|v| v.status()),
            "transport": { "opened": scheme::OPENED.load(Ordering::Relaxed), "cancelled": scheme::CANCELLED.load(Ordering::Relaxed) },
            "bridge": self.bridge.get().map(|b| b.status()),
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
