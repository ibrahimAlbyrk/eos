//! Tabs and the verbs on them, over the shell's views and their DevTools channel
//! (`app/src/main/browser/{driver,views}.ts`). One view per tab; a tab's id is its view's.
//!
//! `@eN` refs are minted per tab by snapshot, find and the element picker, backed by DOM
//! node ids, and dropped on every main-frame navigation: a ref from before it raises
//! [`DriverError::StaleRef`] instead of acting on a recycled node. A tab's ref counter never
//! goes back, so a ref string is never reused in the tab's life.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use base64::Engine;
use eos_contracts::{
    BrowserActRequestVerb as ActVerb, BrowserDevice, BrowserElement, BrowserGetRequestWhat as GetWhat,
    BrowserNavigateRequestAction as NavigateAction, BrowserScrollRequestDirection as ScrollDirection,
};
use eos_core::Sleeper;
use eos_core::shell::{BrowserPanel, BrowserViews, ViewError, ViewEvent, ViewId, ViewListener, ViewSpec};
use eos_domain::text::{collapse_spaces, js_trim, utf16_prefix};
use serde_json::{Value, json};

use crate::axtree::{self, FormatOptions, quoted, role_of, states_of, text_of};
use crate::keys::parse_chord;
use crate::policy::host_of;

const TEXT_CAP: usize = 40_000;
const FIND_MATCH_CAP: usize = 10;
/// A clip taller than about 8192 device pixels wedges Chromium.
const MAX_CAPTURE_PX: f64 = 2048.0;
const MAX_FULLPAGE_PX: f64 = 8192.0;
/// How long the two steps of a full-page capture may take before a plain one is taken.
const FULLPAGE_METRICS_MS: i64 = 4000;
const FULLPAGE_SHOT_MS: i64 = 6000;

const SELECT_CONTENTS: &str = "function(){
      if (this.select) this.select();
      else if (this.isContentEditable) {
        const r = document.createRange(); r.selectNodeContents(this);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      }
    }";

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DriverError {
    /// 404.
    #[error("unknown tab: {0}")]
    UnknownTab(String),
    /// 409: the caller must look at the page again.
    #[error(
        "unknown or stale ref {} — the page has changed since it was minted; call snapshot (or find) again for fresh refs",
        quoted(.0)
    )]
    StaleRef(String),
    /// 500, with the message as the answer's error.
    #[error("{0}")]
    Failed(String),
}

type R<T> = Result<T, DriverError>;

fn failed(message: impl Into<String>) -> DriverError {
    DriverError::Failed(message.into())
}

impl From<ViewError> for DriverError {
    fn from(error: ViewError) -> Self {
        failed(error.to_string())
    }
}

/// `Math.round`: halves go up, also below zero.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

struct DeviceProfile {
    width: u32,
    height: u32,
    scale: u32,
    user_agent: &'static str,
    platform: &'static str,
}

fn device_profile(device: BrowserDevice) -> Option<DeviceProfile> {
    match device {
        BrowserDevice::Responsive => None,
        BrowserDevice::Mobile => Some(DeviceProfile {
            width: 375,
            height: 812,
            scale: 3,
            user_agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
            platform: "iPhone",
        }),
        BrowserDevice::Tablet => Some(DeviceProfile {
            width: 768,
            height: 1024,
            scale: 2,
            user_agent: "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
            platform: "iPad",
        }),
    }
}

/// What the tab list shows of one tab, before its session is added.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TabInfo {
    pub(crate) tab_id: String,
    pub(crate) url: String,
    pub(crate) title: String,
    pub(crate) loading: bool,
    pub(crate) can_go_back: bool,
    pub(crate) can_go_forward: bool,
    pub(crate) audible: bool,
    pub(crate) muted: bool,
}

pub(crate) struct Tab {
    view: ViewId,
    pub(crate) session: String,
    /// Creation order: the order of the tab strip.
    order: u64,
    refs: Mutex<HashMap<String, i64>>,
    ref_counter: AtomicU32,
    loading: AtomicBool,
    muted: AtomicBool,
    /// The main frame, once a navigation named it.
    main_frame: Mutex<Option<String>>,
    /// One verb at a time: an agent's click must not land midway through another's.
    serial: tokio::sync::Mutex<()>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What the driver tells its owner. Called on a shell thread: return quickly.
pub(crate) trait DriverEvents: Send + Sync {
    /// Something the tab list shows may have changed.
    fn tabs_changed(&self, session: &str);
    /// A page asked for a new window: it became this tab of the same session.
    fn popup(&self, session: &str, url: String);
    /// The view is gone (its renderer died).
    fn tab_gone(&self, session: &str, tab_id: &str);
}

struct Pick {
    tab_id: String,
    chosen: tokio::sync::oneshot::Sender<Option<i64>>,
}

/// A history entry of `Page.getNavigationHistory`.
struct History {
    current: usize,
    entries: Vec<Value>,
}

impl History {
    fn entry(&self, index: usize) -> Option<&Value> {
        self.entries.get(index)
    }

    fn url_of(entry: &Value) -> &str {
        entry.get("url").and_then(Value::as_str).unwrap_or("")
    }

    /// Every view starts on a blank document, which is not a place to go back to.
    fn is_start(&self, index: usize) -> bool {
        index == 0 && self.entry(0).is_some_and(|e| Self::url_of(e) == "about:blank")
    }

