//! The daemon's browser verbs, served from the shell's views over the DevTools protocol.
//! A port of the essentials of `app/src/main/browser/{views,driver}.ts`; the real one belongs
//! to the browser feature and replaces this with the daemon.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use eos_core::shell::{BrowserViews, ViewError, ViewEvent, ViewId, ViewListener, ViewSpec};
use serde_json::{Value, json};

use super::axtree;
use crate::panel::{Panel, PanelListener};

const TEXT_CAP: usize = 40_000;
/// Tab events waiting for the channel. They only say "look again", so a full queue drops.
const EVENT_QUEUE: usize = 256;

/// An error as the daemon's wire wants it: a name and a message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriverError {
    pub name: &'static str,
    pub message: String,
}

type R<T> = Result<T, DriverError>;

fn err(message: impl Into<String>) -> DriverError {
    DriverError { name: "Error", message: message.into() }
}

impl From<ViewError> for DriverError {
    fn from(e: ViewError) -> Self {
        err(e.to_string())
    }
}

struct Tab {
    view: ViewId,
    session: String,
    refs: Mutex<HashMap<String, i64>>,
    ref_counter: AtomicU32,
    loading: AtomicBool,
    /// One verb at a time per tab.
    serial: tokio::sync::Mutex<()>,
}

impl Tab {
    fn refs(&self) -> MutexGuard<'_, HashMap<String, i64>> {
        self.refs.lock().unwrap_or_else(|p| p.into_inner())
    }
}

pub struct Driver {
    me: std::sync::Weak<Driver>,
    views: Arc<dyn BrowserViews>,
    panel: Panel,
    rt: tokio::runtime::Handle,
    tabs: Mutex<HashMap<String, Arc<Tab>>>,
    events: tokio::sync::mpsc::Sender<Value>,
}

impl std::fmt::Debug for Driver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Driver").field("tabs", &self.tabs().len()).finish_non_exhaustive()
    }
}

fn profile_for(session: &str) -> String {
    let safe: String =
        session.chars().map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '_' }).collect();
    format!("browser-{safe}")
}

impl Driver {
    /// Returns the driver and the stream of tab events for the daemon.
    pub fn new(
        views: Arc<dyn BrowserViews>,
        panel: Panel,
        rt: tokio::runtime::Handle,
    ) -> (Arc<Self>, tokio::sync::mpsc::Receiver<Value>) {
        let (events, rx) = tokio::sync::mpsc::channel(EVENT_QUEUE);
        let driver = Arc::new_cyclic(|me| Driver {
            me: me.clone(),
            views: views.clone(),
            panel: panel.clone(),
            rt,
            tabs: Mutex::default(),
            events,
        });
        views.listen(driver.clone());
        panel.set_listener(driver.clone());
        (driver, rx)
    }

    fn tabs(&self) -> MutexGuard<'_, HashMap<String, Arc<Tab>>> {
        self.tabs.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn notify(&self, session: &str, event: &str, payload: Value) {
        let _ =
            self.events.try_send(json!({ "type": "event", "sessionKey": session, "event": event, "payload": payload }));
    }

    fn tab(&self, tab_id: &str) -> R<Arc<Tab>> {
        self.tabs().get(tab_id).cloned().ok_or_else(|| err(format!("unknown tab: {tab_id}")))
    }

    fn session_tabs(&self, session: &str) -> Vec<Arc<Tab>> {
        let mut tabs: Vec<Arc<Tab>> = self.tabs().values().filter(|t| t.session == session).cloned().collect();
        tabs.sort_by(|a, b| a.view.cmp(&b.view));
        tabs
    }

    async fn cdp(&self, tab: &Tab, method: &str, params: Value) -> R<Value> {
        Ok(self.views.cdp(&tab.view, method, params).await?)
    }

    async fn eval(&self, tab: &Tab, expression: &str) -> R<Value> {
        let v = self
            .cdp(
                tab,
                "Runtime.evaluate",
                json!({ "expression": expression, "returnByValue": true, "awaitPromise": true }),
            )
            .await?;
        if let Some(ex) = v.get("exceptionDetails") {
            let text = ex
                .pointer("/exception/description")
                .and_then(Value::as_str)
                .or_else(|| ex.get("text").and_then(Value::as_str));
            return Err(err(text.unwrap_or("evaluate failed")));
        }
        Ok(v.pointer("/result/value").cloned().unwrap_or(Value::Null))
    }

