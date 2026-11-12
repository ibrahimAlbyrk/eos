//! The native side of the views of other computers (`eos_bridge::hosts`): one child view
//! per paired computer, filling the window, in a profile of its own whose requests of the
//! app's origins go to that view's own door. It may only show the app's own origin; a link
//! elsewhere opens in the system browser.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use eos_bridge::Service;
use eos_bridge::hosts::HostSurface;
use eos_bridge::urlspace::{APP_HOST, RAW_HOST};
use eos_core::BoxFuture;
use tauri::Manager;
use tauri_runtime_cef::WebviewCefExt;
use tauri_runtime_cef::cef::{ImplBrowser, ImplBrowserHost};

use super::{Cdp, View, Views, create, profile_dir};
use crate::host::open_external;
use crate::native::appkit;
use crate::scheme;

const WINDOW_SIZE: (f64, f64) = (1280.0, 820.0);
const WINDOW_MIN: (f64, f64) = (800.0, 500.0);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

pub(crate) struct HostShell {
    me: std::sync::Weak<HostShell>,
    views: Arc<Views>,
    quiet: bool,
    live: Mutex<HashMap<String, Arc<View>>>,
    windows: AtomicU64,
}

/// The app's own origin, or a blank page: nothing else loads in a host's view.
fn own_page(url: &tauri::Url) -> bool {
    (url.scheme() == "http" && url.host_str() == Some(APP_HOST)) || url.as_str() == "about:blank"
}

impl HostShell {
    pub(crate) fn new(views: Arc<Views>, quiet: bool) -> Arc<Self> {
        Arc::new_cyclic(|me| HostShell {
            me: me.clone(),
            views,
            quiet,
            live: Mutex::default(),
            windows: AtomicU64::new(0),
        })
    }

    /// For the menu's edit commands: the views of other computers.
    pub(crate) fn natives(&self) -> Vec<Arc<View>> {
        lock(&self.live).values().cloned().collect()
    }

    /// A host's page in `window`, behind `service`, loading the entry document. Blocking.
    fn page_blocking(
        window: &tauri::Window,
        label: &str,
        profile: &str,
        size: (f64, f64),
        service: Arc<dyn Service>,
    ) -> Result<Arc<View>, String> {
        let policy = create::Policy {
            navigation: Box::new(|url| {
                let own = own_page(url);
                if !own {
                    open_external(url);
                }
                own
            }),
            open_requested: Box::new(open_external),
        };
        let folder = PathBuf::from(format!("view-{}", profile_dir(profile)));
        let builder = create::builder(label, (0.0, 0.0), size, Some(&folder), policy).auto_resize();
        let webview = window.add_child(builder).map_err(|e| e.to_string())?;
        // The door must be on the view's request context before its first request leaves.
        let (tx, rx) = std::sync::mpsc::channel();
        webview
            .with_cef_webview(move |w| {
                let _ = tx.send(scheme::register(&w.browser(), &[APP_HOST, RAW_HOST], service));
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(10)).map_err(|e| e.to_string())??;
        let cdp = Cdp::attach(&webview, |_, _| {}).map_err(|e| e.to_string())?;
        let entry = tauri::Url::parse(&format!("http://{APP_HOST}/index.html")).map_err(|e| e.to_string())?;
        webview.navigate(entry).map_err(|e| e.to_string())?;
        Ok(View::new(webview, cdp, false, folder.to_string_lossy().into_owned()))
    }

    async fn blocking<T: Send + 'static>(&self, f: impl FnOnce(&HostShell) -> T + Send + 'static) -> Option<T> {
        let me = self.me.upgrade()?;
        tokio::task::spawn_blocking(move || f(&me)).await.ok()
    }

    fn view(&self, id: &str) -> Option<Arc<View>> {
        lock(&self.live).get(id).cloned()
    }
}