    /// The entry `back` or `forward` leads to.
    fn target(&self, back: bool) -> Option<&Value> {
        let index = if back { self.current.checked_sub(1)? } else { self.current + 1 };
        if back && self.is_start(index) {
            return None;
        }
        self.entry(index)
    }
}

pub(crate) struct Driver {
    views: Arc<dyn BrowserViews>,
    panel: Option<Arc<dyn BrowserPanel>>,
    sleeper: Arc<dyn Sleeper>,
    tabs: Mutex<HashMap<String, Arc<Tab>>>,
    next_order: AtomicU64,
    pick: Mutex<Option<Pick>>,
    events: Mutex<Option<Weak<dyn DriverEvents>>>,
}

impl Driver {
    pub(crate) fn new(
        views: Arc<dyn BrowserViews>,
        panel: Option<Arc<dyn BrowserPanel>>,
        sleeper: Arc<dyn Sleeper>,
    ) -> Arc<Self> {
        let driver = Arc::new(Driver {
            views: views.clone(),
            panel,
            sleeper,
            tabs: Mutex::default(),
            next_order: AtomicU64::new(0),
            pick: Mutex::new(None),
            events: Mutex::new(None),
        });
        views.listen(driver.clone());
        driver
    }

    pub(crate) fn set_events(&self, events: Weak<dyn DriverEvents>) {
        *lock(&self.events) = Some(events);
    }

    fn events(&self) -> Option<Arc<dyn DriverEvents>> {
        lock(&self.events).as_ref().and_then(Weak::upgrade)
    }

    fn tab(&self, tab_id: &str) -> R<Arc<Tab>> {
        lock(&self.tabs).get(tab_id).cloned().ok_or_else(|| DriverError::UnknownTab(tab_id.to_owned()))
    }

    /// The session a live tab belongs to.
    pub(crate) fn session_of(&self, tab_id: &str) -> Option<String> {
        lock(&self.tabs).get(tab_id).map(|tab| tab.session.clone())
    }

    fn session_tabs(&self, session: &str) -> Vec<Arc<Tab>> {
        let mut tabs: Vec<Arc<Tab>> = lock(&self.tabs).values().filter(|t| t.session == session).cloned().collect();
        tabs.sort_by_key(|tab| tab.order);
        tabs
    }

    // ---- the DevTools channel ---------------------------------------------------------

    async fn cdp(&self, tab: &Tab, method: &str, params: Value) -> R<Value> {
        Ok(self.views.cdp(&tab.view, method, params).await?)
    }

    /// A call whose failure changes nothing.
    async fn cdp_quietly(&self, tab: &Tab, method: &str, params: Value) {
        let _ = self.views.cdp(&tab.view, method, params).await;
    }

    fn thrown(answer: &Value, fallback: &str) -> Option<DriverError> {
        let details = answer.get("exceptionDetails")?;
        Some(failed(details.get("text").and_then(Value::as_str).unwrap_or(fallback)))
    }

    async fn evaluate(&self, tab: &Tab, expression: &str) -> R<Value> {
        let answer =
            self.cdp(tab, "Runtime.evaluate", json!({ "expression": expression, "returnByValue": true })).await?;
        match Self::thrown(&answer, "evaluate failed") {
            Some(error) => Err(error),
            None => Ok(answer.pointer("/result/value").cloned().unwrap_or(Value::Null)),
        }
    }

    async fn call_on_node(&self, tab: &Tab, backend: i64, function: &str) -> R<Value> {
        let resolved = self.cdp(tab, "DOM.resolveNode", json!({ "backendNodeId": backend })).await?;
        let answer = self
            .cdp(
                tab,
                "Runtime.callFunctionOn",
                json!({ "objectId": resolved.pointer("/object/objectId"), "functionDeclaration": function, "returnByValue": true }),
            )
            .await?;
        match Self::thrown(&answer, "node call failed") {
            Some(error) => Err(error),
            None => Ok(answer.pointer("/result/value").cloned().unwrap_or(Value::Null)),
        }
    }

    async fn history(&self, tab: &Tab) -> R<History> {
        let answer = self.cdp(tab, "Page.getNavigationHistory", json!({})).await?;
        Ok(History {
            current: answer.get("currentIndex").and_then(Value::as_u64).unwrap_or(0) as usize,
            entries: answer.get("entries").and_then(Value::as_array).cloned().unwrap_or_default(),
        })
    }

    /// The address and title of the page the tab shows; empty when the view cannot say.
    async fn page(&self, tab: &Tab) -> (String, String) {
        let Ok(history) = self.history(tab).await else { return (String::new(), String::new()) };
        let entry = history.entry(history.current);
        let text = |key: &str| entry.and_then(|e| e.get(key)).and_then(Value::as_str).unwrap_or("").to_owned();
        (text("url"), text("title"))
    }

    // ---- tabs --------------------------------------------------------------------------

    /// Sends a tab where a person or an agent asked. Such a navigation may go to the local
    /// network (a dev server), so the view is told first; where a page takes itself never
    /// comes through here.
    async fn go(&self, tab: &Tab, url: &str) -> R<()> {
        if let Some(host) = host_of(url) {
            self.views.allow_local_network(&tab.view, &host).await?;
        }
        self.cdp(tab, "Page.navigate", json!({ "url": url })).await?;
        Ok(())
    }

