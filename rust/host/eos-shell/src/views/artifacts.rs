//! The native side of the artifact views (`eos_bridge::artifacts`): child views of the main
//! window in a profile per Claude sign-in, the peek's zoom and shield as a script in an
//! isolated world, stills over DevTools, and the sign-in window.
//!
//! The shield (`app/src/preload/artifactOverlay.ts`) lives in its own world and exposes
//! nothing to the page: a closed shadow root styled by a constructable stylesheet (the
//! site's nonce policy blocks inline styles), and a binding only that world can call. A
//! click counts only when the browser marks it trusted.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use base64::Engine;
use eos_bridge::artifacts::urls::Viewer;
use eos_bridge::artifacts::{ArtifactSurface, ArtifactViews, SurfaceEvent, ViewKey};
use eos_core::BoxFuture;
use eos_core::shell::Rect;
use serde_json::{Value, json};
use tauri::{LogicalPosition, LogicalSize, Manager};
use tauri_runtime_cef::WebviewCefExt;
use tauri_runtime_cef::cef::{ImplBrowser, ImplBrowserHost};
use tokio::sync::watch;

use super::{Cdp, PARKED_SIZE, View, Views, create, profile_dir};
use crate::host::open_external;
use crate::log::log;
use crate::native::appkit;

const WORLD: &str = "eos-artifact";
const BINDING: &str = "eosArtifactShield";
const SHIELD_JS: &str = include_str!("artifact_shield.js");
/// The widest still kept, in pixels.
const STILL_MAX_WIDTH: f64 = 1600.0;
const STILL_QUALITY: u8 = 72;
const SIGN_IN_SIZE: (f64, f64) = (460.0, 720.0);
const SIGN_IN_POLL: Duration = Duration::from_secs(1);

/// One artifact view and what the shell keeps for it.
struct ArtView {
    view: Arc<View>,
    profile: String,
    /// Wanted: the page is the peek's miniature.
    peek: AtomicBool,
    /// The main frame and the shield's world in its current document.
    frame: Mutex<Option<String>>,
    world: Mutex<Option<i64>>,
}

/// An open sign-in window, and how its sign-in ended (`None` while it goes on).
type SignInWindow = (tauri::Window, watch::Receiver<Option<bool>>);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

pub(crate) struct ArtifactShell {
    me: std::sync::Weak<ArtifactShell>,
    views: Arc<Views>,
    viewer: Viewer,
    quiet: bool,
    live: Mutex<HashMap<ViewKey, Arc<ArtView>>>,
    /// The pool, told what the pages do.
    pool: OnceLock<ArtifactViews>,
    /// A sign-in window per profile while it is open.
    signing_in: Mutex<HashMap<String, SignInWindow>>,
}

fn label(view: ViewKey) -> String {
    format!("art-{:08x}{view:04x}", std::process::id())
}

/// Reads one main-frame DevTools event of an artifact view as what the pool wants to know.
fn surface_event(art: &ArtView, method: &str, params: &Value) -> Option<SurfaceEvent> {
    let main = |frame: &str| lock(&art.frame).as_deref() == Some(frame);
    match method {
        "Page.frameNavigated" if params.pointer("/frame/parentId").is_none() => {
            let frame = params.get("frame")?;
            *lock(&art.frame) = frame.get("id").and_then(Value::as_str).map(str::to_owned);
            if frame.get("unreachableUrl").is_some() {
                return Some(SurfaceEvent::Failed { description: String::new() });
            }
            let url = frame.get("url").and_then(Value::as_str)?.to_owned();
            Some(SurfaceEvent::Navigated { url })
        }
        "Page.navigatedWithinDocument" if params.get("frameId").and_then(Value::as_str).is_some_and(main) => {
            Some(SurfaceEvent::InPage { url: params.get("url").and_then(Value::as_str)?.to_owned() })
        }
        "Page.domContentEventFired" => Some(SurfaceEvent::DomReady),
        "Page.loadEventFired" => Some(SurfaceEvent::Loaded),
        "Inspector.targetCrashed" => Some(SurfaceEvent::Crashed),
        "Runtime.bindingCalled" if params.get("name").and_then(Value::as_str) == Some(BINDING) => {
            let external = params.get("payload").and_then(Value::as_str) == Some("external");
            Some(SurfaceEvent::Shield { external })
        }
        _ => None,
    }
}

