//! The shell's views: the dashboard and the child Chromium views the core asks for.
//! Implements the core's view ports (`BrowserViews`, `Capture`, `FilePicker`).

mod cdp;
pub(crate) mod create;
mod preview;
mod proxy;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use base64::Engine;
use eos_bridge::lan_guard::{self, LocalPage, SystemProxy};
use eos_core::BoxFuture;
use eos_core::shell::{
    BrowserViews, Capture, CaptureTarget, FilePicker, Image, ImageFormat, Rect, ViewError, ViewEvent, ViewId,
    ViewListener, ViewSpec,
};
use serde_json::{Value, json};
use tauri::{LogicalPosition, LogicalSize, Manager};
use tauri_runtime_cef::WebviewCefExt;
use tauri_runtime_cef::cef::{ImplBrowser, ImplBrowserHost};

pub(crate) use self::cdp::Cdp;
pub(crate) use self::preview::Previewer;
use crate::native::appkit;

/// The size a parked view keeps, so its page has a real layout viewport: a view no human is
/// watching must still scroll, click and capture.
const PARKED_SIZE: (f64, f64) = (1280.0, 800.0);

pub(crate) struct View {
    pub(crate) webview: tauri::Webview,
    pub(crate) cdp: Cdp,
    placed: AtomicBool,
    /// The browser's `NSView`, known shortly after creation; 0 until then.
    native: Arc<AtomicUsize>,
    /// The folder name of the view's profile; empty for the dashboard's.
    profile: String,
    /// Whether the user sent this view to the local network.
    local: Mutex<LocalPage>,
}

impl View {
    fn new(webview: tauri::Webview, cdp: Cdp, placed: bool, profile: String) -> Arc<Self> {
        let native = Arc::new(AtomicUsize::new(0));
        crate::app::remember_native_view(&webview, native.clone());
        Arc::new(View { webview, cdp, placed: AtomicBool::new(placed), native, profile, local: Mutex::default() })
    }

    fn local(&self) -> MutexGuard<'_, LocalPage> {
        self.local.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub(crate) fn ns_view(&self) -> *mut std::ffi::c_void {
        self.native.load(Ordering::SeqCst) as *mut std::ffi::c_void
    }
}

type Listeners = Arc<Mutex<Vec<Arc<dyn ViewListener>>>>;

pub(crate) struct Views {
    me: std::sync::Weak<Views>,
    window: tauri::Window,
    app: tauri::AppHandle,
    rt: tokio::runtime::Handle,
    /// The system's proxy settings, carried inside every profile's proxy script.
    system: Mutex<SystemProxy>,
    /// The profiles whose script currently lets the local network through.
    open_profiles: Mutex<std::collections::HashSet<String>>,
    dashboard: OnceLock<Arc<View>>,
    views: Mutex<HashMap<String, Arc<View>>>,
    listeners: Listeners,
    counter: AtomicU64,
}

fn shell_error(e: impl std::fmt::Display) -> ViewError {
    ViewError::Shell(e.to_string())
}

/// Removes the storage of profiles that were not to be kept (`THROWAWAY_PROFILE`), left by
/// an earlier run. Called before Chromium starts, so nothing is using them.
pub(crate) fn remove_throwaway_profiles(root_cache: &std::path::Path) {
    let prefix = format!("view-{}", eos_core::shell::THROWAWAY_PROFILE);
    for entry in std::fs::read_dir(root_cache).into_iter().flatten().flatten() {
        if entry.file_name().to_string_lossy().starts_with(&prefix) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

fn profile_dir(name: &str) -> String {
    name.chars().map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '_' }).collect()
}

impl Views {
    pub(crate) fn new(
        app: tauri::AppHandle,
        window: tauri::Window,
        rt: tokio::runtime::Handle,
        system: SystemProxy,
    ) -> Arc<Self> {
        Arc::new_cyclic(|me| Views {
            me: me.clone(),
            window,
            app,
            rt,
            system: Mutex::new(system),
            open_profiles: Mutex::default(),
            dashboard: OnceLock::new(),
            views: Mutex::default(),
            listeners: Arc::default(),
            counter: AtomicU64::new(0),
        })
    }

