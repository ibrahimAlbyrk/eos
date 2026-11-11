// The side-panel browser: one child Chromium view per tab, placed at the rectangle the
// dashboard's browser panel reports, and driven over the in-process DevTools channel.
// Ports the essentials of app/src/main/browser/{views,driver,channel}.ts.
use std::{
  collections::HashMap,
  path::PathBuf,
  sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
  },
  time::Duration,
};

use serde_json::{Value, json};
use tauri::{LogicalPosition, LogicalSize, Url, WebviewUrl, webview::WebviewBuilder};
use tauri_runtime_cef::cef::{ImplBrowser, ImplBrowserHost};
use tauri_runtime_cef::{WebviewBuilderCefExt, WebviewCefExt};

use crate::{axtree, cdp::Cdp, log};

const BG_SIZE: (f64, f64) = (1280., 800.);
const TEXT_CAP: usize = 40_000;

pub struct DriverError {
  pub name: &'static str,
  pub message: String,
}
type R<T> = Result<T, DriverError>;
fn err(message: impl Into<String>) -> DriverError {
  DriverError { name: "Error", message: message.into() }
}
impl From<String> for DriverError {
  fn from(message: String) -> Self {
    err(message)
  }
}

pub struct Tab {
  pub tab_id: String,
  pub session: String,
  pub webview: tauri::Webview,
  pub cdp: Cdp,
  refs: Mutex<HashMap<String, i64>>,
  ref_counter: AtomicU32,
  loading: AtomicBool,
  lock: Mutex<()>,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Park {
  /// `Webview::hide()`: the native view is hidden and the page told so.
  Hide,
  /// Stay shown, moved outside the window: nothing on screen, page still "visible".
  OffScreen,
}

#[derive(Default)]
struct Geo {
  current: Option<String>,
  bounds: (f64, f64, f64, f64),
  visible: bool,
  overlay: bool,
  occluded: bool,
  shown: bool,
  seq: u64,
}

pub struct Browser {
  window: tauri::Window,
  tabs: Mutex<HashMap<String, Arc<Tab>>>,
  geo: Mutex<Geo>,
  pub park: Mutex<Park>,
  events: tokio::sync::mpsc::UnboundedSender<Value>,
  counter: AtomicU64,
  pub geometry_calls: AtomicU64,
  /// With no_bridge the renderer never installs `window.ipc` in the tab.
  pub no_bridge: bool,
}

impl Browser {
  pub fn new(window: tauri::Window, park: Park, no_bridge: bool) -> (Arc<Self>, tokio::sync::mpsc::UnboundedReceiver<Value>) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let geo = Geo { visible: true, ..Default::default() };
    (
      Arc::new(Browser {
        window,
        tabs: Default::default(),
        geo: Mutex::new(geo),
        park: Mutex::new(park),
        events: tx,
        counter: AtomicU64::new(0),
        geometry_calls: AtomicU64::new(0),
        no_bridge,
      }),
      rx,
    )
  }

  fn notify(&self, session: &str, event: &str, payload: Value) {
    let _ = self.events.send(json!({ "type": "event", "sessionKey": session, "event": event, "payload": payload }));
  }

  pub fn tab(&self, tab_id: &str) -> R<Arc<Tab>> {
    self.tabs.lock().unwrap().get(tab_id).cloned().ok_or_else(|| err(format!("unknown tab: {tab_id}")))
  }

  pub fn tab_ids(&self) -> Vec<String> {
    self.tabs.lock().unwrap().keys().cloned().collect()
  }

  // ---- views ---------------------------------------------------------------