impl ArtifactShell {
    pub(crate) fn new(views: Arc<Views>, viewer: Viewer, quiet: bool) -> Arc<Self> {
        Arc::new_cyclic(|me| ArtifactShell {
            me: me.clone(),
            views,
            viewer,
            quiet,
            live: Mutex::default(),
            pool: OnceLock::new(),
            signing_in: Mutex::default(),
        })
    }

    /// The pool the views report to. Set once, right after the pool started.
    pub(crate) fn report_to(&self, pool: ArtifactViews) {
        let _ = self.pool.set(pool);
    }

    fn art(&self, view: ViewKey) -> Option<Arc<ArtView>> {
        lock(&self.live).get(&view).cloned()
    }

    fn report(&self, view: ViewKey, event: SurfaceEvent) {
        if let Some(pool) = self.pool.get() {
            pool.surface_event(view, event);
        }
    }

    /// The view's page is shown or not as the peek, in its current document.
    async fn apply_peek(art: &ArtView) {
        let Some(context) = *lock(&art.world) else { return };
        let peek = art.peek.load(Ordering::SeqCst);
        let expression = format!("globalThis.__eosPeek && __eosPeek({peek})");
        let applied =
            art.view.cdp.call("Runtime.evaluate", json!({ "expression": expression, "contextId": context })).await;
        if let Err(e) = applied {
            log("artifacts", &format!("the peek was not applied: {e}"));
        }
    }

    /// DevTools events of one view. Called on the main thread: hands work on.
    fn on_cdp(&self, key: ViewKey, method: &str, params: &Value) {
        let Some(art) = self.art(key) else { return };
        match method {
            // The shield's world in the main frame's new document: it gets the current state.
            "Runtime.executionContextCreated" => {
                let context = params.get("context").unwrap_or(&Value::Null);
                let frame = context.pointer("/auxData/frameId").and_then(Value::as_str);
                let main = frame.is_some_and(|f| lock(&art.frame).as_deref().is_none_or(|m| m == f));
                if context.get("name").and_then(Value::as_str) == Some(WORLD) && main {
                    *lock(&art.world) = context.get("id").and_then(Value::as_i64);
                    self.views.rt.spawn(async move { Self::apply_peek(&art).await });
                }
                return;
            }
            "Runtime.executionContextsCleared" => {
                *lock(&art.world) = None;
                return;
            }
            "Runtime.executionContextDestroyed" => {
                let gone = params.get("executionContextId").and_then(Value::as_i64);
                let mut world = lock(&art.world);
                if gone.is_some() && *world == gone {
                    *world = None;
                }
                return;
            }
            _ => {}
        }
        if let Some(event) = surface_event(&art, method, params) {
            self.report(key, event);
        }
    }

    fn create_blocking(&self, key: ViewKey, profile: &str) -> Result<Arc<ArtView>, String> {
        let me = self.me.clone();
        let refused = self.me.clone();
        let viewer = self.viewer.clone();
        let policy = create::Policy {
            // Only the viewer stays in the view; the pool decides what becomes of the rest.
            navigation: Box::new(move |url| {
                let allowed = viewer.is_viewer(url.as_str()) || url.as_str() == "about:blank";
                if !allowed && let Some(shell) = refused.upgrade() {
                    shell.report(key, SurfaceEvent::Refused { url: url.to_string() });
                }
                allowed
            }),
            open_requested: Box::new(move |url| {
                if let Some(shell) = me.upgrade() {
                    shell.report(key, SurfaceEvent::OpenRequested { url: url.to_string() });
                }
            }),
        };
        let folder = PathBuf::from(format!("view-{}", profile_dir(profile)));
        let builder = create::builder(&label(key), (0.0, 0.0), PARKED_SIZE, Some(&folder), policy);
        let webview = self.views.window.add_child(builder).map_err(|e| e.to_string())?;
        let me = self.me.clone();
        let cdp = Cdp::attach(&webview, move |method, params| {
            if let Some(shell) = me.upgrade() {
                shell.on_cdp(key, method, &params);
            }
        })
        .map_err(|e| e.to_string())?;
        let view = View::new(webview, cdp, false, folder.to_string_lossy().into_owned());
        self.views.park_blocking(&view).map_err(|e| e.to_string())?;
        Ok(Arc::new(ArtView {
            view,
            profile: profile.to_owned(),
            peek: AtomicBool::new(false),
            frame: Mutex::default(),
            world: Mutex::default(),
        }))
    }