    fn views(&self) -> MutexGuard<'_, HashMap<String, Arc<View>>> {
        self.views.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn view(&self, id: &ViewId) -> Result<Arc<View>, ViewError> {
        self.views().get(id.as_str()).cloned().ok_or_else(|| ViewError::UnknownView(id.clone()))
    }

    pub(crate) fn set_dashboard(&self, webview: tauri::Webview, cdp: Cdp) {
        let _ = self.dashboard.set(View::new(webview, cdp, true, String::new()));
    }

    pub(crate) fn dashboard(&self) -> Option<Arc<View>> {
        self.dashboard.get().cloned()
    }

    /// Every child view, for the menu's focus routing.
    pub(crate) fn all(&self) -> Vec<Arc<View>> {
        self.views().values().cloned().collect()
    }

    /// For diagnostics: ids and whether each is on screen.
    pub(crate) fn status(&self) -> Value {
        let mut list: Vec<Value> =
            self.views().iter().map(|(id, v)| json!({ "id": id, "placed": v.placed.load(Ordering::SeqCst) })).collect();
        list.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        Value::Array(list)
    }

    fn emit(listeners: &Listeners, view: &ViewId, event: &ViewEvent) {
        let list: Vec<Arc<dyn ViewListener>> = listeners.lock().map(|l| l.clone()).unwrap_or_default();
        for listener in list {
            listener.on_view_event(view, event);
        }
    }

    /// Blocking: asks the main thread to create the native view.
    fn create_blocking(&self, spec: &ViewSpec) -> Result<ViewId, ViewError> {
        let n = self.counter.fetch_add(1, Ordering::SeqCst);
        let id = ViewId(format!("bt-{:08x}{n:04x}", std::process::id()));
        let policy = create::Policy {
            // Fence privileged schemes only; where a page may go is the core's decision.
            navigation: Box::new(|url| !matches!(url.scheme(), "eos" | "file" | "chrome" | "devtools")),
            open_requested: {
                let (listeners, id) = (self.listeners.clone(), id.clone());
                Box::new(move |url| Views::emit(&listeners, &id, &ViewEvent::OpenRequested { url: url.to_string() }))
            },
        };
        // A name, not a path: Chromium keeps it under the app's root cache folder, apart from
        // the dashboard's own storage.
        let profile = format!("view-{}", profile_dir(&spec.profile));
        let builder = create::builder(id.as_str(), (0.0, 0.0), PARKED_SIZE, Some(&PathBuf::from(&profile)), policy);
        let webview = self.window.add_child(builder).map_err(shell_error)?;
        let cdp = Cdp::attach(&webview, {
            let (listeners, id, me) = (self.listeners.clone(), id.clone(), self.me.clone());
            move |method, params| {
                if method == "Page.frameNavigated"
                    && params.pointer("/frame/parentId").is_none()
                    && let (Some(views), Some(url)) =
                        (me.upgrade(), params.pointer("/frame/url").and_then(Value::as_str))
                {
                    views.navigated(&id, url);
                }
                Views::emit(&listeners, &id, &ViewEvent::Cdp { method: method.to_string(), params })
            }
        })?;
        let view = View::new(webview, cdp, false, profile.clone());
        self.park_blocking(&view)?;
        self.views().insert(id.0.clone(), view.clone());
        // A new view's request context starts with the guarded script: put back what the
        // profile's other views were given.
        self.sync_profile(&profile, true);
        if let Some(url) = spec.url.as_deref().filter(|u| !u.is_empty())
            && let Ok(url) = tauri::Url::parse(url)
        {
            view.webview.navigate(url).map_err(shell_error)?;
        }
        Ok(id)
    }

    fn park_blocking(&self, view: &View) -> Result<(), ViewError> {
        view.placed.store(false, Ordering::SeqCst);
        view.webview.hide().map_err(shell_error)?;
        view.webview.set_position(LogicalPosition::new(0.0, 0.0)).map_err(shell_error)?;
        view.webview.set_size(LogicalSize::new(PARKED_SIZE.0, PARKED_SIZE.1)).map_err(shell_error)
    }