    /// Sends a tab where the daemon asked: an address the user typed or an agent was let
    /// to open, never where a page takes itself. Such a navigation may go to the local
    /// network, so the view is told first.
    async fn go(&self, tab: &Tab, url: &str) -> R<()> {
        if let Some(host) = crate::lan_guard::host_of(url) {
            self.views.allow_local_network(&tab.view, &host).await?;
        }
        self.cdp(tab, "Page.navigate", json!({ "url": url })).await?;
        Ok(())
    }

    /// `asked`: the daemon asked for this address (the user, an agent). A popup a page
    /// opened is not asked for: it becomes a tab, but gets no way into the local network.
    async fn open_tab(&self, session: &str, url: &str, asked: bool) -> R<String> {
        let first = Some(url.to_string()).filter(|u| !u.is_empty() && u != "about:blank");
        let view = self.views.create(ViewSpec { profile: profile_for(session), url: None }).await?;
        let tab = Arc::new(Tab {
            view: view.clone(),
            session: session.to_string(),
            refs: Mutex::default(),
            ref_counter: AtomicU32::new(0),
            loading: AtomicBool::new(false),
            serial: tokio::sync::Mutex::new(()),
        });
        self.tabs().insert(view.0.clone(), tab.clone());
        for domain in ["Page.enable", "DOM.enable", "Accessibility.enable", "Runtime.enable"] {
            let _ = self.cdp(&tab, domain, json!({})).await;
        }
        // A view that is not on screen otherwise defers renderer-initiated navigation.
        let _ = self.cdp(&tab, "Emulation.setFocusEmulationEnabled", json!({ "enabled": true })).await;
        if let Some(url) = first {
            if asked {
                self.go(&tab, &url).await?;
            } else {
                self.cdp(&tab, "Page.navigate", json!({ "url": url })).await?;
            }
        }
        Ok(view.0)
    }

    async fn close_tab(&self, tab_id: &str) {
        let Some(tab) = self.tabs().remove(tab_id) else { return };
        self.panel.forget(&tab.view);
        let _ = self.views.close(&tab.view).await;
    }

