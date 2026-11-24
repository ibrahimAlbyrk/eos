//! The quick panel (07 §4.3): a small borderless window above every app, which takes the
//! keyboard without activating Eos and shows the dashboard's `?surface=quick` document. A door
//! (the shortcut, Services, the Dock, a share, an `eos://send` link) holds its item in the
//! bridge and shows the panel; Escape, the page or losing the keyboard closes it, and the
//! view is released ten minutes after it last closed.

use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use eos_bridge::doors::{self, DoorItem, DoorPart, DoorSource};
use eos_bridge::urlspace::{APP_HOST, RAW_HOST};
use eos_bridge::{Bridge, Service};
use tauri::Manager;
use tauri_runtime_cef::WebviewCefExt;

use crate::host::open_external;
use crate::log::log;
use crate::native::panel as native;
use crate::native::{ax, services};
use crate::scheme;
use crate::views::create;

/// The panel's size before its page fits it: the Home input folded small.
const FIRST_SIZE: (f64, f64) = (600.0, 132.0);
/// How long a closed panel keeps its view, so the next press shows it at once.
const RELEASE_AFTER: Duration = Duration::from_secs(10 * 60);

#[derive(Default)]
struct State {
    window: Option<tauri::Window>,
    shown: bool,
    size: Option<(f64, f64)>,
    /// Counts closings: a release waits for the closing it followed to be the last.
    closings: u64,
}

pub(crate) struct QuickPanel {
    app: tauri::AppHandle,
    rt: tokio::runtime::Handle,
    /// A quiet run shows the panel without giving it the keyboard.
    quiet: bool,
    bridge: OnceLock<Weak<Bridge>>,
    state: Mutex<State>,
}

impl QuickPanel {
    pub(crate) fn new(app: tauri::AppHandle, rt: tokio::runtime::Handle, quiet: bool) -> Arc<Self> {
        Arc::new(QuickPanel { app, rt, quiet, bridge: OnceLock::new(), state: Mutex::default() })
    }