    fn place_blocking(&self, view: &View, rect: Rect) -> Result<(), ViewError> {
        view.webview.set_position(LogicalPosition::new(rect.x, rect.y)).map_err(shell_error)?;
        view.webview.set_size(LogicalSize::new(rect.width, rect.height)).map_err(shell_error)?;
        // Raising a view re-adds it to the window: only when it comes on screen, not on
        // every step of a splitter drag.
        if !view.placed.swap(true, Ordering::SeqCst) {
            view.webview.show().map_err(shell_error)?;
            view.webview
                .with_cef_webview(|w| {
                    if let Some(host) = w.browser().host() {
                        appkit::bring_view_to_front(host.window_handle().cast());
                    }
                })
                .map_err(shell_error)?;
        }
        Ok(())
    }

    // ---- the local network ---------------------------------------------------------

    /// Gives the profile the proxy script its views call for: open while any of them was
    /// sent to the local network by the user, guarded otherwise. Blocking.
    fn sync_profile(&self, profile: &str, force: bool) {
        let members: Vec<Arc<View>> = self.views().values().filter(|v| v.profile == profile).cloned().collect();
        let Some(any) = members.first() else {
            self.open_profiles.lock().unwrap_or_else(|p| p.into_inner()).remove(profile);
            return;
        };
        let open = members.iter().any(|v| v.local().is_open());
        let was_open = {
            let mut profiles = self.open_profiles.lock().unwrap_or_else(|p| p.into_inner());
            let was = profiles.contains(profile);
            if open {
                profiles.insert(profile.to_string());
            } else {
                profiles.remove(profile);
            }
            was
        };
        // A profile that never opened already has the guarded script from its creation.
        if open == was_open && !(force && open) {
            return;
        }
        let system = self.system.lock().unwrap_or_else(|p| p.into_inner()).clone();
        match proxy::apply(&any.webview, lan_guard::script_url(open, &system)) {
            Ok(()) => crate::log::log(
                "lan",
                if open {
                    "a view was sent to the local network: its profile may reach it"
                } else {
                    "the view left the local network: its profile is guarded again"
                },
            ),
            Err(e) => crate::log::log("lan", &format!("the proxy script could not be set: {e}")),
        }
        // Chromium hands the new script to its network process; a request sent in the
        // same instant could still meet the old one.
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    /// The user asked `id` for a page on `host`. Blocking (it may ask the resolver).
    fn allow_local_blocking(&self, id: &ViewId, host: &str) -> Result<(), ViewError> {
        let view = self.view(id)?;
        {
            let mut local = view.local();
            if lan_guard::reaches_local_network(host) {
                local.asked(host);
            } else {
                // Somewhere on the web: whatever was open for this view is over.
                *local = LocalPage::None;
            }
        }
        self.sync_profile(&view.profile, false);
        Ok(())
    }

    /// The view's top-level page changed. Called on the main thread: the work is handed on.
    fn navigated(&self, id: &ViewId, url: &str) {
        let Ok(view) = self.view(id) else { return };
        let changed = {
            let mut local = view.local();
            let before = local.is_open();
            local.navigated(url);
            before != local.is_open()
        };
        if changed && let Some(me) = self.me.upgrade() {
            self.rt.spawn_blocking(move || me.sync_profile(&view.profile, false));
        }
    }

    /// The system's proxy settings changed: every profile gets its script again. Blocking.
    pub(crate) fn system_proxy_changed(&self, system: SystemProxy) {
        {
            let mut current = self.system.lock().unwrap_or_else(|p| p.into_inner());
            if *current == system {
                return;
            }
            *current = system.clone();
        }
        crate::log::log("lan", "the system's proxy settings changed");
        let open = self.open_profiles.lock().unwrap_or_else(|p| p.into_inner()).clone();
        let mut done = std::collections::HashSet::new();
        for view in self.dashboard().into_iter().chain(self.all()) {
            if done.insert(view.profile.clone()) {
                let _ = proxy::apply(&view.webview, lan_guard::script_url(open.contains(&view.profile), &system));
            }
        }
    }

    async fn blocking<T: Send + 'static>(
        self: &Arc<Self>,
        f: impl FnOnce(&Views) -> Result<T, ViewError> + Send + 'static,
    ) -> Result<T, ViewError> {
        let me = self.clone();
        tokio::task::spawn_blocking(move || f(&me)).await.map_err(shell_error)?
    }

    /// Runs the open panel on the main thread and waits for the user.
    async fn pick(&self, directories: bool, multiple: bool) -> Option<Vec<String>> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.app.run_on_main_thread(move || drop(tx.send(appkit::open_panel(directories, multiple)))).ok()?;
        rx.await.ok().flatten()
    }
}