    /// One port verb of the daemon's browser engine.
    pub async fn handle(&self, method: &str, session: &str, args: &[Value]) -> R<Value> {
        let arg = |i: usize| args.get(i).and_then(Value::as_str).unwrap_or("").to_string();
        match method {
            "launch" => return Ok(Value::Null),
            "openTab" => return Ok(json!(self.open_tab(session, &arg(0), true).await?)),
            "listTabs" => return Ok(self.list_tabs(session).await),
            "dispose" => {
                for tab in self.session_tabs(session) {
                    self.close_tab(tab.view.as_str()).await;
                }
                return Ok(Value::Null);
            }
            "closeTab" => {
                self.close_tab(&arg(0)).await;
                return Ok(Value::Null);
            }
            _ => {}
        }
        let tab = self.tab(&arg(0))?;
        let _serial = tab.serial.lock().await;
        let t = tab.as_ref();
        match method {
            "navigate" => {
                match arg(1).as_str() {
                    "url" => {
                        let url = arg(2);
                        if url.is_empty() {
                            return Err(err("navigate action 'url' requires a url"));
                        }
                        self.go(t, &url).await?;
                    }
                    "reload" => {
                        self.cdp(t, "Page.reload", json!({})).await?;
                    }
                    action => {
                        let history = self.cdp(t, "Page.getNavigationHistory", json!({})).await?;
                        let current = history.get("currentIndex").and_then(Value::as_i64).unwrap_or(0);
                        let target = current + if action == "back" { -1 } else { 1 };
                        let entry = usize::try_from(target)
                            .ok()
                            .and_then(|i| history.get("entries")?.as_array()?.get(i).cloned());
                        if let Some(entry) = entry {
                            self.cdp(t, "Page.navigateToHistoryEntry", json!({ "entryId": entry.get("id") })).await?;
                        }
                    }
                }
                Ok(Value::Null)
            }
            "snapshot" => {
                let opts = args.get(1).cloned().unwrap_or(Value::Null);
                let root = match opts.get("selector").and_then(Value::as_str) {
                    Some(selector) => Some(self.backend_node_for_selector(t, selector).await?),
                    None => None,
                };
                let tree = self.cdp(t, "Accessibility.getFullAXTree", json!({})).await?;
                let nodes = tree.get("nodes").and_then(Value::as_array).cloned().unwrap_or_default();
                let formatted = axtree::format(
                    &nodes,
                    opts.get("interactiveOnly").and_then(Value::as_bool).unwrap_or(true),
                    opts.get("depth").and_then(Value::as_u64).map(|d| d as u32),
                    root,
                    t.ref_counter.load(Ordering::SeqCst),
                );
                t.ref_counter.store(formatted.next_ref, Ordering::SeqCst);
                {
                    let mut refs = t.refs();
                    refs.clear();
                    refs.extend(formatted.refs);
                }
                Ok(json!({ "url": self.page_url(t).await, "snapshot": formatted.text }))
            }
            "find" => {
                let query = arg(1).to_lowercase();
                let tree = self.cdp(t, "Accessibility.getFullAXTree", json!({})).await?;
                let mut out = Vec::new();
                for node in tree.get("nodes").and_then(Value::as_array).into_iter().flatten() {
                    if out.len() >= 10 {
                        break;
                    }
                    let Some(backend) = node.get("backendDOMNodeId").and_then(Value::as_i64) else { continue };
                    if node.get("ignored").and_then(Value::as_bool).unwrap_or(false) {
                        continue;
                    }
                    if matches!(axtree::role_of(node).as_str(), "statictext" | "inlinetextbox" | "rootwebarea") {
                        continue;
                    }
                    let name = node.pointer("/name/value").and_then(Value::as_str).unwrap_or("");
                    if name.is_empty() || !name.to_lowercase().contains(&query) {
                        continue;
                    }
                    if let Ok(element) = self.build_element(t, backend, node).await {
                        out.push(element);
                    }
                }
                Ok(Value::Array(out))
            }
            "act" => {
                let backend = self.resolve_ref(t, &arg(1))?;
                match args.get(2).and_then(Value::as_str).unwrap_or("click") {
                    "focus" => {
                        self.cdp(t, "DOM.focus", json!({ "backendNodeId": backend })).await?;
                    }
                    "hover" => {
                        let at = self.center_of(t, backend).await?;
                        self.mouse(t, "mouseMoved", at, None).await?;
                    }
                    verb @ ("check" | "uncheck") => {
                        let checked = self.call_on_node(t, backend, "function(){ return !!this.checked }").await?;
                        if checked.as_bool() != Some(verb == "check") {
                            self.trusted_click(t, backend).await?;
                        }
                    }
                    _ => self.trusted_click(t, backend).await?,
                }
                Ok(Value::Null)
            }
            "typeText" => {
                let backend = self.resolve_ref(t, &arg(1))?;
                self.cdp(t, "DOM.focus", json!({ "backendNodeId": backend })).await?;
                self.call_on_node(
                    t,
                    backend,
                    "function(){ if (this.select) this.select(); else if (this.isContentEditable) { const r = document.createRange(); r.selectNodeContents(this); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } }",
                )
                .await?;
                self.cdp(t, "Input.insertText", json!({ "text": arg(2) })).await?;
                if args.get(3).and_then(Value::as_bool).unwrap_or(false) {
                    self.press(t, "Enter").await?;
                }
                Ok(Value::Null)
            }
            "press" => {
                self.press(t, &arg(1)).await?;
                Ok(Value::Null)
            }
            "scroll" => {
                let expression = match arg(1).as_str() {
                    "top" => "window.scrollTo(0, 0)".to_string(),
                    "bottom" => "window.scrollTo(0, document.body.scrollHeight)".to_string(),
                    direction => format!(
                        "window.scrollBy(0, ({}) * window.innerHeight)",
                        if direction == "up" { -0.8 } else { 0.8 }
                    ),
                };
                self.eval(t, &expression).await?;
                Ok(Value::Null)
            }
            "get" => {
                let reference = args.get(2).and_then(Value::as_str);
                Ok(match (arg(1).as_str(), reference) {
                    ("url", _) => json!(self.page_url(t).await),
                    ("title", _) => self.eval(t, "document.title").await?,
                    ("text", None) => {
                        self.eval(t, &format!("document.body ? document.body.innerText.slice(0, {TEXT_CAP}) : ''"))
                            .await?
                    }
                    ("text", Some(r)) => {
                        let backend = self.resolve_ref(t, r)?;
                        self.call_on_node(t, backend, &format!("function(){{ return String(this.innerText ?? this.textContent ?? '').slice(0, {TEXT_CAP}) }}")).await?
                    }
                    (_, Some(r)) => {
                        let backend = self.resolve_ref(t, r)?;
                        self.call_on_node(t, backend, "function(){ if (this.type === 'password') return '[redacted]'; return String(this.value ?? '') }").await?
                    }
                    _ => return Err(err("get 'value' requires a ref")),
                })
            }
            "capture" => {
                let shot = self.cdp(t, "Page.captureScreenshot", json!({ "format": "jpeg", "quality": 80 })).await?;
                Ok(shot.get("data").cloned().unwrap_or(Value::Null))
            }
            "textPresent" => {
                let needle = Value::String(arg(1).to_lowercase()).to_string();
                let found = self
                    .eval(t, &format!("!!document.body && document.body.innerText.toLowerCase().includes({needle})"))
                    .await?;
                Ok(json!(found == Value::Bool(true)))
            }
            "refVisible" => {
                let backend = self.resolve_ref(t, &arg(1))?;
                Ok(json!(self.box_of(t, backend).await.is_ok()))
            }
            "setMuted" => {
                self.views.set_muted(&t.view, args.get(1).and_then(Value::as_bool).unwrap_or(false)).await?;
                Ok(Value::Null)
            }
            "setDevice" | "elementAt" => Err(err(format!("{method}: comes with the browser feature"))),
            other => Err(err(format!("unknown browser method: {other}"))),
        }
    }