    /// Opens a tab of `session` on the storage named `profile`. `asked`: a person or an
    /// agent chose `url`; a page's own popup did not, and gets no way into the local network.
    pub(crate) async fn open_tab(&self, session: &str, profile: &str, url: &str, asked: bool) -> R<String> {
        let view = self.views.create(ViewSpec { profile: profile.to_owned(), url: None }).await?;
        let tab = Arc::new(Tab {
            view: view.clone(),
            session: session.to_owned(),
            order: self.next_order.fetch_add(1, Ordering::SeqCst),
            refs: Mutex::default(),
            ref_counter: AtomicU32::new(0),
            loading: AtomicBool::new(false),
            muted: AtomicBool::new(false),
            main_frame: Mutex::new(None),
            serial: tokio::sync::Mutex::new(()),
        });
        lock(&self.tabs).insert(view.0.clone(), tab.clone());
        for domain in ["Page.enable", "DOM.enable", "Accessibility.enable", "Runtime.enable"] {
            self.cdp_quietly(&tab, domain, json!({})).await;
        }
        // A view that is not on screen otherwise holds back what its page starts itself
        // (a link click, a form submit): an agent's click in a tab nobody watches would stall.
        self.cdp_quietly(&tab, "Emulation.setFocusEmulationEnabled", json!({ "enabled": true })).await;
        if !url.is_empty() && url != "about:blank" {
            let sent = if asked {
                self.go(&tab, url).await
            } else {
                self.cdp(&tab, "Page.navigate", json!({ "url": url })).await.map(drop)
            };
            if let Err(error) = sent {
                // A tab that never got its page is not left behind.
                self.close_tab(&view.0).await;
                return Err(error);
            }
        }
        Ok(view.0)
    }

    pub(crate) async fn close_tab(&self, tab_id: &str) {
        let Some(tab) = lock(&self.tabs).get(tab_id).cloned() else { return };
        let _serial = tab.serial.lock().await;
        if lock(&self.tabs).remove(tab_id).is_none() {
            return;
        }
        self.cancel_pick_of(Some(tab_id));
        if let Some(panel) = &self.panel {
            panel.forget(&tab.view);
        }
        let _ = self.views.close(&tab.view).await;
    }

    /// Closes every tab of the session.
    pub(crate) async fn dispose_session(&self, session: &str) {
        for tab in self.session_tabs(session) {
            self.close_tab(tab.view.as_str()).await;
        }
    }

    pub(crate) async fn list_tabs(&self, session: &str) -> Vec<TabInfo> {
        let mut out = Vec::new();
        for tab in self.session_tabs(session) {
            let history = self.history(&tab).await.ok();
            let entry = history.as_ref().and_then(|h| h.entry(h.current));
            let text = |key: &str| entry.and_then(|e| e.get(key)).and_then(Value::as_str).unwrap_or("").to_owned();
            out.push(TabInfo {
                tab_id: tab.view.0.clone(),
                url: text("url"),
                title: text("title"),
                loading: tab.loading.load(Ordering::SeqCst),
                can_go_back: history.as_ref().is_some_and(|h| h.target(true).is_some()),
                can_go_forward: history.as_ref().is_some_and(|h| h.target(false).is_some()),
                // The shell does not report sound yet.
                audible: false,
                muted: tab.muted.load(Ordering::SeqCst),
            });
        }
        out
    }

    pub(crate) async fn navigate(&self, tab_id: &str, action: NavigateAction, url: Option<&str>) -> R<()> {
        let tab = self.tab(tab_id)?;
        let _serial = tab.serial.lock().await;
        match action {
            NavigateAction::Url => {
                let url =
                    url.filter(|u| !u.is_empty()).ok_or_else(|| failed("navigate action 'url' requires a url"))?;
                self.go(&tab, url).await
            }
            NavigateAction::Reload => self.cdp(&tab, "Page.reload", json!({})).await.map(drop),
            NavigateAction::Back | NavigateAction::Forward => {
                let history = self.history(&tab).await?;
                let Some(entry) = history.target(action == NavigateAction::Back) else { return Ok(()) };
                // Chosen by whoever asked for back or forward, and reached once already:
                // a page on the local network in the history may be gone back to.
                if let Some(host) = host_of(History::url_of(entry)) {
                    self.views.allow_local_network(&tab.view, &host).await?;
                }
                self.cdp(&tab, "Page.navigateToHistoryEntry", json!({ "entryId": entry.get("id") })).await.map(drop)
            }
        }
    }

    // ---- snapshot and find --------------------------------------------------------------

    pub(crate) async fn snapshot(
        &self,
        tab_id: &str,
        interactive_only: bool,
        selector: Option<&str>,
        depth: Option<u64>,
    ) -> R<(String, String)> {
        let tab = self.tab(tab_id)?;
        let _serial = tab.serial.lock().await;
        let root = match selector.filter(|s| !s.is_empty()) {
            Some(selector) => Some(self.backend_node_for_selector(&tab, selector).await?),
            None => None,
        };
        let tree = self.cdp(&tab, "Accessibility.getFullAXTree", json!({})).await?;
        let nodes = tree.get("nodes").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
        let formatted = axtree::format_ax_tree(
            nodes,
            FormatOptions {
                interactive_only,
                depth,
                root_backend_node_id: root,
                ref_start: tab.ref_counter.load(Ordering::SeqCst),
            },
        );
        tab.ref_counter.store(formatted.next_ref_index, Ordering::SeqCst);
        {
            let mut refs = lock(&tab.refs);
            refs.clear();
            refs.extend(formatted.refs);
        }
        Ok((self.page(&tab).await.0, formatted.text))
    }