    async fn blocking<T: Send + 'static>(&self, f: impl FnOnce(&ArtifactShell) -> T + Send + 'static) -> Option<T> {
        let me = self.me.upgrade()?;
        tokio::task::spawn_blocking(move || f(&me)).await.ok()
    }

    /// A view of `profile` to ask DevTools through, made for the call when none is open.
    async fn probe<T>(&self, profile: &str, ask: impl AsyncFnOnce(&Cdp) -> T) -> Option<T> {
        let open = lock(&self.live).values().find(|a| a.profile == profile).cloned();
        if let Some(art) = open {
            return Some(ask(&art.view.cdp).await);
        }
        let profile = profile.to_owned();
        let made = self.blocking(move |shell| shell.create_blocking(ViewKey::MAX, &profile)).await?;
        let art = made.inspect_err(|e| log("artifacts", &format!("no view to ask: {e}"))).ok()?;
        let answer = ask(&art.view.cdp).await;
        let webview = art.view.webview.clone();
        let _ = tokio::task::spawn_blocking(move || webview.close()).await;
        Some(answer)
    }

    /// Whether DevTools sees a `sessionKey` cookie for the site in this view's profile.
    async fn has_session(cdp: &Cdp, cookie_url: &str) -> bool {
        let Ok(found) = cdp.call("Network.getCookies", json!({ "urls": [cookie_url] })).await else { return false };
        found.get("cookies").and_then(Value::as_array).is_some_and(|cookies| {
            cookies.iter().any(|c| {
                c.get("name").and_then(Value::as_str) == Some("sessionKey")
                    && c.get("value").and_then(Value::as_str).is_some_and(|v| !v.is_empty())
            })
        })
    }

    /// The sign-in window: one per profile. Blocking.
    fn open_sign_in_blocking(&self, profile: &str) -> Result<(tauri::Window, Arc<View>), String> {
        let label = format!("signin-{}", profile_dir(profile));
        let window = tauri::window::WindowBuilder::new(&self.views.app, &label)
            .title("Sign in to claude.ai")
            .inner_size(SIGN_IN_SIZE.0, SIGN_IN_SIZE.1)
            .focused(!self.quiet)
            .build()
            .map_err(|e| e.to_string())?;
        // The site's sign-in may pass through its identity providers' pages: any web page
        // may load here, nothing privileged, and no window opens.
        let policy = create::Policy {
            navigation: Box::new(|url| matches!(url.scheme(), "http" | "https" | "about")),
            open_requested: Box::new(|_| {}),
        };
        let folder = PathBuf::from(format!("view-{}", profile_dir(profile)));
        let builder = create::builder(&format!("{label}-view"), (0.0, 0.0), SIGN_IN_SIZE, Some(&folder), policy);
        let webview = window.add_child(builder.auto_resize()).map_err(|e| e.to_string())?;
        let cdp = Cdp::attach(&webview, |_, _| {}).map_err(|e| e.to_string())?;
        let url = tauri::Url::parse(&self.viewer.login_url()).map_err(|e| e.to_string())?;
        webview.navigate(url).map_err(|e| e.to_string())?;
        Ok((window, View::new(webview, cdp, true, folder.to_string_lossy().into_owned())))
    }

    async fn sign_in_flow(&self, profile: &str) -> bool {
        let existing = lock(&self.signing_in).get(profile).cloned();
        if let Some((window, mut ended)) = existing {
            if !self.quiet {
                let _ = window.set_focus();
            }
            // The flow under way answers for its window.
            return ended.wait_for(Option::is_some).await.ok().and_then(|v| *v).unwrap_or(false);
        }
        let owned = profile.to_owned();
        let Some(Ok((window, view))) = self.blocking(move |shell| shell.open_sign_in_blocking(&owned)).await else {
            log("artifacts", "the sign-in window did not open");
            return false;
        };
        let label = window.label().to_owned();
        let (ended, waiting) = watch::channel(None);
        lock(&self.signing_in).insert(profile.to_owned(), (window.clone(), waiting));
        let cookie_url = self.viewer.cookie_url();
        let finished = loop {
            tokio::time::sleep(SIGN_IN_POLL).await;
            if self.views.app.get_window(&label).is_none() {
                // Closed by the user: whatever the profile holds now.
                break self.signed_in(profile).await;
            }
            let at = view.webview.url().map(|u| u.to_string()).unwrap_or_default();
            if Self::has_session(&view.cdp, &cookie_url).await && !self.viewer.on_sign_in_page(&at) {
                let _ = window.close();
                break true;
            }
        };
        lock(&self.signing_in).remove(profile);
        let _ = ended.send(Some(finished));
        finished
    }

    /// For the menu's edit commands: every artifact view's native view.
    pub(crate) fn natives(&self) -> Vec<Arc<View>> {
        lock(&self.live).values().map(|a| a.view.clone()).collect()
    }

    /// The JPEG of a page, at most [`STILL_MAX_WIDTH`] pixels wide.
    async fn still(cdp: &Cdp) -> Option<Vec<u8>> {
        let size = cdp
            .call(
                "Runtime.evaluate",
                json!({ "expression": "[innerWidth, innerHeight, devicePixelRatio]", "returnByValue": true }),
            )
            .await
            .ok()?;
        let n = |i: usize| size.pointer(&format!("/result/value/{i}")).and_then(Value::as_f64).filter(|v| *v > 0.0);
        let mut params = json!({ "format": "jpeg", "quality": STILL_QUALITY });
        if let (Some(width), Some(height), Some(ratio)) = (n(0), n(1), n(2)) {
            let scale = (STILL_MAX_WIDTH / (width * ratio)).min(1.0);
            params["clip"] = json!({ "x": 0, "y": 0, "width": width, "height": height, "scale": scale });
        }
        let shot = cdp.call("Page.captureScreenshot", params).await.ok()?;
        let data = shot.get("data").and_then(Value::as_str)?;
        base64::engine::general_purpose::STANDARD.decode(data).ok()
    }
}