/// The ports are implemented on the shared handle, so a call can hop to a blocking thread.
pub(crate) struct ViewPorts(pub(crate) Arc<Views>);

impl BrowserViews for ViewPorts {
    fn create(&self, spec: ViewSpec) -> BoxFuture<'_, Result<ViewId, ViewError>> {
        Box::pin(self.0.blocking(move |views| views.create_blocking(&spec)))
    }

    fn close(&self, view: &ViewId) -> BoxFuture<'_, Result<(), ViewError>> {
        let id = view.clone();
        Box::pin(self.0.blocking(move |views| {
            let Some(view) = views.views().remove(id.as_str()) else { return Ok(()) };
            // The other views of the profile lose what only this one had open.
            *view.local() = LocalPage::None;
            views.sync_profile(&view.profile, false);
            view.webview.close().map_err(shell_error)
        }))
    }

    fn place(&self, view: &ViewId, rect: Rect) -> BoxFuture<'_, Result<(), ViewError>> {
        let id = view.clone();
        Box::pin(self.0.blocking(move |views| views.place_blocking(views.view(&id)?.as_ref(), rect)))
    }

    fn park(&self, view: &ViewId) -> BoxFuture<'_, Result<(), ViewError>> {
        let id = view.clone();
        Box::pin(self.0.blocking(move |views| views.park_blocking(views.view(&id)?.as_ref())))
    }

    fn set_muted(&self, view: &ViewId, muted: bool) -> BoxFuture<'_, Result<(), ViewError>> {
        let id = view.clone();
        Box::pin(self.0.blocking(move |views| {
            views
                .view(&id)?
                .webview
                .with_cef_webview(move |w| {
                    if let Some(host) = w.browser().host() {
                        host.set_audio_muted(i32::from(muted));
                    }
                })
                .map_err(shell_error)
        }))
    }

    fn allow_local_network(&self, view: &ViewId, host: &str) -> BoxFuture<'_, Result<(), ViewError>> {
        let (id, host) = (view.clone(), host.to_string());
        Box::pin(async move {
            let view = self.0.view(&id)?;
            // Leaving the local network is noticed from the page's own navigation events.
            // Not waited for: a view stuck on a page that does not answer is slow to reply,
            // and the user's next address must not wait on it.
            self.0.rt.spawn(async move {
                let _ = view.cdp.call("Page.enable", json!({})).await;
            });
            self.0.blocking(move |views| views.allow_local_blocking(&id, &host)).await
        })
    }

    fn cdp(&self, view: &ViewId, method: &str, params: Value) -> BoxFuture<'_, Result<Value, ViewError>> {
        let (view, method) = (self.0.view(view), method.to_string());
        Box::pin(async move { view?.cdp.call(&method, params).await })
    }

    fn listen(&self, listener: Arc<dyn ViewListener>) {
        if let Ok(mut listeners) = self.0.listeners.lock() {
            listeners.push(listener);
        }
    }
}

impl Capture for ViewPorts {
    fn capture(&self, target: CaptureTarget, format: ImageFormat) -> BoxFuture<'_, Result<Image, ViewError>> {
        let view = match &target {
            CaptureTarget::Dashboard => {
                self.0.dashboard().ok_or_else(|| ViewError::Shell("the dashboard is not up yet".into()))
            }
            CaptureTarget::View(id) => self.0.view(id),
        };
        Box::pin(async move {
            let params = match format {
                ImageFormat::Png => json!({ "format": "png" }),
                ImageFormat::Jpeg { quality } => json!({ "format": "jpeg", "quality": quality }),
            };
            let shot = view?.cdp.call("Page.captureScreenshot", params).await?;
            let data = shot.get("data").and_then(Value::as_str).unwrap_or("");
            let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(shell_error)?;
            Ok(Image { format, bytes })
        })
    }
}

impl FilePicker for ViewPorts {
    fn pick_directory(&self) -> BoxFuture<'_, Option<String>> {
        Box::pin(async move { self.0.pick(true, false).await.and_then(|paths| paths.into_iter().next()) })
    }

    fn pick_files(&self) -> BoxFuture<'_, Option<Vec<String>>> {
        Box::pin(async move { self.0.pick(false, true).await })
    }
}