    pub(crate) async fn find(&self, tab_id: &str, query: &str) -> R<Vec<BrowserElement>> {
        let tab = self.tab(tab_id)?;
        let _serial = tab.serial.lock().await;
        let matcher = Matcher::new(query)?;
        let tree = self.cdp(&tab, "Accessibility.getFullAXTree", json!({})).await?;
        let mut out = Vec::new();
        for node in tree.get("nodes").and_then(Value::as_array).into_iter().flatten() {
            if out.len() >= FIND_MATCH_CAP {
                break;
            }
            let Some(backend) = node.get("backendDOMNodeId").and_then(Value::as_i64) else { continue };
            if node.get("ignored").and_then(Value::as_bool).unwrap_or(false) {
                continue;
            }
            if matches!(role_of(node).as_str(), "statictext" | "inlinetextbox" | "rootwebarea") {
                continue;
            }
            let name = text_of(node.pointer("/name/value"));
            if name.is_empty() || !matcher.test(&name) {
                continue;
            }
            if let Ok(element) = self.build_element(&tab, backend, node).await {
                out.push(element);
            }
        }
        Ok(out)
    }

    /// The address the tab shows, for the answers that carry it.
    pub(crate) async fn url(&self, tab_id: &str) -> R<String> {
        let tab = self.tab(tab_id)?;
        Ok(self.page(&tab).await.0)
    }

    // ---- acting ---------------------------------------------------------------------------

    pub(crate) async fn act(&self, tab_id: &str, reference: &str, verb: ActVerb) -> R<()> {
        let tab = self.tab(tab_id)?;
        let _serial = tab.serial.lock().await;
        let backend = Self::resolve_ref(&tab, reference)?;
        match verb {
            ActVerb::Focus => self.cdp(&tab, "DOM.focus", json!({ "backendNodeId": backend })).await.map(drop),
            ActVerb::Check | ActVerb::Uncheck => {
                let checked = self.call_on_node(&tab, backend, "function(){ return !!this.checked }").await?;
                if checked.as_bool() == Some(verb == ActVerb::Check) {
                    return Ok(());
                }
                self.trusted_click(&tab, backend).await
            }
            ActVerb::Hover => {
                let at = self.center_of(&tab, backend).await?;
                self.mouse(&tab, "mouseMoved", at, "none", 0, 0).await
            }
            ActVerb::Click => self.trusted_click(&tab, backend).await,
        }
    }

    pub(crate) async fn type_text(&self, tab_id: &str, reference: &str, text: &str, submit: bool) -> R<()> {
        let tab = self.tab(tab_id)?;
        let _serial = tab.serial.lock().await;
        let backend = Self::resolve_ref(&tab, reference)?;
        self.cdp(&tab, "DOM.focus", json!({ "backendNodeId": backend })).await?;
        self.call_on_node(&tab, backend, SELECT_CONTENTS).await?;
        self.cdp(&tab, "Input.insertText", json!({ "text": text })).await?;
        if submit {
            self.press_key(&tab, "Enter").await?;
        }
        Ok(())
    }

    pub(crate) async fn press(&self, tab_id: &str, key: &str) -> R<()> {
        let tab = self.tab(tab_id)?;
        let _serial = tab.serial.lock().await;
        self.press_key(&tab, key).await
    }

    async fn press_key(&self, tab: &Tab, key: &str) -> R<()> {
        let chord = parse_chord(key).map_err(failed)?;
        let event = |kind: &str| {
            json!({
                "key": chord.key,
                "code": chord.code,
                "modifiers": chord.modifiers,
                "windowsVirtualKeyCode": chord.windows_virtual_key_code,
                "nativeVirtualKeyCode": chord.windows_virtual_key_code,
                "type": kind,
            })
        };
        let mut down = event(if chord.text.is_empty() { "rawKeyDown" } else { "keyDown" });
        down["text"] = json!(chord.text);
        down["unmodifiedText"] = json!(chord.text);
        self.cdp(tab, "Input.dispatchKeyEvent", down).await?;
        self.cdp(tab, "Input.dispatchKeyEvent", event("keyUp")).await?;
        Ok(())
    }