    async fn page_url(&self, t: &Tab) -> String {
        self.eval(t, "location.href").await.ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
    }

    async fn list_tabs(&self, session: &str) -> Value {
        let mut out = Vec::new();
        for t in self.session_tabs(session) {
            let info = self.eval(&t, "({u: location.href, t: document.title})").await.unwrap_or(Value::Null);
            let history = self.cdp(&t, "Page.getNavigationHistory", json!({})).await.unwrap_or(Value::Null);
            let current = history.get("currentIndex").and_then(Value::as_u64).unwrap_or(0) as usize;
            let entries = history.get("entries").and_then(Value::as_array).cloned().unwrap_or_default();
            // Every view starts on a blank document: entries before the first real page
            // are not somewhere to go back to.
            let real = |e: &Value| e.get("url").and_then(Value::as_str).is_some_and(|u| u.starts_with("http"));
            out.push(json!({
                "tabId": t.view.as_str(),
                "url": info.get("u").and_then(Value::as_str).unwrap_or(""),
                "title": info.get("t").and_then(Value::as_str).unwrap_or(""),
                "loading": t.loading.load(Ordering::SeqCst),
                "canGoBack": entries.iter().take(current).any(real),
                "canGoForward": current + 1 < entries.len(),
                "audible": false,
                "muted": false,
                "faviconDataUri": null,
            }));
        }
        Value::Array(out)
    }

    fn resolve_ref(&self, t: &Tab, reference: &str) -> R<i64> {
        t.refs().get(reference).copied().ok_or_else(|| DriverError {
            name: "StaleRefError",
            message: format!("unknown or stale ref {reference:?} — the page has changed since it was minted; call snapshot (or find) again for fresh refs"),
        })
    }

    async fn backend_node_for_selector(&self, t: &Tab, selector: &str) -> R<i64> {
        let doc = self.cdp(t, "DOM.getDocument", json!({ "depth": 0 })).await?;
        let found = self
            .cdp(t, "DOM.querySelector", json!({ "nodeId": doc.pointer("/root/nodeId"), "selector": selector }))
            .await?;
        let node_id = found.get("nodeId").and_then(Value::as_i64).unwrap_or(0);
        if node_id == 0 {
            return Err(err(format!("selector matched nothing: {selector}")));
        }
        let described = self.cdp(t, "DOM.describeNode", json!({ "nodeId": node_id })).await?;
        described.pointer("/node/backendNodeId").and_then(Value::as_i64).ok_or_else(|| err("no backendNodeId"))
    }