impl HostSurface for HostShell {
    fn create(&self, id: &str, service: Arc<dyn Service>) -> BoxFuture<'_, Result<(), String>> {
        let id = id.to_owned();
        Box::pin(async move {
            let made = self
                .blocking(move |shell| {
                    let window = &shell.views.window;
                    let size = window
                        .inner_size()
                        .ok()
                        .zip(window.scale_factor().ok())
                        .map(|(s, scale)| s.to_logical::<f64>(scale))
                        .map_or(WINDOW_SIZE, |s| (s.width, s.height));
                    let view = Self::page_blocking(
                        window,
                        &format!("host-{}", profile_dir(&id)),
                        &format!("host-{id}"),
                        size,
                        service,
                    )?;
                    view.webview.hide().map_err(|e| e.to_string())?;
                    lock(&shell.live).insert(id, view);
                    Ok::<(), String>(())
                })
                .await;
            made.unwrap_or_else(|| Err("the shell is closing".into()))
        })
    }

    fn show(&self, id: &str) -> BoxFuture<'_, ()> {
        let view = self.view(id);
        Box::pin(async move {
            let Some(view) = view else { return };
            self.blocking(move |_| {
                let _ = view.webview.show();
                let _ = view.webview.with_cef_webview(|w| {
                    if let Some(host) = w.browser().host() {
                        appkit::bring_view_to_front(host.window_handle().cast());
                        host.set_focus(1);
                    }
                });
            })
            .await;
        })
    }

    fn hide(&self, id: &str) -> BoxFuture<'_, ()> {
        let view = self.view(id);
        Box::pin(async move {
            if let Some(view) = view {
                self.blocking(move |_| drop(view.webview.hide())).await;
            }
        })
    }

    fn close(&self, id: &str) -> BoxFuture<'_, ()> {
        let view = lock(&self.live).remove(id);
        Box::pin(async move {
            if let Some(view) = view {
                self.blocking(move |_| drop(view.webview.close())).await;
            }
        })
    }

    fn open_window(&self, id: &str, title: &str, service: Arc<dyn Service>) -> BoxFuture<'_, ()> {
        let (id, title) = (id.to_owned(), title.to_owned());
        Box::pin(async move {
            let n = self.windows.fetch_add(1, Ordering::SeqCst);
            let opened = self
                .blocking(move |shell| {
                    let label = format!("hostwin-{}-{n}", profile_dir(&id));
                    let window = tauri::window::WindowBuilder::new(&shell.views.app, &label)
                        .title(&title)
                        .inner_size(WINDOW_SIZE.0, WINDOW_SIZE.1)
                        .min_inner_size(WINDOW_MIN.0, WINDOW_MIN.1)
                        .focused(!shell.quiet)
                        .build()
                        .map_err(|e| e.to_string())?;
                    // A profile of its own: the window's page and the view in the main window
                    // each have their own door.
                    Self::page_blocking(
                        &window,
                        &format!("{label}-view"),
                        &format!("host-{id}-window"),
                        WINDOW_SIZE,
                        service,
                    )
                    .map(drop)
                })
                .await;
            if let Some(Err(e)) = opened {
                crate::log::log("hosts", &format!("the window did not open: {e}"));
            }
        })
    }

    fn focus_dashboard(&self) {
        if let Some(dashboard) = self.views.dashboard() {
            let _ = dashboard.webview.with_cef_webview(|w| {
                if let Some(host) = w.browser().host() {
                    host.set_focus(1);
                }
            });
        }
    }

    fn pick(&self, folders_only: bool) -> BoxFuture<'_, Option<Vec<String>>> {
        Box::pin(async move {
            let (tx, rx) = tokio::sync::oneshot::channel();
            let app = self.views.app.clone();
            let asked = app.run_on_main_thread(move || {
                let picked = if folders_only { appkit::open_panel(true, false) } else { appkit::open_panel_any() };
                let _ = tx.send(picked);
            });
            asked.ok()?;
            rx.await.ok().flatten()
        })
    }

    /// An absolute path only: never a string `open` could read as an option.
    fn reveal(&self, path: &str) {
        if path.starts_with('/') {
            let _ = std::process::Command::new("/usr/bin/open")
                .arg("-R")
                .arg(path)
                .stdin(std::process::Stdio::null())
                .spawn();
        }
    }
}