  fn create_tab(self: &Arc<Self>, session: &str) -> R<Arc<Tab>> {
    let n = self.counter.fetch_add(1, Ordering::SeqCst);
    let tab_id = format!("bt-{:08x}{:04x}", std::process::id(), n);
    let profile = format!("browser-{}", session.chars().map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '_' }).collect::<String>());
    let mut builder = WebviewBuilder::new(&tab_id, WebviewUrl::External(Url::parse("about:blank").unwrap()))
      .position(LogicalPosition::new(0., 0.))
      .size(LogicalSize::new(BG_SIZE.0, BG_SIZE.1))
      .focused(false)
      .data_directory(PathBuf::from(profile))
      // Fence privileged schemes only; arbitrary web navigation is allowed.
      .on_navigation(|url| !matches!(url.scheme(), "eos" | "file" | "chrome" | "devtools"));
    if self.no_bridge {
      builder = builder.no_bridge(true);
    }
    let webview = self.window.add_child(builder).map_err(|e| err(format!("add_child: {e}")))?;
    let cdp = Cdp::attach(&webview)?;
    let tab = Arc::new(Tab {
      tab_id: tab_id.clone(),
      session: session.to_string(),
      webview,
      cdp,
      refs: Default::default(),
      ref_counter: AtomicU32::new(0),
      loading: AtomicBool::new(false),
      lock: Mutex::new(()),
    });
    self.park_view(&tab);
    for domain in ["Page.enable", "DOM.enable", "Accessibility.enable", "Runtime.enable"] {
      let _ = tab.cdp.call(domain, json!({}));
    }
    // A hidden view otherwise defers renderer-initiated navigation until shown.
    let _ = tab.cdp.call("Emulation.setFocusEmulationEnabled", json!({ "enabled": true }));
    let weak = Arc::downgrade(self);
    let wtab = Arc::downgrade(&tab);
    tab.cdp.on_event(move |method, params| {
      let (Some(browser), Some(tab)) = (weak.upgrade(), wtab.upgrade()) else { return };
      match method {
        "Page.frameNavigated" if params.pointer("/frame/parentId").is_none() => {
          tab.refs.lock().unwrap().clear();
          browser.notify(&tab.session, "tabsChanged", Value::Null);
        }
        "Page.frameStartedLoading" | "Page.frameStoppedLoading" | "Page.loadEventFired" | "Page.navigatedWithinDocument" => {
          tab.loading.store(method == "Page.frameStartedLoading", Ordering::SeqCst);
          browser.notify(&tab.session, "tabsChanged", Value::Null);
        }
        _ => {}
      }
    });
    self.tabs.lock().unwrap().insert(tab_id, tab.clone());
    Ok(tab)
  }

  fn remove_tab(&self, tab_id: &str) {
    let Some(tab) = self.tabs.lock().unwrap().remove(tab_id) else { return };
    let mut geo = self.geo.lock().unwrap();
    if geo.current.as_deref() == Some(tab_id) {
      geo.current = None;
    }
    drop(geo);
    let _ = tab.webview.close();
  }

  fn park_view(&self, tab: &Tab) {
    match *self.park.lock().unwrap() {
      Park::Hide => {
        let _ = tab.webview.hide();
        let _ = tab.webview.set_position(LogicalPosition::new(0., 0.));
      }
      Park::OffScreen => {
        let _ = tab.webview.show();
        let _ = tab.webview.set_position(LogicalPosition::new(-20000., 0.));
      }
    }
    // A parked view keeps a real size so its page has a layout viewport for agents.
    let _ = tab.webview.set_size(LogicalSize::new(BG_SIZE.0, BG_SIZE.1));
  }

  pub fn set_active_view(&self, session: &str, tab_id: &str) {
    let Ok(tab) = self.tab(tab_id) else { return };
    let others: Vec<Arc<Tab>> =
      self.tabs.lock().unwrap().values().filter(|t| t.session == session && t.tab_id != tab_id).cloned().collect();
    for other in others {
      self.park_view(&other);
    }
    self.geo.lock().unwrap().current = Some(tab_id.to_string());
    let _ = tab.webview.with_cef_webview(|w| {
      if let Some(host) = w.browser().host() {
        crate::appkit::bring_view_to_front(host.window_handle() as *mut std::ffi::c_void);
      }
    });
    self.apply_geometry();
    self.notify(session, "activeTabChanged", json!({ "tabId": tab_id }));
  }

  /// `seq` orders calls that travelled as independent requests; a stale one is dropped.
  pub fn set_bounds(&self, seq: u64, x: f64, y: f64, w: f64, h: f64) {
    {
      let mut geo = self.geo.lock().unwrap();
      if seq != 0 && seq < geo.seq {
        return;
      }
      geo.seq = seq.max(geo.seq);
      geo.bounds = (x.round(), y.round(), w.round().max(0.), h.round().max(0.));
    }
    self.apply_geometry();
  }

  pub fn set_flag(&self, which: &str, value: bool) {
    {
      let mut geo = self.geo.lock().unwrap();
      match which {
        "visible" => geo.visible = value,
        "overlay" => geo.overlay = value,
        "occluded" => geo.occluded = value,
        _ => {}
      }
    }
    self.apply_geometry();
  }

  fn apply_geometry(&self) {
    self.geometry_calls.fetch_add(1, Ordering::Relaxed);
    let (tab_id, show, b) = {
      let mut geo = self.geo.lock().unwrap();
      let show = geo.visible && !geo.overlay && !geo.occluded && geo.bounds.2 > 0. && geo.bounds.3 > 0.;
      geo.shown = show;
      (geo.current.clone(), show, geo.bounds)
    };
    let Some(tab) = tab_id.and_then(|id| self.tab(&id).ok()) else { return };
    if show {
      let _ = tab.webview.set_position(LogicalPosition::new(b.0, b.1));
      let _ = tab.webview.set_size(LogicalSize::new(b.2, b.3));
      let _ = tab.webview.show();
    } else {
      self.park_view(&tab);
    }
  }

  pub fn state(&self) -> Value {
    let geo = self.geo.lock().unwrap();
    json!({
      "current": geo.current, "bounds": [geo.bounds.0, geo.bounds.1, geo.bounds.2, geo.bounds.3],
      "visible": geo.visible, "overlay": geo.overlay, "occluded": geo.occluded, "shown": geo.shown,
      "tabs": self.tab_ids(), "geometryCalls": self.geometry_calls.load(Ordering::Relaxed),
      "park": format!("{:?}", *self.park.lock().unwrap()),
    })
  }

  /// A still of the on-screen view (stands in for it while a DOM layer covers it).
  pub fn snapshot(&self) -> Value {
    let (tab_id, shown, b) = {
      let geo = self.geo.lock().unwrap();
      (geo.current.clone(), geo.shown, geo.bounds)
    };
    let Some(tab) = tab_id.and_then(|id| self.tab(&id).ok()) else { return Value::Null };
    if !shown {
      return Value::Null;
    }
    match tab.cdp.call_timeout("Page.captureScreenshot", json!({ "format": "jpeg", "quality": 90 }), Duration::from_secs(4)) {
      Ok(v) => json!({
        "url": format!("data:image/jpeg;base64,{}", v.get("data").and_then(Value::as_str).unwrap_or("")),
        "rect": { "x": b.0, "y": b.1, "width": b.2, "height": b.3 },
      }),
      Err(_) => Value::Null,
    }
  }

  // ---- driver (the daemon's port verbs) --------------------------------------

  pub fn handle(self: &Arc<Self>, method: &str, session: &str, args: &[Value]) -> R<Value> {
    let arg_str = |i: usize| args.get(i).and_then(Value::as_str).unwrap_or("").to_string();
    match method {
      "launch" => return Ok(Value::Null),
      "openTab" => {
        let url = arg_str(0);
        let tab = self.create_tab(session)?;
        if !url.is_empty() && url != "about:blank" {
          tab.cdp.call("Page.navigate", json!({ "url": url }))?;
        }
        return Ok(json!(tab.tab_id));
      }
      "listTabs" => return Ok(self.list_tabs(session)),
      "dispose" => {
        let ids: Vec<String> =
          self.tabs.lock().unwrap().values().filter(|t| t.session == session).map(|t| t.tab_id.clone()).collect();
        for id in ids {
          self.remove_tab(&id);
        }
        return Ok(Value::Null);
      }
      _ => {}
    }
    let tab_id = arg_str(0);
    if method == "closeTab" {
      self.remove_tab(&tab_id);
      return Ok(Value::Null);
    }
    let t = self.tab(&tab_id)?;
    let _serial = t.lock.lock().unwrap();
    match method {
      "navigate" => {
        match args.get(1).and_then(Value::as_str).unwrap_or("") {
          "url" => {
            let url = arg_str(2);
            if url.is_empty() {
              return Err(err("navigate action 'url' requires a url"));
            }
            t.cdp.call("Page.navigate", json!({ "url": url }))?;
          }
          "reload" => {
            t.cdp.call("Page.reload", json!({}))?;
          }
          action => {
            let hist = t.cdp.call("Page.getNavigationHistory", json!({}))?;
            let cur = hist.get("currentIndex").and_then(Value::as_i64).unwrap_or(0);
            let target = cur + if action == "back" { -1 } else { 1 };
            if let Some(entry) = hist.get("entries").and_then(Value::as_array).and_then(|e| e.get(target.max(0) as usize)).filter(|_| target >= 0) {
              t.cdp.call("Page.navigateToHistoryEntry", json!({ "entryId": entry.get("id") }))?;
            }
          }
        }
        Ok(Value::Null)
      }
      "snapshot" => {
        let opts = args.get(1).cloned().unwrap_or(Value::Null);
        let root = match opts.get("selector").and_then(Value::as_str) {
          Some(sel) => Some(self.backend_node_for_selector(&t, sel)?),
          None => None,
        };
        let tree = t.cdp.call_timeout("Accessibility.getFullAXTree", json!({}), Duration::from_secs(15))?;
        let nodes = tree.get("nodes").and_then(Value::as_array).cloned().unwrap_or_default();
        let f = axtree::format(
          &nodes,
          opts.get("interactiveOnly").and_then(Value::as_bool).unwrap_or(true),
          opts.get("depth").and_then(Value::as_u64).map(|d| d as u32),
          root,
          t.ref_counter.load(Ordering::SeqCst),
        );
        t.ref_counter.store(f.next_ref, Ordering::SeqCst);
        let mut refs = t.refs.lock().unwrap();
        refs.clear();
        refs.extend(f.refs);
        drop(refs);
        Ok(json!({ "url": self.page_url(&t), "snapshot": f.text }))
      }
      "find" => {
        let query = arg_str(1).to_lowercase();
        let tree = t.cdp.call_timeout("Accessibility.getFullAXTree", json!({}), Duration::from_secs(15))?;
        let mut out = Vec::new();
        for node in tree.get("nodes").and_then(Value::as_array).into_iter().flatten() {
          if out.len() >= 10 {
            break;
          }
          let Some(backend) = node.get("backendDOMNodeId").and_then(Value::as_i64) else { continue };
          if node.get("ignored").and_then(Value::as_bool).unwrap_or(false) {
            continue;
          }
          let role = axtree::role_of(node);
          if matches!(role.as_str(), "statictext" | "inlinetextbox" | "rootwebarea") {
            continue;
          }
          let name = node.pointer("/name/value").and_then(Value::as_str).unwrap_or("");
          if name.is_empty() || !name.to_lowercase().contains(&query) {
            continue;
          }
          if let Ok(el) = self.build_element(&t, backend, node) {
            out.push(el);
          }
        }
        Ok(Value::Array(out))
      }
      "act" => {
        let backend = self.resolve_ref(&t, &arg_str(1))?;
        match args.get(2).and_then(Value::as_str).unwrap_or("click") {
          "focus" => {
            t.cdp.call("DOM.focus", json!({ "backendNodeId": backend }))?;
          }
          "hover" => {
            let (x, y) = self.center_of(&t, backend)?;
            self.mouse(&t, "mouseMoved", x, y, "none", 0, 0)?;
          }
          verb @ ("check" | "uncheck") => {
            let checked = self.call_on_node(&t, backend, "function(){ return !!this.checked }")?;
            if checked.as_bool() != Some(verb == "check") {
              self.trusted_click(&t, backend)?;
            }
          }
          _ => self.trusted_click(&t, backend)?,
        }
        Ok(Value::Null)
      }
      "typeText" => {
        let backend = self.resolve_ref(&t, &arg_str(1))?;
        t.cdp.call("DOM.focus", json!({ "backendNodeId": backend }))?;
        self.call_on_node(
          &t,
          backend,
          "function(){ if (this.select) this.select(); else if (this.isContentEditable) { const r = document.createRange(); r.selectNodeContents(this); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } }",
        )?;
        t.cdp.call("Input.insertText", json!({ "text": arg_str(2) }))?;
        if args.get(3).and_then(Value::as_bool).unwrap_or(false) {
          self.press(&t, "Enter")?;
        }
        Ok(Value::Null)
      }
      "press" => {
        self.press(&t, &arg_str(1))?;
        Ok(Value::Null)
      }
      "scroll" => {
        let direction = arg_str(1);
        let expr = match direction.as_str() {
          "top" => "window.scrollTo(0, 0)".to_string(),
          "bottom" => "window.scrollTo(0, document.body.scrollHeight)".to_string(),
          d => format!("window.scrollBy(0, ({}) * window.innerHeight)", if d == "up" { -0.8 } else { 0.8 }),
        };
        t.cdp.eval(&expr)?;
        Ok(Value::Null)
      }
      "get" => {
        let what = arg_str(1);
        let reference = args.get(2).and_then(Value::as_str);
        Ok(match (what.as_str(), reference) {
          ("url", _) => json!(self.page_url(&t)),
          ("title", _) => t.cdp.eval("document.title")?,
          ("text", None) => t.cdp.eval(&format!("document.body ? document.body.innerText.slice(0, {TEXT_CAP}) : ''"))?,
          ("text", Some(r)) => {
            let backend = self.resolve_ref(&t, r)?;
            self.call_on_node(&t, backend, &format!("function(){{ return String(this.innerText ?? this.textContent ?? '').slice(0, {TEXT_CAP}) }}"))?
          }
          (_, Some(r)) => {
            let backend = self.resolve_ref(&t, r)?;
            self.call_on_node(&t, backend, "function(){ if (this.type === 'password') return '[redacted]'; return String(this.value ?? '') }")?
          }
          _ => return Err(err("get 'value' requires a ref")),
        })
      }
      "capture" => {
        let shot = t.cdp.call_timeout("Page.captureScreenshot", json!({ "format": "jpeg", "quality": 80 }), Duration::from_secs(8))?;
        Ok(shot.get("data").cloned().unwrap_or(Value::Null))
      }
      "textPresent" => {
        let needle = Value::String(arg_str(1).to_lowercase()).to_string();
        Ok(json!(t.cdp.eval(&format!("!!document.body && document.body.innerText.toLowerCase().includes({needle})"))? == Value::Bool(true)))
      }
      "refVisible" => {
        let backend = self.resolve_ref(&t, &arg_str(1))?;
        Ok(json!(self.box_of(&t, backend).is_ok()))
      }
      "setMuted" => {
        let muted = args.get(1).and_then(Value::as_bool).unwrap_or(false);
        let _ = t.webview.with_cef_webview(move |w| {
          if let Some(host) = w.browser().host() {
            host.set_audio_muted(muted as i32);
          }
        });
        Ok(Value::Null)
      }
      "setDevice" | "elementAt" => Err(err(format!("{method}: not ported in the gate prototype"))),
      other => Err(err(format!("unknown browser method: {other}"))),
    }
  }

  fn page_url(&self, t: &Tab) -> String {
    t.cdp.eval("location.href").ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
  }

  fn list_tabs(&self, session: &str) -> Value {
    let tabs: Vec<Arc<Tab>> = self.tabs.lock().unwrap().values().filter(|t| t.session == session).cloned().collect();
    let mut out = Vec::new();
    for t in tabs {
      let info = t
        .cdp
        .call_timeout("Runtime.evaluate", json!({ "expression": "({u: location.href, t: document.title})", "returnByValue": true }), Duration::from_secs(2))
        .ok()
        .and_then(|v| v.pointer("/result/value").cloned())
        .unwrap_or(Value::Null);
      let hist = t.cdp.call_timeout("Page.getNavigationHistory", json!({}), Duration::from_secs(2)).unwrap_or(Value::Null);
      let cur = hist.get("currentIndex").and_then(Value::as_u64).unwrap_or(0) as usize;
      let entries = hist.get("entries").and_then(Value::as_array).cloned().unwrap_or_default();
      // The runtime creates every browser on an inert placeholder document first, so
      // history entries before the first real page do not count.
      let real = |e: &Value| e.get("url").and_then(Value::as_str).is_some_and(|u| u.starts_with("http"));
      out.push(json!({
        "tabId": t.tab_id,
        "url": info.get("u").and_then(Value::as_str).unwrap_or(""),
        "title": info.get("t").and_then(Value::as_str).unwrap_or(""),
        "loading": t.loading.load(Ordering::SeqCst),
        "canGoBack": entries.iter().take(cur).any(real),
        "canGoForward": cur + 1 < entries.len(),
        "audible": false,
        "muted": false,
        "faviconDataUri": null,
      }));
    }
    out.sort_by(|a, b| a["tabId"].as_str().cmp(&b["tabId"].as_str()));
    Value::Array(out)
  }

  fn resolve_ref(&self, t: &Tab, reference: &str) -> R<i64> {
    t.refs.lock().unwrap().get(reference).copied().ok_or_else(|| DriverError {
      name: "StaleRefError",
      message: format!("unknown or stale ref {reference:?} — the page has changed since it was minted; call snapshot (or find) again for fresh refs"),
    })
  }

  fn backend_node_for_selector(&self, t: &Tab, selector: &str) -> R<i64> {
    let doc = t.cdp.call("DOM.getDocument", json!({ "depth": 0 }))?;
    let found = t.cdp.call("DOM.querySelector", json!({ "nodeId": doc.pointer("/root/nodeId"), "selector": selector }))?;
    let node_id = found.get("nodeId").and_then(Value::as_i64).unwrap_or(0);
    if node_id == 0 {
      return Err(err(format!("selector matched nothing: {selector}")));
    }
    let desc = t.cdp.call("DOM.describeNode", json!({ "nodeId": node_id }))?;
    desc.pointer("/node/backendNodeId").and_then(Value::as_i64).ok_or_else(|| err("no backendNodeId"))
  }

  fn box_of(&self, t: &Tab, backend: i64) -> R<[i64; 4]> {
    let model = t.cdp.call("DOM.getBoxModel", json!({ "backendNodeId": backend }))?;
    let q: Vec<f64> = model.pointer("/model/border").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_f64).collect();
    if q.len() < 8 {
      return Err(err("no box model"));
    }
    let (xs, ys) = ([q[0], q[2], q[4], q[6]], [q[1], q[3], q[5], q[7]]);
    let min = |v: [f64; 4]| v.iter().cloned().fold(f64::INFINITY, f64::min);
    let max = |v: [f64; 4]| v.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    Ok([min(xs).round() as i64, min(ys).round() as i64, (max(xs) - min(xs)).round() as i64, (max(ys) - min(ys)).round() as i64])
  }

  fn center_of(&self, t: &Tab, backend: i64) -> R<(i64, i64)> {
    let _ = t.cdp.call("DOM.scrollIntoViewIfNeeded", json!({ "backendNodeId": backend }));
    let [x, y, w, h] = self.box_of(t, backend)?;
    Ok((x + w / 2, y + h / 2))
  }

  fn mouse(&self, t: &Tab, kind: &str, x: i64, y: i64, button: &str, buttons: i64, click_count: i64) -> R<()> {
    t.cdp.call(
      "Input.dispatchMouseEvent",
      json!({ "type": kind, "x": x, "y": y, "button": button, "buttons": buttons, "clickCount": click_count, "deltaX": 0, "deltaY": 0 }),
    )?;
    Ok(())
  }

  fn trusted_click(&self, t: &Tab, backend: i64) -> R<()> {
    let (x, y) = self.center_of(t, backend)?;
    self.mouse(t, "mouseMoved", x, y, "none", 0, 0)?;
    self.mouse(t, "mousePressed", x, y, "left", 1, 1)?;
    self.mouse(t, "mouseReleased", x, y, "left", 0, 1)
  }

  fn press(&self, t: &Tab, chord: &str) -> R<()> {
    let (key, code, key_code, text) = match chord.to_lowercase().as_str() {
      "enter" => ("Enter", "Enter", 13, "\r"),
      "tab" => ("Tab", "Tab", 9, ""),
      "escape" => ("Escape", "Escape", 27, ""),
      "backspace" => ("Backspace", "Backspace", 8, ""),
      "space" => (" ", "Space", 32, " "),
      other => return Err(err(format!("key {other:?}: not ported in the gate prototype"))),
    };
    let base = json!({ "key": key, "code": code, "modifiers": 0, "windowsVirtualKeyCode": key_code, "nativeVirtualKeyCode": key_code });
    let mut down = base.clone();
    down["type"] = json!(if text.is_empty() { "rawKeyDown" } else { "keyDown" });
    down["text"] = json!(text);
    down["unmodifiedText"] = json!(text);
    t.cdp.call("Input.dispatchKeyEvent", down)?;
    let mut up = base;
    up["type"] = json!("keyUp");
    t.cdp.call("Input.dispatchKeyEvent", up)?;
    Ok(())
  }

  fn call_on_node(&self, t: &Tab, backend: i64, function: &str) -> R<Value> {
    let resolved = t.cdp.call("DOM.resolveNode", json!({ "backendNodeId": backend }))?;
    let r = t.cdp.call(
      "Runtime.callFunctionOn",
      json!({ "objectId": resolved.pointer("/object/objectId"), "functionDeclaration": function, "returnByValue": true }),
    )?;
    if let Some(ex) = r.get("exceptionDetails") {
      return Err(err(ex.get("text").and_then(Value::as_str).unwrap_or("node call failed")));
    }
    Ok(r.pointer("/result/value").cloned().unwrap_or(Value::Null))
  }

  fn build_element(&self, t: &Tab, backend: i64, ax: &Value) -> R<Value> {
    let desc = t.cdp.call("DOM.describeNode", json!({ "backendNodeId": backend }))?;
    let tag = desc.pointer("/node/nodeName").and_then(Value::as_str).unwrap_or("").to_lowercase();
    let bx = self.box_of(t, backend)?;
    let role = Some(axtree::role_of(ax)).filter(|r| !r.is_empty()).unwrap_or_else(|| tag.clone());
    let name: String = ax.pointer("/name/value").and_then(Value::as_str).unwrap_or("").split_whitespace().collect::<Vec<_>>().join(" ").chars().take(100).collect();
    let n = t.ref_counter.fetch_add(1, Ordering::SeqCst) + 1;
    let reference = format!("@e{n}");
    t.refs.lock().unwrap().insert(reference.clone(), backend);
    let locator = if name.is_empty() { tag.clone() } else { format!("role={role}[name={}]", Value::String(name.clone())) };
    Ok(json!({ "ref": reference, "tag": tag, "role": role, "name": name, "box": bx, "focusable": axtree::is_focusable(ax), "locator": locator }))
  }
}