    async fn box_of(&self, t: &Tab, backend: i64) -> R<[i64; 4]> {
        let model = self.cdp(t, "DOM.getBoxModel", json!({ "backendNodeId": backend })).await?;
        let q: Vec<f64> = model
            .pointer("/model/border")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_f64)
            .collect();
        if q.len() < 8 {
            return Err(err("no box model"));
        }
        let (xs, ys) = ([q[0], q[2], q[4], q[6]], [q[1], q[3], q[5], q[7]]);
        let min = |v: [f64; 4]| v.iter().copied().fold(f64::INFINITY, f64::min);
        let max = |v: [f64; 4]| v.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        Ok([
            min(xs).round() as i64,
            min(ys).round() as i64,
            (max(xs) - min(xs)).round() as i64,
            (max(ys) - min(ys)).round() as i64,
        ])
    }

    async fn center_of(&self, t: &Tab, backend: i64) -> R<(i64, i64)> {
        let _ = self.cdp(t, "DOM.scrollIntoViewIfNeeded", json!({ "backendNodeId": backend })).await;
        let [x, y, w, h] = self.box_of(t, backend).await?;
        Ok((x + w / 2, y + h / 2))
    }

    /// One mouse event at a point: `pressed` is whether the left button is down after it.
    async fn mouse(&self, t: &Tab, kind: &str, (x, y): (i64, i64), pressed: Option<bool>) -> R<()> {
        let (button, buttons, clicks) = match pressed {
            None => ("none", 0, 0),
            Some(true) => ("left", 1, 1),
            Some(false) => ("left", 0, 1),
        };
        self.cdp(
            t,
            "Input.dispatchMouseEvent",
            json!({ "type": kind, "x": x, "y": y, "button": button, "buttons": buttons, "clickCount": clicks, "deltaX": 0, "deltaY": 0 }),
        )
        .await?;
        Ok(())
    }

    async fn trusted_click(&self, t: &Tab, backend: i64) -> R<()> {
        let at = self.center_of(t, backend).await?;
        self.mouse(t, "mouseMoved", at, None).await?;
        self.mouse(t, "mousePressed", at, Some(true)).await?;
        self.mouse(t, "mouseReleased", at, Some(false)).await
    }

    async fn press(&self, t: &Tab, chord: &str) -> R<()> {
        let (key, code, key_code, text) = match chord.to_lowercase().as_str() {
            "enter" => ("Enter", "Enter", 13, "\r"),
            "tab" => ("Tab", "Tab", 9, ""),
            "escape" => ("Escape", "Escape", 27, ""),
            "backspace" => ("Backspace", "Backspace", 8, ""),
            "space" => (" ", "Space", 32, " "),
            other => return Err(err(format!("key {other:?}: comes with the browser feature"))),
        };
        let base = json!({ "key": key, "code": code, "modifiers": 0, "windowsVirtualKeyCode": key_code, "nativeVirtualKeyCode": key_code });
        let mut down = base.clone();
        down["type"] = json!(if text.is_empty() { "rawKeyDown" } else { "keyDown" });
        down["text"] = json!(text);
        down["unmodifiedText"] = json!(text);
        self.cdp(t, "Input.dispatchKeyEvent", down).await?;
        let mut up = base;
        up["type"] = json!("keyUp");
        self.cdp(t, "Input.dispatchKeyEvent", up).await?;
        Ok(())
    }

    async fn call_on_node(&self, t: &Tab, backend: i64, function: &str) -> R<Value> {
        let resolved = self.cdp(t, "DOM.resolveNode", json!({ "backendNodeId": backend })).await?;
        let r = self
            .cdp(t, "Runtime.callFunctionOn", json!({ "objectId": resolved.pointer("/object/objectId"), "functionDeclaration": function, "returnByValue": true }))
            .await?;
        if let Some(ex) = r.get("exceptionDetails") {
            return Err(err(ex.get("text").and_then(Value::as_str).unwrap_or("node call failed")));
        }
        Ok(r.pointer("/result/value").cloned().unwrap_or(Value::Null))
    }

    async fn build_element(&self, t: &Tab, backend: i64, ax: &Value) -> R<Value> {
        let described = self.cdp(t, "DOM.describeNode", json!({ "backendNodeId": backend })).await?;
        let tag = described.pointer("/node/nodeName").and_then(Value::as_str).unwrap_or("").to_lowercase();
        let bounds = self.box_of(t, backend).await?;
        let role = Some(axtree::role_of(ax)).filter(|r| !r.is_empty()).unwrap_or_else(|| tag.clone());
        let name: String = ax
            .pointer("/name/value")
            .and_then(Value::as_str)
            .unwrap_or("")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(100)
            .collect();
        let n = t.ref_counter.fetch_add(1, Ordering::SeqCst) + 1;
        let reference = format!("@e{n}");
        t.refs().insert(reference.clone(), backend);
        let locator =
            if name.is_empty() { tag.clone() } else { format!("role={role}[name={}]", Value::String(name.clone())) };
        Ok(
            json!({ "ref": reference, "tag": tag, "role": role, "name": name, "box": bounds, "focusable": axtree::is_focusable(ax), "locator": locator }),
        )
    }
}

