//! Views of the computers this one controls (`app/src/main/hosts.ts`, `transfers.ts`).
//!
//! Each paired computer gets one isolated view inside the main window: switching shows a
//! different, already-live view (no reload, no lost scroll or draft). A view has its own
//! profile (storage, cache, cookies) and its own door to the core ([`HostViewService`]):
//! only its host's prefix `/h/<id>/…` is reachable, every request there carries the view's
//! token (so the core sees that host's user and nobody else), and none of this computer's
//! bridges are offered but the machine switcher and, to a view running this computer's own
//! dashboard, the transfer tab's calls. It runs this computer's dashboard when the host
//! speaks the same API, else the host's own bundle.

mod menu;
mod service;
mod transfers;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use eos_core::BoxFuture;
use serde_json::{Value, json};

use crate::ask::ask;
use crate::core::{Core, Plane};
use crate::host::ShellHost;
use crate::transport::Service;

pub use menu::{MachineItem, machine_items};
pub use service::{HostViewService, host_content_security_policy};

/// Tells a page something: an event name and its payload.
pub type Emit = Arc<dyn Fn(&'static str, Value) + Send + Sync>;

/// What the window shell does for host views.
pub trait HostSurface: Send + Sync + 'static {
    /// A hidden view of host `id`, filling the window, in a profile of its own whose requests
    /// of the app's origins go to `service`; it loads the entry document.
    fn create(&self, id: &str, service: Arc<dyn Service>) -> BoxFuture<'_, Result<(), String>>;
    /// On screen over the whole window, above every other view, with the keyboard.
    fn show(&self, id: &str) -> BoxFuture<'_, ()>;
    fn hide(&self, id: &str) -> BoxFuture<'_, ()>;
    fn close(&self, id: &str) -> BoxFuture<'_, ()>;
    /// "Open in Window": a window of its own, labelled `label` ([`window_label`]), showing
    /// host `id` through `service`. When it closes the shell calls [`HostViews::window_closed`].
    fn open_window(&self, id: &str, label: &str, title: &str, service: Arc<dyn Service>) -> BoxFuture<'_, ()>;
    /// The keyboard back to this computer's dashboard.
    fn focus_dashboard(&self);
    /// The system's open panel: folders only, or files and folders (several). `None`: cancelled.
    fn pick(&self, folders_only: bool) -> BoxFuture<'_, Option<Vec<String>>>;
    /// Shows a file in the file manager.
    fn reveal(&self, path: &str);
}

/// What the host views are built from.
pub struct HostParts {
    pub core: Arc<dyn Core>,
    pub surface: Arc<dyn HostSurface>,
    /// This computer's dashboard bundle.
    pub dist: PathBuf,
    /// The window: drags and zoom from a host view's title strip.
    pub shell: Arc<dyn ShellHost>,
    /// The dashboard's own event stream.
    pub to_dashboard: Emit,
    /// The list or the active computer changed: `{hosts, active, local}` (a view covering the
    /// dashboard; the Machines menu).
    pub changed: Arc<dyn Fn(&Value) + Send + Sync>,
    pub rt: tokio::runtime::Handle,
}

impl std::fmt::Debug for HostParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostParts").field("dist", &self.dist).finish_non_exhaustive()
    }
}

#[derive(Default)]
struct State {
    /// `GET /api/hosts`, as it came.
    hosts: Vec<Value>,
    active: Option<String>,
    /// This computer, as its own core describes it.
    local: Option<Value>,
    /// The API this computer's dashboard speaks.
    local_stamp: Option<String>,
    views: HashMap<String, Arc<HostViewService>>,
    /// Pages opened in windows of their own: the window's number, its host, its door.
    windows: Vec<(u64, String, Arc<HostViewService>)>,
    /// The number of the next window of its own.
    next_window: u64,
}

pub(crate) struct Inner {
    me: Weak<Inner>,
    parts: HostParts,
    state: Mutex<State>,
}

/// The machine switcher and the views of other computers. Cheap to clone.
#[derive(Clone)]
pub struct HostViews {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for HostViews {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostViews").finish_non_exhaustive()
    }
}

const WINDOW_LABEL: &str = "hostwin-";

/// The label of the `n`th window of its own showing a host.
pub fn window_label(n: u64) -> String {
    format!("{WINDOW_LABEL}{n}")
}