    pub(crate) fn attach(&self, bridge: &Arc<Bridge>) {
        let _ = self.bridge.set(Arc::downgrade(bridge));
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn on_main(self: &Arc<Self>, f: impl FnOnce(&Arc<Self>) + Send + 'static) {
        let me = self.clone();
        let _ = self.app.run_on_main_thread(move || crate::catch::guarded("the quick panel", move || f(&me), || ()));
    }

    /// Shows the panel at the mouse's screen, making it first when it was released.
    pub(crate) fn show(self: &Arc<Self>) {
        self.on_main(|me| {
            let window = match me.window() {
                Ok(window) => window,
                Err(e) => return log("doors", &format!("the quick panel could not open: {e}")),
            };
            let Ok(handle) = window.ns_window() else { return };
            let (width, height) = {
                let mut state = me.lock();
                state.shown = true;
                state.size.unwrap_or(FIRST_SIZE)
            };
            native::show_at_mouse(handle, width, height, !me.quiet);
            if !me.quiet
                && let Some(view) = window.webviews().into_iter().next()
            {
                let _ = view.set_focus();
            }
            log("doors", "the quick panel opened");
        });
    }

    /// The shortcut was pressed: what the front app has selected is held and the panel shows.
    /// The first press without Accessibility asks the system for it once (D38); the panel says
    /// why. Main thread, while the other app still has the focus.
    pub(crate) fn from_shortcut(self: &Arc<Self>, data_dir: &Path) {
        if !ax::trusted() && !doors::accessibility_asked(data_dir) {
            if let Err(e) = doors::mark_accessibility_asked(data_dir) {
                log("doors", &format!("the Accessibility request was not remembered: {e}"));
            }
            ax::prompt();
        }
        let selection = ax::selection();
        let mut parts = Vec::new();
        parts.extend(selection.text.map(DoorPart::Text));
        parts.extend(selection.url.map(DoorPart::Url));
        parts.extend(selection.document.map(DoorPart::of_path));
        if let Some(bridge) = self.bridge.get().and_then(Weak::upgrade) {
            bridge.hold(DoorItem::new(DoorSource::Shortcut, selection.app, parts));
        }
        self.show();
    }

    /// "Send to Eos" from the Services menu: what the other app handed over is held, and the
    /// panel shows.
    pub(crate) fn from_services(self: &Arc<Self>, sent: services::Sent) {
        let mut parts: Vec<DoorPart> = sent.files.into_iter().map(DoorPart::of_path).collect();
        parts.extend(sent.url.map(DoorPart::Url));
        parts.extend(sent.text.map(DoorPart::Text));
        if let Some(bridge) = self.bridge.get().and_then(Weak::upgrade) {
            bridge.hold(DoorItem::new(DoorSource::Services, None, parts));
        }
        self.show();
    }

    /// Files and folders dropped on the Dock icon: held, and the panel shows.
    pub(crate) fn from_dock(self: &Arc<Self>, paths: Vec<std::path::PathBuf>) {
        if let Some(bridge) = self.bridge.get().and_then(Weak::upgrade) {
            bridge.hold(DoorItem::new(DoorSource::Dock, None, paths.into_iter().map(DoorPart::of_path).collect()));
        }
        self.show();
    }

    /// Closes the panel, whatever asked: the page, Escape, or the panel losing the keyboard.
    pub(crate) fn close(self: &Arc<Self>) {
        self.on_main(|me| {
            let closing = {
                let mut state = me.lock();
                if !state.shown {
                    return;
                }
                state.shown = false;
                state.closings += 1;
                if let Some(handle) = state.window.as_ref().and_then(|w| w.ns_window().ok()) {
                    native::hide(handle);
                }
                state.closings
            };
            if let Some(bridge) = me.bridge.get().and_then(Weak::upgrade) {
                bridge.panel_closed();
            }
            log("doors", "the quick panel closed");
            let later = me.clone();
            me.rt.spawn(async move {
                tokio::time::sleep(RELEASE_AFTER).await;
                later.on_main(move |me| me.release_after(closing));
            });
        });
    }

    /// Fits the panel to its page.
    pub(crate) fn resize(self: &Arc<Self>, width: f64, height: f64) {
        self.on_main(move |me| {
            let mut state = me.lock();
            state.size = Some((width, height));
            if let Some(handle) = state.window.as_ref().and_then(|w| w.ns_window().ok()) {
                native::resize(handle, width, height);
            }
        });
    }

    /// For the smoke run: the panel's window as AppKit sees it, `null` when none is made.
    pub(crate) fn report(self: &Arc<Self>) -> serde_json::Value {
        let (tx, rx) = std::sync::mpsc::channel();
        self.on_main(move |me| {
            let handle = me.lock().window.as_ref().and_then(|w| w.ns_window().ok());
            let _ = tx.send(handle.map_or(serde_json::Value::Null, native::report));
        });
        rx.recv_timeout(Duration::from_secs(2)).unwrap_or(serde_json::Value::Null)
    }

    /// The view goes once the panel stayed closed since this closing. Main thread.
    fn release_after(&self, closing: u64) {
        let mut state = self.lock();
        if state.shown || state.closings != closing {
            return;
        }
        if let Some(window) = state.window.take() {
            let _ = window.close();
            log("doors", "the quick panel stayed closed: its view is released");
        }
    }

    /// The panel's window with its view, made on first use. Main thread.
    fn window(&self) -> Result<tauri::Window, String> {
        if let Some(window) = self.lock().window.clone() {
            return Ok(window);
        }
        let bridge = self.bridge.get().and_then(Weak::upgrade).ok_or("no bridge yet")?;
        let size = self.lock().size.unwrap_or(FIRST_SIZE);
        let window = tauri::window::WindowBuilder::new(&self.app, "quick")
            .title("Eos")
            .inner_size(size.0, size.1)
            .decorations(false)
            .transparent(true)
            // The card the page draws has its own shadow; the window's would outline the
            // whole transparent rectangle.
            .shadow(false)
            .resizable(false)
            .visible(false)
            .skip_taskbar(true)
            .focused(false)
            .window_classname(tauri_runtime_cef::PANEL_CLASS)
            .build()
            .map_err(|e| e.to_string())?;
        native::float(window.ns_window().map_err(|e| e.to_string())?);
        // The panel shows the dashboard's own document only; any other place opens in the
        // system browser.
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
        let builder = create::builder("quick", (0.0, 0.0), size, None, policy).auto_resize().transparent(true);
        let view = window.add_child(builder).map_err(|e| e.to_string())?;
        // Off the main thread: registering the handler waits on it.
        drop(std::thread::spawn(move || load(&view, bridge)));
        self.lock().window = Some(window.clone());
        Ok(window)
    }
}

/// Registers the app's origin on the view's request context, then loads the quick document.
fn load(view: &tauri::Webview, bridge: Arc<Bridge>) {
    let service: Arc<dyn Service> = bridge;
    let (tx, rx) = std::sync::mpsc::channel();
    let registering = view.with_cef_webview(move |w| {
        let _ = tx.send(scheme::register(&w.browser(), &[APP_HOST, RAW_HOST], service));
    });
    if !matches!((registering, rx.recv_timeout(Duration::from_secs(10))), (Ok(()), Ok(Ok(())))) {
        return log("doors", "the quick panel's handler could not be registered");
    }
    match tauri::Url::parse(&format!("http://{APP_HOST}/index.html?surface=quick")).map(|url| view.navigate(url)) {
        Ok(Ok(())) => log("doors", "the quick panel is loading"),
        other => log("doors", &format!("the quick panel did not load: {other:?}")),
    }
}