impl ViewListener for Driver {
    fn on_view_event(&self, view: &ViewId, event: &ViewEvent) {
        let Some(tab) = self.tabs().get(view.as_str()).cloned() else { return };
        match event {
            ViewEvent::Cdp { method, params } => match method.as_str() {
                // A main-frame navigation recycles node ids: every ref minted before it is stale.
                "Page.frameNavigated" if params.pointer("/frame/parentId").is_none() => {
                    tab.refs().clear();
                    self.notify(&tab.session, "tabsChanged", Value::Null);
                }
                "Page.frameStartedLoading"
                | "Page.frameStoppedLoading"
                | "Page.loadEventFired"
                | "Page.navigatedWithinDocument" => {
                    tab.loading.store(method == "Page.frameStartedLoading", Ordering::SeqCst);
                    self.notify(&tab.session, "tabsChanged", Value::Null);
                }
                _ => {}
            },
            // A popup becomes a tab of the same session.
            ViewEvent::OpenRequested { url } if url.starts_with("http://") || url.starts_with("https://") => {
                let (Some(me), session, url) = (self.me.upgrade(), tab.session.clone(), url.clone()) else { return };
                self.rt.spawn(async move {
                    if me.open_tab(&session, &url, false).await.is_ok() {
                        me.notify(&session, "tabsChanged", Value::Null);
                    }
                });
            }
            ViewEvent::OpenRequested { .. } => {}
            ViewEvent::Closed => {
                self.tabs().remove(view.as_str());
                self.panel.forget(view);
                self.notify(&tab.session, "tabCrashed", json!({ "tabId": view.as_str() }));
            }
        }
    }
}

impl PanelListener for Driver {
    fn active_view_changed(&self, session: &str, view: &ViewId) {
        self.notify(session, "activeTabChanged", json!({ "tabId": view.as_str() }));
    }
}

#[cfg(test)]
mod tests {
    use eos_core::BoxFuture;
    use eos_core::shell::Rect;

    use super::*;

    /// Views whose DevTools answers are scripted per method.
    #[derive(Default)]
    struct FakeViews {
        calls: Mutex<Vec<String>>,
        created: Mutex<Vec<ViewSpec>>,
        listeners: Mutex<Vec<Arc<dyn ViewListener>>>,
    }