/// The window number of a label [`window_label`] made; `None` for any other window.
pub fn window_number(label: &str) -> Option<u64> {
    label.strip_prefix(WINDOW_LABEL)?.parse().ok()
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

impl HostViews {
    pub fn new(parts: HostParts) -> Self {
        Self { inner: Arc::new_cyclic(|me| Inner { me: me.clone(), parts, state: Mutex::default() }) }
    }

    /// `{hosts, active, local}`: what `eosHosts.list()` answers.
    pub fn snapshot(&self) -> Value {
        self.inner.snapshot()
    }

    pub fn active(&self) -> Option<String> {
        self.inner.state().active.clone()
    }

    /// Reads the hosts again (a `hosts:change`), drops the views of forgotten ones and tells
    /// every page.
    pub async fn refresh(&self) {
        self.inner.refresh().await;
    }

    /// `None`: this computer.
    pub async fn switch_to(&self, id: Option<String>) {
        self.inner.switch_to(id).await;
    }

    pub async fn open_in_window(&self, id: String) {
        self.inner.open_in_window(&id).await;
    }

    pub async fn reconnect(&self, id: String) {
        self.inner.reconnect(&id).await;
    }

    /// A host's view cannot manage pairing (it never holds this computer's token): this
    /// computer's view comes forward with its Connect sheet open.
    pub async fn request_connect(&self) {
        self.inner.switch_to(None).await;
        (self.inner.parts.to_dashboard)("hosts:command", json!({ "type": "connect", "invite": null }));
    }

    /// A `transfer:change` of this computer: the views of the host it involves see it.
    pub fn forward_transfer(&self, payload: &Value) {
        self.inner.forward_transfer(payload);
    }

    /// A window of its own closed (`label`, as [`window_label`] made it): its door goes.
    pub fn window_closed(&self, label: &str) {
        if let Some(n) = window_number(label) {
            self.inner.state().windows.retain(|(w, _, _)| *w != n);
        }
    }

    /// A banner raised on host `id` was clicked: its view comes forward and opens what the
    /// banner was about.
    pub async fn open_from_banner(&self, id: String, navigate: Value) {
        self.inner.switch_to(Some(id.clone())).await;
        if let Some(view) = self.inner.state().views.get(&id) {
            view.events().emit_or_wait("navigate", navigate);
        }
    }
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn snapshot(&self) -> Value {
        let st = self.state();
        json!({ "hosts": st.hosts, "active": st.active, "local": st.local })
    }

    fn ui_token(&self) -> String {
        self.parts.core.ui_token()
    }

    /// A call on this computer's own core, as its dashboard.
    async fn local(&self, method: &str, target: &str, body: Option<&Value>) -> Result<(u16, Value), String> {
        ask(self.parts.core.as_ref(), Plane::Api, method, target, &self.ui_token(), body).await
    }

    fn host(&self, id: &str) -> Option<Value> {
        self.state().hosts.iter().find(|h| text(h, "id") == Some(id)).cloned()
    }

    /// Everything that shows a host: views and windows of their own.
    fn pages(&self, id: Option<&str>) -> Vec<Arc<HostViewService>> {
        let st = self.state();
        let views = st.views.iter().filter(|(host, _)| id.is_none_or(|i| i == *host)).map(|(_, v)| v.clone());
        let windows = st.windows.iter().filter(|(_, host, _)| id.is_none_or(|i| i == host)).map(|(_, _, v)| v.clone());
        views.chain(windows).collect()
    }

    fn broadcast(&self) {
        let snapshot = self.snapshot();
        (self.parts.to_dashboard)("hosts:changed", snapshot.clone());
        for page in self.pages(None) {
            page.events().emit("hosts:changed", snapshot.clone());
        }
        (self.parts.changed)(&snapshot);
    }

    async fn refresh(&self) {
        let known = self.state().local.is_some();
        if !known && let Ok((200, info)) = self.local("GET", "/api/host", None).await {
            let mut st = self.state();
            if let Some(name) = text(&info, "name") {
                st.local = Some(json!({
                    "name": name,
                    "platform": text(&info, "platform").unwrap_or("darwin"),
                    "deviceId": text(&info, "deviceId").unwrap_or(""),
                }));
            }
            st.local_stamp = text(&info, "apiStamp").map(str::to_owned);
        }
        let Ok((200, body)) = self.local("GET", "/api/hosts", None).await else { return };
        let hosts = body.get("hosts").and_then(Value::as_array).cloned().unwrap_or_default();
        let (gone, active_gone) = {
            let mut st = self.state();
            st.hosts = hosts;
            let ids: Vec<String> = st.hosts.iter().filter_map(|h| text(h, "id").map(str::to_owned)).collect();
            let gone: Vec<String> = st.views.keys().filter(|id| !ids.contains(id)).cloned().collect();
            st.windows.retain(|(_, id, _)| ids.contains(id));
            for id in &gone {
                st.views.remove(id);
            }
            let active_gone = st.active.as_ref().is_some_and(|a| !ids.contains(a));
            (gone, active_gone)
        };
        for id in gone {
            self.parts.surface.close(&id).await;
        }
        if active_gone {
            self.switch_to(None).await;
        }
        self.broadcast();
    }

    async fn switch_to(&self, id: Option<String>) {
        if id.as_ref().is_some_and(|id| self.host(id).is_none()) {
            return;
        }
        let previous = {
            let mut st = self.state();
            if st.active == id {
                return;
            }
            std::mem::replace(&mut st.active, id.clone())
        };
        if let Some(previous) = previous {
            self.parts.surface.hide(&previous).await;
            if let Some(view) = self.state().views.get(&previous) {
                view.events().emit("hosts:visibility", json!(false));
            }
        }
        self.broadcast();
        let Some(id) = id else {
            self.parts.surface.focus_dashboard();
            return;
        };
        let Some(view) = self.ensure_view(&id).await else { return };
        // The user may have switched again while the view was being built.
        if self.state().active.as_deref() != Some(id.as_str()) {
            return;
        }
        self.parts.surface.show(&id).await;
        view.events().emit("hosts:visibility", json!(true));
    }

    /// The service of a new page showing `id`.
    async fn service_for(&self, id: &str) -> Arc<HostViewService> {
        let host = self.host(id).unwrap_or(Value::Null);
        let target = format!("/api/hosts/{id}/view-token");
        // Without a token the view gets nothing from its host; it shows that as offline.
        let token = match self.local("POST", &target, Some(&json!({}))).await {
            Ok((200, body)) => text(&body, "token").unwrap_or("").to_owned(),
            _ => String::new(),
        };
        let descriptor = json!({
            "id": id,
            "remote": true,
            "name": text(&host, "alias").or_else(|| text(&host, "name")).unwrap_or("Remote Mac"),
            "deviceId": text(&host, "deviceId").unwrap_or(""),
            "home": host.pointer("/info/home").cloned().unwrap_or(Value::Null),
        });
        HostViewService::new(service::Parts {
            id: id.to_owned(),
            view_token: token,
            descriptor,
            core: self.parts.core.clone(),
            dist: self.parts.dist.clone(),
            shell: self.parts.shell.clone(),
            manager: self.me.clone(),
            rt: self.parts.rt.clone(),
        })
    }

    async fn ensure_view(&self, id: &str) -> Option<Arc<HostViewService>> {
        if let Some(view) = self.state().views.get(id) {
            return Some(view.clone());
        }
        let view = self.service_for(id).await;
        if let Err(e) = self.parts.surface.create(id, view.clone()).await {
            tracing::warn!(target: "eos::hosts", error = %e, "no view for a paired computer");
            return None;
        }
        self.state().views.insert(id.to_owned(), view.clone());
        Some(view)
    }

    async fn open_in_window(&self, id: &str) {
        let Some(host) = self.host(id) else { return };
        let title = format!("Eos — {}", text(&host, "alias").or_else(|| text(&host, "name")).unwrap_or("Remote Mac"));
        let view = self.service_for(id).await;
        let label = {
            let mut st = self.state();
            let n = st.next_window;
            st.next_window += 1;
            st.windows.push((n, id.to_owned(), view.clone()));
            window_label(n)
        };
        self.parts.surface.open_window(id, &label, &title, view).await;
    }

    async fn reconnect(&self, id: &str) {
        // The link reports its own state.
        let _ = self.local("POST", &format!("/api/hosts/{id}/reconnect"), Some(&json!({}))).await;
    }

    /// Whose dashboard a host's page runs: ours when the host speaks our API (one look on
    /// every computer, nothing to download), the host's own bundle when it does not, ours
    /// when it serves none.
    pub(crate) async fn runs_ours(&self, id: &str, view_token: &str) -> bool {
        let info = match self.host(id).and_then(|h| h.get("info").filter(|i| !i.is_null()).cloned()) {
            Some(info) => info,
            // Only before the link has reported the host's info.
            None => {
                match ask(self.parts.core.as_ref(), Plane::Api, "GET", &format!("/h/{id}/api/host"), view_token, None)
                    .await
                {
                    Ok((200, info)) => info,
                    _ => return true,
                }
            }
        };
        if info.get("servesUi") != Some(&Value::Bool(true)) {
            return true;
        }
        let ours = self.state().local_stamp.clone();
        ours.is_some() && text(&info, "apiStamp") == ours.as_deref()
    }

    fn forward_transfer(&self, payload: &Value) {
        let involved = payload.get("transfer").map(|t| {
            let from = text(t, "from").unwrap_or("");
            if from == "local" { text(t, "to").unwrap_or("").to_owned() } else { from.to_owned() }
        });
        let pages = match (&involved, payload.get("removed").and_then(Value::as_array)) {
            (Some(host), _) => self.pages(Some(host)),
            // A cleared id means nothing to a view that never had it.
            (None, Some(_)) => self.pages(None),
            (None, None) => return,
        };
        for page in pages.into_iter().filter(|p| p.trusted()) {
            page.events().emit("transfer:changed", payload.clone());
        }
    }
}

#[cfg(test)]
mod tests;