// ---- the /browser/host control channel (the app is the daemon's WS client) ------

pub async fn host_channel(url: String, browser: Arc<Browser>, mut events: tokio::sync::mpsc::UnboundedReceiver<Value>) {
  use futures_util::{SinkExt, StreamExt};
  use tokio_tungstenite::tungstenite::Message;
  loop {
    match tokio_tungstenite::connect_async(url.as_str()).await {
      Ok((ws, _)) => {
        let (mut tx, mut rx) = ws.split();
        let register = json!({ "type": "register", "role": "browser-host", "appVersion": "shell-gate", "pid": std::process::id() });
        if tx.send(Message::Text(register.to_string().into())).await.is_err() {
          continue;
        }
        let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        loop {
          tokio::select! {
            msg = rx.next() => {
              let Some(Ok(msg)) = msg else { break };
              let Message::Text(text) = msg else { continue };
              let Ok(frame) = serde_json::from_str::<Value>(text.as_str()) else { continue };
              if frame.get("type").and_then(Value::as_str) == Some("registered") {
                log("browser", "registered as browser host");
                continue;
              }
              let (Some(id), Some(method)) = (frame.get("id").and_then(Value::as_i64), frame.get("method").and_then(Value::as_str).map(str::to_string)) else { continue };
              let session = frame.get("sessionKey").and_then(Value::as_str).unwrap_or("").to_string();
              let args = frame.get("args").and_then(Value::as_array).cloned().unwrap_or_default();
              let (browser, out) = (browser.clone(), out_tx.clone());
              tokio::task::spawn_blocking(move || {
                let started = std::time::Instant::now();
                let reply = match browser.handle(&method, &session, &args) {
                  Ok(result) => json!({ "id": id, "ok": true, "result": result }),
                  Err(e) => json!({ "id": id, "ok": false, "error": { "name": e.name, "message": e.message } }),
                };
                log("browser", &format!("rpc {method} -> ok={} in {} ms", reply["ok"], started.elapsed().as_millis()));
                let _ = out.send(reply.to_string());
              });
            }
            Some(text) = out_rx.recv() => { if tx.send(Message::Text(text.into())).await.is_err() { break } }
            Some(ev) = events.recv() => { if tx.send(Message::Text(ev.to_string().into())).await.is_err() { break } }
          }
        }
        log("browser", "host channel closed");
      }
      Err(e) => log("browser", &format!("host channel connect failed: {e}")),
    }
    tokio::time::sleep(Duration::from_millis(1500)).await;
  }
}