impl ArtifactSurface for ArtifactShell {
    fn create(&self, view: ViewKey, profile: &str) -> BoxFuture<'_, Result<(), String>> {
        let profile = profile.to_owned();
        Box::pin(async move {
            let art = self
                .blocking(move |shell| shell.create_blocking(view, &profile))
                .await
                .ok_or_else(|| "the shell is closing".to_owned())??;
            lock(&self.live).insert(view, art.clone());
            let cdp = &art.view.cdp;
            // The main frame's id, before any document loads: the shield lives in its world.
            let tree = cdp.call("Page.getFrameTree", json!({})).await.map_err(|e| e.to_string())?;
            *lock(&art.frame) = tree.pointer("/frameTree/frame/id").and_then(Value::as_str).map(str::to_owned);
            for (method, params) in [
                ("Page.enable", json!({})),
                ("Runtime.enable", json!({})),
                ("Inspector.enable", json!({})),
                ("Runtime.addBinding", json!({ "name": BINDING, "executionContextName": WORLD })),
                ("Page.addScriptToEvaluateOnNewDocument", json!({ "source": SHIELD_JS, "worldName": WORLD })),
            ] {
                cdp.call(method, params).await.map_err(|e| e.to_string())?;
            }
            Ok(())
        })
    }

    fn navigate(&self, view: ViewKey, url: &str) -> BoxFuture<'_, ()> {
        let (art, url) = (self.art(view), tauri::Url::parse(url));
        Box::pin(async move {
            if let (Some(art), Ok(url)) = (art, url) {
                let _ = art.view.webview.navigate(url);
            }
        })
    }

    fn show(&self, view: ViewKey, rect: Rect, radius: f64) -> BoxFuture<'_, ()> {
        let art = self.art(view);
        Box::pin(async move {
            let Some(art) = art else { return };
            self.blocking(move |shell| {
                if shell.views.place_blocking(&art.view, rect).is_err() {
                    return;
                }
                // An address, not a pointer, crosses to the main thread.
                let native = art.view.ns_view() as usize;
                let _ = shell
                    .views
                    .app
                    .run_on_main_thread(move || appkit::set_corner_radius(native as *mut std::ffi::c_void, radius));
            })
            .await;
        })
    }

    fn hide(&self, view: ViewKey, size: (f64, f64)) -> BoxFuture<'_, ()> {
        let art = self.art(view);
        Box::pin(async move {
            let Some(art) = art else { return };
            self.blocking(move |_| {
                let webview = &art.view.webview;
                art.view.placed.store(false, Ordering::SeqCst);
                let _ = webview.hide();
                let _ = webview.set_position(LogicalPosition::new(0.0, 0.0));
                let _ = webview.set_size(LogicalSize::new(size.0, size.1));
            })
            .await;
        })
    }

    fn set_peek(&self, view: ViewKey, peek: bool) -> BoxFuture<'_, ()> {
        let art = self.art(view);
        Box::pin(async move {
            if let Some(art) = art {
                art.peek.store(peek, Ordering::SeqCst);
                Self::apply_peek(&art).await;
            }
        })
    }

    fn set_muted(&self, view: ViewKey, muted: bool) -> BoxFuture<'_, ()> {
        let art = self.art(view);
        Box::pin(async move {
            if let Some(art) = art {
                let _ = art.view.webview.with_cef_webview(move |w| {
                    if let Some(host) = w.browser().host() {
                        host.set_audio_muted(i32::from(muted));
                    }
                });
            }
        })
    }

    fn go_back(&self, view: ViewKey) -> BoxFuture<'_, bool> {
        let art = self.art(view);
        Box::pin(async move {
            let Some(art) = art else { return false };
            let (tx, rx) = tokio::sync::oneshot::channel();
            let asked = art.view.webview.with_cef_webview(move |w| {
                let browser = w.browser();
                let can = browser.can_go_back() != 0;
                if can {
                    browser.go_back();
                }
                let _ = tx.send(can);
            });
            asked.is_ok() && rx.await.unwrap_or(false)
        })
    }

    fn capture(&self, view: ViewKey) -> BoxFuture<'_, Option<Vec<u8>>> {
        let art = self.art(view);
        Box::pin(async move { Self::still(&art?.view.cdp).await })
    }

    fn close(&self, view: ViewKey) -> BoxFuture<'_, ()> {
        let art = lock(&self.live).remove(&view);
        Box::pin(async move {
            if let Some(art) = art {
                let webview = art.view.webview.clone();
                let _ = tokio::task::spawn_blocking(move || webview.close()).await;
            }
        })
    }

    fn signed_in(&self, profile: &str) -> BoxFuture<'_, bool> {
        let profile = profile.to_owned();
        Box::pin(async move {
            let cookie_url = self.viewer.cookie_url();
            self.probe(&profile, async |cdp: &Cdp| Self::has_session(cdp, &cookie_url).await).await.unwrap_or(false)
        })
    }

    fn sign_in(&self, profile: &str) -> BoxFuture<'_, bool> {
        let profile = profile.to_owned();
        Box::pin(async move { self.sign_in_flow(&profile).await })
    }

    fn sign_out(&self, profile: &str) -> BoxFuture<'_, ()> {
        let profile = profile.to_owned();
        Box::pin(async move {
            let origin = self.viewer.cookie_url().trim_end_matches('/').to_owned();
            self.probe(&profile, async |cdp: &Cdp| {
                let _ = cdp.call("Network.clearBrowserCookies", json!({})).await;
                let _ =
                    cdp.call("Storage.clearDataForOrigin", json!({ "origin": origin, "storageTypes": "all" })).await;
            })
            .await;
        })
    }

    fn open_external(&self, url: &str) {
        if let Ok(url) = tauri::Url::parse(url) {
            open_external(&url);
        }
    }

    fn window_on_screen(&self) -> bool {
        let window = &self.views.window;
        window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(true)
    }
}