    pub(crate) async fn scroll(&self, tab_id: &str, direction: ScrollDirection, reference: Option<&str>) -> R<()> {
        let tab = self.tab(tab_id)?;
        let _serial = tab.serial.lock().await;
        let up = direction == ScrollDirection::Up;
        if let Some(reference) = reference.filter(|r| !r.is_empty()) {
            let backend = Self::resolve_ref(&tab, reference)?;
            let name = match direction {
                ScrollDirection::Up => "up",
                ScrollDirection::Down => "down",
                ScrollDirection::Top => "top",
                ScrollDirection::Bottom => "bottom",
            };
            let function = format!(
                "function(){{
        const d = {};
        if (d === \"top\") this.scrollTo(0, 0);
        else if (d === \"bottom\") this.scrollTo(0, this.scrollHeight);
        else this.scrollBy(0, (d === \"up\" ? -0.8 : 0.8) * this.clientHeight);
      }}",
                quoted(name)
            );
            return self.call_on_node(&tab, backend, &function).await.map(drop);
        }
        // Script, not a wheel event: a wheel event sent to an embedded view is never
        // acknowledged, which would hang the verb.
        let expression = match direction {
            ScrollDirection::Top => "window.scrollTo(0, 0)".to_owned(),
            ScrollDirection::Bottom => "window.scrollTo(0, document.body.scrollHeight)".to_owned(),
            _ => format!("window.scrollBy(0, ({}) * window.innerHeight)", if up { "-0.8" } else { "0.8" }),
        };
        self.evaluate(&tab, &expression).await.map(drop)
    }

    // ---- reading ------------------------------------------------------------------------

    pub(crate) async fn get(&self, tab_id: &str, what: GetWhat, reference: Option<&str>) -> R<String> {
        let tab = self.tab(tab_id)?;
        let _serial = tab.serial.lock().await;
        let reference = reference.filter(|r| !r.is_empty());
        let text = |value: Value| value.as_str().map(str::to_owned).unwrap_or_default();
        match (what, reference) {
            (GetWhat::Url, _) => Ok(self.page(&tab).await.0),
            (GetWhat::Title, _) => Ok(self.page(&tab).await.1),
            (GetWhat::Text, None) => {
                let expression = format!("document.body ? document.body.innerText.slice(0, {TEXT_CAP}) : \"\"");
                self.evaluate(&tab, &expression).await.map(text)
            }
            (GetWhat::Text, Some(reference)) => {
                let backend = Self::resolve_ref(&tab, reference)?;
                let function = format!(
                    "function(){{ return String(this.innerText ?? this.textContent ?? \"\").slice(0, {TEXT_CAP}) }}"
                );
                self.call_on_node(&tab, backend, &function).await.map(text)
            }
            (GetWhat::Value, None) => Err(failed("get 'value' requires a ref")),
            (GetWhat::Value, Some(reference)) => {
                let backend = Self::resolve_ref(&tab, reference)?;
                let function = "function(){
      if (this.type === \"password\") return \"[redacted]\";
      return String(this.value ?? \"\");
    }";
                self.call_on_node(&tab, backend, function).await.map(text)
            }
        }
    }

    /// A JPEG of what the tab shows; `full_page`: of the whole page, up to the size Chromium
    /// can take in one piece. A parked view keeps a real size and keeps painting, so a tab
    /// nobody watches is captured like a visible one.
    pub(crate) async fn capture(&self, tab_id: &str, full_page: bool) -> R<Vec<u8>> {
        let tab = self.tab(tab_id)?;
        let _serial = tab.serial.lock().await;
        let mut data = None;
        if full_page {
            // A capture beyond the viewport can stall on an embedded view: fall back to
            // the viewport rather than hang or answer nothing.
            data = self.capture_full_page(&tab).await;
        }
        let data = match data {
            Some(data) => data,
            None => {
                let shot = self.cdp(&tab, "Page.captureScreenshot", json!({ "format": "jpeg", "quality": 80 })).await?;
                shot.get("data").and_then(Value::as_str).unwrap_or("").to_owned()
            }
        };
        base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| failed(e.to_string()))
    }

    async fn within<T>(&self, ms: i64, call: impl std::future::Future<Output = R<T>>) -> Option<T> {
        tokio::select! {
            answer = call => answer.ok(),
            () = self.sleeper.sleep(ms) => None,
        }
    }

    async fn capture_full_page(&self, tab: &Tab) -> Option<String> {
        let metrics = self.within(FULLPAGE_METRICS_MS, self.cdp(tab, "Page.getLayoutMetrics", json!({}))).await?;
        let content = metrics.get("cssContentSize").or_else(|| metrics.get("contentSize"))?;
        let side =
            |key: &str, max: f64| js_round(content.get(key).and_then(Value::as_f64).unwrap_or(0.0)).clamp(1.0, max);
        let clip = json!({ "x": 0, "y": 0, "width": side("width", MAX_CAPTURE_PX), "height": side("height", MAX_FULLPAGE_PX), "scale": 1 });
        let params = json!({ "format": "jpeg", "quality": 80, "captureBeyondViewport": true, "clip": clip });
        let shot = self.within(FULLPAGE_SHOT_MS, self.cdp(tab, "Page.captureScreenshot", params)).await?;
        shot.get("data").and_then(Value::as_str).map(str::to_owned)
    }

    // ---- device emulation -------------------------------------------------------------

    pub(crate) async fn set_device(&self, tab_id: &str, device: BrowserDevice) -> R<()> {
        let tab = self.tab(tab_id)?;
        let _serial = tab.serial.lock().await;
        let profile = device_profile(device);
        // The page is emulated over DevTools; the panel shows the view at the device's
        // size, centered.
        if let Some(panel) = &self.panel {
            panel.set_device_size(&tab.view, profile.as_ref().map(|p| (f64::from(p.width), f64::from(p.height))));
        }
        match profile {
            None => {
                self.cdp_quietly(&tab, "Emulation.clearDeviceMetricsOverride", json!({})).await;
                self.cdp_quietly(&tab, "Emulation.setTouchEmulationEnabled", json!({ "enabled": false })).await;
                self.cdp_quietly(&tab, "Emulation.setEmitTouchEventsForMouse", json!({ "enabled": false })).await;
                // An empty override gives the page its own user agent back.
                self.cdp_quietly(&tab, "Emulation.setUserAgentOverride", json!({ "userAgent": "" })).await;
            }
            Some(p) => {
                let metrics =
                    json!({ "width": p.width, "height": p.height, "deviceScaleFactor": p.scale, "mobile": true });
                self.cdp(&tab, "Emulation.setDeviceMetricsOverride", metrics).await?;
                let touch = json!({ "enabled": true, "maxTouchPoints": 5 });
                self.cdp_quietly(&tab, "Emulation.setTouchEmulationEnabled", touch).await;
                let emit = json!({ "enabled": true, "configuration": "mobile" });
                self.cdp_quietly(&tab, "Emulation.setEmitTouchEventsForMouse", emit).await;
                let agent = json!({ "userAgent": p.user_agent, "platform": p.platform });
                self.cdp(&tab, "Emulation.setUserAgentOverride", agent).await?;
            }
        }
        self.cdp(&tab, "Page.reload", json!({})).await.map(drop)
    }

    // ---- the element picker -----------------------------------------------------------

    pub(crate) async fn element_at(&self, tab_id: &str, x: f64, y: f64) -> R<BrowserElement> {
        let tab = self.tab(tab_id)?;
        let _serial = tab.serial.lock().await;
        let at = json!({ "x": js_round(x), "y": js_round(y), "includeUserAgentShadowDOM": false });
        let hit = self.cdp(&tab, "DOM.getNodeForLocation", at).await?;
        let backend =
            hit.get("backendNodeId").and_then(Value::as_i64).ok_or_else(|| failed("no node at that point"))?;
        self.element_for_backend_node(&tab, backend).await
    }

    async fn element_for_backend_node(&self, tab: &Tab, backend: i64) -> R<BrowserElement> {
        let params = json!({ "backendNodeId": backend, "fetchRelatives": false });
        let tree = self.cdp(tab, "Accessibility.getPartialAXTree", params).await?;
        let fallback = json!({ "nodeId": "0", "backendDOMNodeId": backend });
        let node = tree.pointer("/nodes/0").unwrap_or(&fallback);
        self.build_element(tab, backend, node).await
    }

    /// Lets the user pick an element on the live view: Chromium's own inspect overlay
    /// highlights what the pointer is over, and the click is taken by the overlay, never
    /// delivered to the page. The picked ref is minted in the tab's own ref map, so an
    /// agent can act on it. `None`: cancelled, or the overlay did not start.
    pub(crate) async fn pick_element(&self, tab_id: &str) -> Option<BrowserElement> {
        let tab = self.tab(tab_id).ok()?;
        self.cancel_pick_of(None);
        self.cdp_quietly(&tab, "Overlay.enable", json!({})).await;
        let (chosen, picked) = tokio::sync::oneshot::channel();
        *lock(&self.pick) = Some(Pick { tab_id: tab_id.to_owned(), chosen });
        let mode = json!({
            "mode": "searchForNode",
            "highlightConfig": {
                "showInfo": true,
                "contentColor": { "r": 111, "g": 168, "b": 220, "a": 0.42 },
                "paddingColor": { "r": 147, "g": 196, "b": 125, "a": 0.35 },
                "borderColor": { "r": 255, "g": 229, "b": 153, "a": 0.45 },
                "marginColor": { "r": 246, "g": 178, "b": 107, "a": 0.32 },
            },
        });
        let backend = match self.cdp(&tab, "Overlay.setInspectMode", mode).await {
            Ok(_) => picked.await.ok().flatten(),
            Err(_) => {
                self.cancel_pick_of(Some(tab_id));
                None
            }
        };
        self.cdp_quietly(&tab, "Overlay.setInspectMode", json!({ "mode": "none", "highlightConfig": {} })).await;
        self.cdp_quietly(&tab, "Overlay.hideHighlight", json!({})).await;
        let _serial = tab.serial.lock().await;
        self.element_for_backend_node(&tab, backend?).await.ok()
    }

    /// Ends the pick under way: of `tab_id` only, or whichever it is.
    fn cancel_pick_of(&self, tab_id: Option<&str>) {
        let mut pick = lock(&self.pick);
        if pick.as_ref().is_some_and(|p| tab_id.is_none_or(|id| p.tab_id == id))
            && let Some(pick) = pick.take()
        {
            let _ = pick.chosen.send(None);
        }
    }

    pub(crate) fn cancel_pick(&self) {
        self.cancel_pick_of(None);
    }

    // ---- wait probes and sound --------------------------------------------------------

    pub(crate) async fn text_present(&self, tab_id: &str, text: &str) -> R<bool> {
        let tab = self.tab(tab_id)?;
        let _serial = tab.serial.lock().await;
        let expression = format!(
            "!!document.body && document.body.innerText.toLowerCase().includes({})",
            quoted(&text.to_lowercase())
        );
        Ok(self.evaluate(&tab, &expression).await? == Value::Bool(true))
    }

    pub(crate) async fn ref_visible(&self, tab_id: &str, reference: &str) -> R<bool> {
        let tab = self.tab(tab_id)?;
        let _serial = tab.serial.lock().await;
        let backend = Self::resolve_ref(&tab, reference)?;
        Ok(self.box_of(&tab, backend).await.is_ok())
    }

    pub(crate) async fn set_muted(&self, tab_id: &str, muted: bool) -> R<()> {
        let tab = self.tab(tab_id)?;
        let _serial = tab.serial.lock().await;
        self.views.set_muted(&tab.view, muted).await?;
        tab.muted.store(muted, Ordering::SeqCst);
        Ok(())
    }

    // ---- internals ----------------------------------------------------------------------

    fn resolve_ref(tab: &Tab, reference: &str) -> R<i64> {
        lock(&tab.refs).get(reference).copied().ok_or_else(|| DriverError::StaleRef(reference.to_owned()))
    }

    async fn backend_node_for_selector(&self, tab: &Tab, selector: &str) -> R<i64> {
        let document = self.cdp(tab, "DOM.getDocument", json!({ "depth": 0 })).await?;
        let query = json!({ "nodeId": document.pointer("/root/nodeId"), "selector": selector });
        let found = self.cdp(tab, "DOM.querySelector", query).await?;
        let node_id = found.get("nodeId").and_then(Value::as_i64).unwrap_or(0);
        if node_id == 0 {
            return Err(failed(format!("selector matched nothing: {selector}")));
        }
        let described = self.cdp(tab, "DOM.describeNode", json!({ "nodeId": node_id })).await?;
        described.pointer("/node/backendNodeId").and_then(Value::as_i64).ok_or_else(|| failed("no backendNodeId"))
    }

    /// `[x, y, width, height]` of the node's border box, in CSS pixels of the viewport.
    async fn box_of(&self, tab: &Tab, backend: i64) -> R<[f64; 4]> {
        let model = self.cdp(tab, "DOM.getBoxModel", json!({ "backendNodeId": backend })).await?;
        let quad: Vec<f64> = model
            .pointer("/model/border")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_f64)
            .collect();
        if quad.len() < 8 {
            return Err(failed("no box model"));
        }
        let (xs, ys) = ([quad[0], quad[2], quad[4], quad[6]], [quad[1], quad[3], quad[5], quad[7]]);
        let min = |v: [f64; 4]| v.iter().copied().fold(f64::INFINITY, f64::min);
        let max = |v: [f64; 4]| v.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let (x, y) = (min(xs), min(ys));
        Ok([js_round(x), js_round(y), js_round(max(xs) - x), js_round(max(ys) - y)])
    }

    async fn center_of(&self, tab: &Tab, backend: i64) -> R<(f64, f64)> {
        self.cdp_quietly(tab, "DOM.scrollIntoViewIfNeeded", json!({ "backendNodeId": backend })).await;
        let [x, y, width, height] = self.box_of(tab, backend).await?;
        Ok((js_round(x + width / 2.0), js_round(y + height / 2.0)))
    }

    async fn mouse(&self, tab: &Tab, kind: &str, (x, y): (f64, f64), button: &str, buttons: u8, clicks: u8) -> R<()> {
        let event = json!({ "type": kind, "x": x, "y": y, "button": button, "buttons": buttons, "clickCount": clicks, "deltaX": 0, "deltaY": 0 });
        self.cdp(tab, "Input.dispatchMouseEvent", event).await.map(drop)
    }

    /// A real click: the page sees a trusted event, as from the user's pointer.
    async fn trusted_click(&self, tab: &Tab, backend: i64) -> R<()> {
        let at = self.center_of(tab, backend).await?;
        self.mouse(tab, "mouseMoved", at, "none", 0, 0).await?;
        self.mouse(tab, "mousePressed", at, "left", 1, 1).await?;
        self.mouse(tab, "mouseReleased", at, "left", 0, 1).await
    }

    /// The element payload of a node, with a fresh ref. Never markup.
    async fn build_element(&self, tab: &Tab, backend: i64, ax: &Value) -> R<BrowserElement> {
        let described = self.cdp(tab, "DOM.describeNode", json!({ "backendNodeId": backend })).await?;
        let tag = described.pointer("/node/nodeName").and_then(Value::as_str).unwrap_or("").to_lowercase();
        let [x, y, width, height] = self.box_of(tab, backend).await?;
        let role = Some(role_of(ax)).filter(|role| !role.is_empty()).unwrap_or_else(|| tag.clone());
        let name = collapse_spaces(&text_of(ax.pointer("/name/value")));
        let name = utf16_prefix(js_trim(&name), 100).to_owned();
        let states = states_of(ax);
        let attributes: Vec<&str> = described
            .pointer("/node/attributes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        // A flat list of name, value, name, value; a repeated name keeps its last value.
        let attribute =
            |name: &str| attributes.as_chunks::<2>().0.iter().rev().find(|pair| pair[0] == name).map(|pair| pair[1]);
        let reference = format!("@e{}", tab.ref_counter.fetch_add(1, Ordering::SeqCst) + 1);
        lock(&tab.refs).insert(reference.clone(), backend);
        let mut value = None;
        if matches!(tag.as_str(), "input" | "textarea" | "select") && attribute("type") != Some("password") {
            let read = self.call_on_node(tab, backend, "function(){ return String(this.value ?? \"\") }").await;
            value = read.ok().and_then(|v| v.as_str().map(str::to_owned)).filter(|v| !v.is_empty());
        }
        let locator = if !name.is_empty() {
            format!("role={role}[name={}]", quoted(&name))
        } else {
            match attribute("id").filter(|id| !id.is_empty()) {
                Some(id) => format!("#{id}"),
                None => tag.clone(),
            }
        };
        Ok(BrowserElement {
            r#ref: reference,
            tag,
            role,
            name,
            r#box: (x.into(), y.into(), width.into(), height.into()),
            focusable: axtree::is_focusable(ax),
            state: (!states.is_empty()).then_some(states),
            value: value.map(|v| utf16_prefix(&v, 100).to_owned()),
            locator,
        })
    }
}

/// What `find` matches names with: `/pattern/flags` is a regular expression (always case
/// blind), anything else a substring, case blind.
enum Matcher {
    Regex(Box<regress::Regex>),
    Text(String),
}

impl Matcher {
    fn new(query: &str) -> R<Self> {
        // `^\/(.+)\/([a-z]*)$`: the last slash that only lower-case letters follow.
        let regex = query.strip_prefix('/').and_then(|rest| {
            let (pattern, flags) = rest.rsplit_once('/')?;
            (!pattern.is_empty() && flags.bytes().all(|b| b.is_ascii_lowercase())).then_some((pattern, flags))
        });
        match regex {
            Some((pattern, flags)) => {
                let flags = if flags.contains('i') { flags.to_owned() } else { format!("{flags}i") };
                regress::Regex::with_flags(pattern, flags.as_str())
                    .map(|regex| Matcher::Regex(Box::new(regex)))
                    .map_err(|e| failed(format!("Invalid regular expression: /{pattern}/{flags}: {e}")))
            }
            None => Ok(Matcher::Text(query.to_lowercase())),
        }
    }

    fn test(&self, name: &str) -> bool {
        match self {
            Matcher::Regex(regex) => {
                let units: Vec<u16> = name.encode_utf16().collect();
                regex.find_from_utf16(&units, 0).next().is_some()
            }
            Matcher::Text(needle) => name.to_lowercase().contains(needle),
        }
    }
}

impl ViewListener for Driver {
    fn on_view_event(&self, view: &ViewId, event: &ViewEvent) {
        let Some(tab) = lock(&self.tabs).get(view.as_str()).cloned() else { return };
        let events = self.events();
        let changed = || {
            if let Some(events) = &events {
                events.tabs_changed(&tab.session);
            }
        };
        match event {
            ViewEvent::Cdp { method, params } => match method.as_str() {
                "Page.frameNavigated" if params.pointer("/frame/parentId").is_none() => {
                    // A main-frame navigation recycles node ids: every ref from before it
                    // would act on another node.
                    lock(&tab.refs).clear();
                    *lock(&tab.main_frame) = params.pointer("/frame/id").and_then(Value::as_str).map(str::to_owned);
                    changed();
                }
                "Page.frameStartedLoading" | "Page.frameStoppedLoading" => {
                    let frame = params.get("frameId").and_then(Value::as_str);
                    let main = lock(&tab.main_frame).clone();
                    if main.is_none() || main.as_deref() == frame {
                        tab.loading.store(method == "Page.frameStartedLoading", Ordering::SeqCst);
                        changed();
                    }
                }
                "Page.loadEventFired" | "Page.domContentEventFired" | "Page.navigatedWithinDocument" => changed(),
                "Overlay.inspectNodeRequested" => {
                    let mut pick = lock(&self.pick);
                    if pick.as_ref().is_some_and(|p| p.tab_id == view.as_str())
                        && let Some(pick) = pick.take()
                    {
                        let _ = pick.chosen.send(params.get("backendNodeId").and_then(Value::as_i64));
                    }
                }
                _ => {}
            },
            ViewEvent::OpenRequested { url } => {
                if (url.starts_with("http://") || url.starts_with("https://"))
                    && let Some(events) = &events
                {
                    events.popup(&tab.session, url.clone());
                }
            }
            ViewEvent::Closed => {
                lock(&self.tabs).remove(view.as_str());
                self.cancel_pick_of(Some(view.as_str()));
                if let Some(panel) = &self.panel {
                    panel.forget(view);
                }
                if let Some(events) = &events {
                    events.tab_gone(&tab.session, view.as_str());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounding_is_javascripts() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(2.4), 2.0);
        assert_eq!(js_round(-0.2), 0.0);
    }

    #[test]
    fn find_takes_text_or_a_regular_expression() {
        assert!(Matcher::new("sign").unwrap().test("Sign in"));
        assert!(!Matcher::new("sign").unwrap().test("Log in"));
        assert!(Matcher::new("/^sign (in|up)$/").unwrap().test("SIGN UP"));
        assert!(!Matcher::new("/^sign (in|up)$/").unwrap().test("Sign out"));
        // Not a regular expression: no closing slash, or something else after it.
        assert!(Matcher::new("/docs").unwrap().test("see /docs/api"));
        assert!(Matcher::new("/a/B").unwrap().test("x /a/b y"));
        assert!(matches!(Matcher::new("/(/"), Err(DriverError::Failed(_))));
    }

    #[test]
    fn going_back_never_lands_on_the_blank_start() {
        let entry = |url: &str| json!({ "id": 1, "url": url });
        let first = History { current: 1, entries: vec![entry("about:blank"), entry("https://a.test/")] };
        assert!(first.target(true).is_none());
        assert!(first.target(false).is_none());
        let second = History {
            current: 2,
            entries: vec![entry("about:blank"), entry("https://a.test/"), entry("https://b.test/")],
        };
        assert_eq!(History::url_of(second.target(true).unwrap()), "https://a.test/");
        let back = History { current: 1, ..second };
        assert_eq!(History::url_of(back.target(false).unwrap()), "https://b.test/");
        // A history that does not start blank (a popup opened on its page) goes back to it.
        let popup = History { current: 1, entries: vec![entry("https://a.test/"), entry("https://b.test/")] };
        assert!(popup.target(true).is_some());
    }
}