    impl BrowserViews for FakeViews {
        fn create(&self, spec: ViewSpec) -> BoxFuture<'_, Result<ViewId, ViewError>> {
            let mut created = self.created.lock().unwrap();
            created.push(spec);
            let id = ViewId(format!("view-{}", created.len()));
            Box::pin(async move { Ok(id) })
        }
        fn close(&self, v: &ViewId) -> BoxFuture<'_, Result<(), ViewError>> {
            self.calls.lock().unwrap().push(format!("close {v}"));
            Box::pin(async { Ok(()) })
        }
        fn place(&self, _v: &ViewId, _r: Rect) -> BoxFuture<'_, Result<(), ViewError>> {
            Box::pin(async { Ok(()) })
        }
        fn park(&self, _v: &ViewId) -> BoxFuture<'_, Result<(), ViewError>> {
            Box::pin(async { Ok(()) })
        }
        fn set_muted(&self, v: &ViewId, muted: bool) -> BoxFuture<'_, Result<(), ViewError>> {
            self.calls.lock().unwrap().push(format!("mute {v} {muted}"));
            Box::pin(async { Ok(()) })
        }
        fn allow_local_network(&self, v: &ViewId, host: &str) -> BoxFuture<'_, Result<(), ViewError>> {
            self.calls.lock().unwrap().push(format!("allow {v} {host}"));
            Box::pin(async { Ok(()) })
        }
        fn cdp(&self, v: &ViewId, method: &str, params: Value) -> BoxFuture<'_, Result<Value, ViewError>> {
            self.calls.lock().unwrap().push(format!("{v} {method}"));
            let answer = match method {
                "Runtime.evaluate" => {
                    let expression = params["expression"].as_str().unwrap_or("");
                    if expression == "location.href" {
                        json!({ "result": { "value": "https://example.com/" } })
                    } else if expression.starts_with("({u:") {
                        json!({ "result": { "value": { "u": "https://example.com/", "t": "Example" } } })
                    } else {
                        json!({ "result": { "value": true } })
                    }
                }
                "Accessibility.getFullAXTree" => json!({ "nodes": [
                    { "nodeId": "1", "role": { "value": "RootWebArea" }, "childIds": ["2", "3"] },
                    { "nodeId": "2", "role": { "value": "button" }, "name": { "value": "Go" }, "backendDOMNodeId": 42, "childIds": [] },
                    { "nodeId": "3", "role": { "value": "textbox" }, "name": { "value": "Query" }, "backendDOMNodeId": 43, "childIds": [] },
                ] }),
                "DOM.getBoxModel" => json!({ "model": { "border": [10, 20, 110, 20, 110, 60, 10, 60] } }),
                "Page.getNavigationHistory" => {
                    json!({ "currentIndex": 1, "entries": [{ "id": 1, "url": "about:blank" }, { "id": 2, "url": "https://example.com/" }] })
                }
                "Page.captureScreenshot" => json!({ "data": "anBlZw==" }),
                _ => json!({}),
            };
            Box::pin(async move { Ok(answer) })
        }
        fn listen(&self, listener: Arc<dyn ViewListener>) {
            self.listeners.lock().unwrap().push(listener);
        }
    }

    fn setup() -> (Arc<FakeViews>, Arc<Driver>, tokio::sync::mpsc::Receiver<Value>) {
        let views = Arc::new(FakeViews::default());
        let rt = tokio::runtime::Handle::current();
        let panel = Panel::new(views.clone(), &rt);
        let (driver, events) = Driver::new(views.clone(), panel, rt);
        (views, driver, events)
    }

    #[tokio::test]
    async fn a_tab_is_a_view_with_the_sessions_profile() {
        let (views, driver, _events) = setup();
        let tab = driver.handle("openTab", "w-1/α", &[json!("https://example.com/")]).await.unwrap();
        assert_eq!(tab, json!("view-1"));
        assert_eq!(views.created.lock().unwrap()[0], ViewSpec { profile: "browser-w-1__".into(), url: None });
        let calls = views.calls.lock().unwrap().clone();
        assert!(calls.contains(&"view-1 Emulation.setFocusEmulationEnabled".to_string()));
        // An address that was asked for: the view is told before it navigates.
        assert_eq!(
            calls[calls.len() - 2..],
            ["allow view-1 example.com".to_string(), "view-1 Page.navigate".to_string()]
        );

        let tabs = driver.handle("listTabs", "w-1/α", &[]).await.unwrap();
        assert_eq!(tabs[0]["tabId"], "view-1");
        assert_eq!(tabs[0]["title"], "Example");
        assert_eq!(tabs[0]["canGoBack"], false, "the blank first document is not a place to go back to");
        assert_eq!(driver.handle("listTabs", "other", &[]).await.unwrap(), json!([]));
    }

    #[tokio::test]
    async fn a_popup_becomes_a_tab_without_a_way_into_the_local_network() {
        let (views, driver, mut events) = setup();
        driver.handle("openTab", "s", &[json!("")]).await.unwrap();
        driver.on_view_event(
            &ViewId("view-1".into()),
            &ViewEvent::OpenRequested { url: "http://192.168.1.5/admin".into() },
        );
        assert_eq!(events.recv().await.unwrap()["event"], "tabsChanged");
        let calls = views.calls.lock().unwrap().clone();
        assert!(calls.contains(&"view-2 Page.navigate".to_string()), "{calls:?}");
        assert!(
            !calls.iter().any(|c| c.starts_with("allow")),
            "a page's own popup is not something the user asked for: {calls:?}"
        );
        // The same address typed by the user is.
        driver
            .handle("navigate", "s", &[json!("view-1"), json!("url"), json!("http://192.168.1.5/admin")])
            .await
            .unwrap();
        assert!(views.calls.lock().unwrap().contains(&"allow view-1 192.168.1.5".to_string()));
    }

    #[tokio::test]
    async fn snapshot_mints_refs_and_a_click_is_trusted_input() {
        let (views, driver, _events) = setup();
        driver.handle("openTab", "s", &[json!("")]).await.unwrap();
        let snap =
            driver.handle("snapshot", "s", &[json!("view-1"), json!({ "interactiveOnly": true })]).await.unwrap();
        assert_eq!(snap["snapshot"], "button \"Go\" @e1\ntextbox \"Query\" @e2");
        assert_eq!(snap["url"], "https://example.com/");

        views.calls.lock().unwrap().clear();
        driver.handle("act", "s", &[json!("view-1"), json!("@e1"), json!("click")]).await.unwrap();
        let calls = views.calls.lock().unwrap().clone();
        assert_eq!(calls.iter().filter(|c| c.ends_with("Input.dispatchMouseEvent")).count(), 3, "{calls:?}");

        let stale = driver.handle("act", "s", &[json!("view-1"), json!("@e9"), json!("click")]).await.unwrap_err();
        assert_eq!(stale.name, "StaleRefError");
        let shot = driver.handle("capture", "s", &[json!("view-1")]).await.unwrap();
        assert_eq!(shot, json!("anBlZw=="));
        assert!(
            driver
                .handle("navigate", "s", &[json!("nope"), json!("reload")])
                .await
                .unwrap_err()
                .message
                .contains("unknown tab")
        );
    }

    #[tokio::test]
    async fn a_navigation_drops_the_refs_and_tells_the_daemon() {
        let (_views, driver, mut events) = setup();
        driver.handle("openTab", "s", &[json!("")]).await.unwrap();
        driver.handle("snapshot", "s", &[json!("view-1")]).await.unwrap();
        let view = ViewId("view-1".into());
        driver.on_view_event(
            &view,
            &ViewEvent::Cdp { method: "Page.frameNavigated".into(), params: json!({ "frame": { "id": "F" } }) },
        );
        assert_eq!(
            events.recv().await.unwrap(),
            json!({ "type": "event", "sessionKey": "s", "event": "tabsChanged", "payload": null })
        );
        assert_eq!(
            driver.handle("act", "s", &[json!("view-1"), json!("@e1")]).await.unwrap_err().name,
            "StaleRefError"
        );
        // A subframe navigating changes nothing.
        driver.on_view_event(
            &view,
            &ViewEvent::Cdp { method: "Page.frameNavigated".into(), params: json!({ "frame": { "parentId": "F" } }) },
        );
        assert!(events.try_recv().is_err());
    }

    #[tokio::test]
    async fn closing_and_disposing_close_the_views() {
        let (views, driver, mut events) = setup();
        for _ in 0..3 {
            driver.handle("openTab", "s", &[json!("")]).await.unwrap();
        }
        driver.handle("closeTab", "s", &[json!("view-2")]).await.unwrap();
        driver.handle("dispose", "s", &[]).await.unwrap();
        let closes: Vec<String> =
            views.calls.lock().unwrap().iter().filter(|c| c.starts_with("close")).cloned().collect();
        assert_eq!(closes, vec!["close view-2", "close view-1", "close view-3"]);
        // A view that died on its own is reported.
        driver.handle("openTab", "s", &[json!("")]).await.unwrap();
        driver.on_view_event(&ViewId("view-4".into()), &ViewEvent::Closed);
        assert_eq!(events.recv().await.unwrap()["event"], "tabCrashed");
        assert_eq!(driver.handle("listTabs", "s", &[]).await.unwrap(), json!([]));
    }

    #[tokio::test]
    async fn the_panel_reports_the_active_tab() {
        let (_views, driver, mut events) = setup();
        driver.handle("openTab", "s", &[json!("")]).await.unwrap();
        driver.panel.set_active(1, "s", ViewId("view-1".into()));
        assert_eq!(
            events.recv().await.unwrap(),
            json!({ "type": "event", "sessionKey": "s", "event": "activeTabChanged", "payload": { "tabId": "view-1" } })
        );
    }
}
