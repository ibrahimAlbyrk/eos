//! A scripted run over the shell's view ports, for the smoke test and one-off probes: the
//! steps create their own test views and drive only those, over the DevTools protocol. The
//! dashboard is never driven; it can only be captured.
//!
//! The steps file is a JSON array of objects with one key each:
//! `{"create": {"as": "v", "profile": "p", "url": "…"}}`, `{"wait": 500}`,
//! `{"cdp": {"view": "v", "method": "…", "params": {…}}}`,
//! `{"place": {"view": "v", "rect": [x, y, w, h]}}`, `{"park": "v"}`, `{"close": "v"}`,
//! `{"capture": {"view": "v" | null, "file": "/abs/path.png"}}`,
//! `{"allow": {"view": "v", "host": "192.168.1.20"}}` (the user asked this view for a page
//! on that host), `{"notify": {"title": "…", "body": "…", "route": "memory"}}` (a banner, as
//! the core would ask for one),
//! `{"browser": {"method": "POST", "path": "/browser/tabs", "body": {…}, "agent": "w-…",
//! "tab": "t"}}`: a browser route of the Rust core, called in process as the user's window
//! (or as the agent `agent` names). Only `/browser/…` paths and a plugin's preview
//! (`/api/plugins/<id>/preview`): nothing else of the core can be reached from a script. `tab` remembers the answer's `tabId` (or its first tab's);
//! `{t}` in a later path stands for it. `retry_ms` asks again until the answer names a tab.
//! The step's value is `{"status": …, "body": …}`.
//! `{"artifacts": {"verb": "warm", "body": {…}}}`: an `eosArtifacts` call as the dashboard
//! makes it (`verb: "status"` reads the views' states and places; `"background": true`
//! starts it and goes on, as a sign-in that waits for its window).
//! `{"signin": {"profile": "claude-x", "method": "…", "params": {…}}}`: a DevTools call on
//! that profile's claude.ai sign-in window, `{"signin": {"profile": "claude-x", "close":
//! true}}` closes it; only while the artifact views show a local stand-in.
//! `{"hosts": {"verb": "list"}}`, `{"hosts": {"verb": "switchTo", "id": "…"}}`: the machine
//! switcher as the dashboard sees it. `{"splash": "Updating · …"}` shows the update splash,
//! `{"splash": null}` closes it.
//! The output file gets one result per step, in order.
//!
//! A responsiveness run (`tests/responsiveness.py`, with the shell's probe on) also has
//! `{"page": {"expression": "…", "await": true}}`: an expression evaluated in the dashboard
//! (the run's measuring code), `{"click": {"selector": "…", "text": "…", "index": 0}}`: a
//! trusted mouse click at the center of that element, refused unless the element is visible,
//! on top at that point and none of the controls a click must never reach (see
//! [`CLICK_TARGET`]), and `{"stalls": null}`: the UI thread's stalls since the last read.
//! There is no keyboard step. With `EOS_DEV_SCRIPT_FOLLOW=1` the steps file is JSON lines
//! that the run appends to as it goes, and each result is appended to the output file as a
//! line, until an `{"end": null}` step.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use eos_bridge::Bridge;

use eos_core::shell::{CaptureTarget, ImageFormat, Rect, ViewId, ViewSpec};
use eos_runtime::access::Caller;
use eos_runtime::http::{Method, Request};
use eos_runtime::router::Router;
use eos_shell::Ports;
use serde_json::{Value, json};

struct Run {
    bridge: Arc<Bridge>,
    ports: Ports,
    router: Option<Arc<Router>>,
    views: HashMap<String, ViewId>,
    /// Tab ids the browser steps remembered, by alias.
    tabs: HashMap<String, String>,
}

impl Run {
    fn view(&self, alias: &Value) -> Result<ViewId, String> {
        let alias = alias.as_str().unwrap_or("");
        self.views
            .get(alias)
            .cloned()
            .ok_or_else(|| format!("no view named {alias:?}: a step can only use a view this script created"))
    }

    /// One browser route of the Rust core, as the dashboard or an agent's tool would call it.
    async fn browser(&mut self, arg: &Value) -> Result<Value, String> {
        let router = self.router.as_ref().ok_or("the Rust core is not running")?;
        let text = |key: &str| arg.get(key).and_then(Value::as_str).unwrap_or("");
        let mut path = text("path").to_owned();
        for (alias, tab) in &self.tabs {
            path = path.replace(&format!("{{{alias}}}"), tab);
        }
        // The script drives the browser and has a plugin drawn; nothing else of the core.
        let preview = path.starts_with("/api/plugins/") && path.ends_with("/preview");
        if !(path.starts_with("/browser/") || preview) || path.contains("..") {
            return Err(format!("{path:?}: a script may only call the browser's routes"));
        }
        let method = Method::parse(text("method")).ok_or("no such method")?;
        let agent = text("agent");
        let caller = if agent.is_empty() { Caller::DASHBOARD } else { Caller::UNTRUSTED };
        let mut request = Request::new(method, &path, caller);
        if !agent.is_empty() {
            request = request.header("x-eos-agent-id", agent);
        }
        if let Some(body) = arg.get("body") {
            request = request.header("content-type", "application/json").body(body.to_string());
        }
        // `retry_ms`: ask again until the answer names a tab (the dashboard opens its own a
        // moment after it loads).
        let patience = Duration::from_millis(arg.get("retry_ms").and_then(Value::as_u64).unwrap_or(0).min(60_000));
        let deadline = std::time::Instant::now() + patience;
        loop {
            let response = router.handle(request.clone()).await;
            let status = response.status;
            let bytes = response.body.collect().await.map_err(|e| e.to_string())?;
            let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            let tab = body.get("tabId").or_else(|| body.pointer("/tabs/0/tabId")).and_then(Value::as_str);
            if let (Some(alias), Some(tab)) = (arg.get("tab").and_then(Value::as_str), tab) {
                self.tabs.insert(alias.to_owned(), tab.to_owned());
            }
            if tab.is_some() || std::time::Instant::now() >= deadline {
                return Ok(json!({ "status": status, "body": body }));
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    async fn step(&mut self, step: &Value) -> Result<Value, String> {
        let (name, arg) = step.as_object().and_then(|o| o.iter().next()).ok_or("a step is an object with one key")?;
        let text = |key: &str| arg.get(key).and_then(Value::as_str).unwrap_or("").to_string();
        let e = |error: eos_core::shell::ViewError| error.to_string();
        match name.as_str() {
            "wait" => {
                tokio::time::sleep(Duration::from_millis(arg.as_u64().unwrap_or(0).min(60_000))).await;
                Ok(Value::Null)
            }
            "create" => {
                let url = Some(text("url")).filter(|u| !u.is_empty());
                let id = self.ports.views.create(ViewSpec { profile: text("profile"), url }).await.map_err(e)?;
                self.views.insert(text("as"), id.clone());
                Ok(json!({ "view": id.as_str() }))
            }
            "cdp" => {
                let view = self.view(&arg["view"])?;
                self.ports
                    .views
                    .cdp(&view, &text("method"), arg.get("params").cloned().unwrap_or(json!({})))
                    .await
                    .map_err(e)
            }
            "place" => {
                let view = self.view(&arg["view"])?;
                let n = |i: usize| arg["rect"].get(i).and_then(Value::as_f64).unwrap_or(0.0);
                self.ports.views.place(&view, Rect { x: n(0), y: n(1), width: n(2), height: n(3) }).await.map_err(e)?;
                Ok(Value::Null)
            }
            "park" => {
                self.ports.views.park(&self.view(arg)?).await.map_err(e)?;
                Ok(Value::Null)
            }
            "close" => {
                let view = self.view(arg)?;
                self.ports.views.close(&view).await.map_err(e)?;
                Ok(Value::Null)
            }
            "capture" => {
                let target = if arg["view"].is_null() {
                    CaptureTarget::Dashboard
                } else {
                    CaptureTarget::View(self.view(&arg["view"])?)
                };
                let image = self.ports.capture.capture(target, ImageFormat::Png).await.map_err(e)?;
                std::fs::write(text("file"), &image.bytes).map_err(|error| error.to_string())?;
                Ok(json!({ "bytes": image.bytes.len() }))
            }
            // What the core does when the user types an address: say so, then navigate.
            "allow" => {
                self.ports.views.allow_local_network(&self.view(&arg["view"])?, &text("host")).await.map_err(e)?;
                Ok(Value::Null)
            }
            "notify" => Ok(json!(format!("{:?}", self.bridge.notify(arg)))),
            "browser" => self.browser(arg).await,
            // An `eosArtifacts` call as the dashboard makes it; `status` reads the pool.
            "artifacts" => {
                let verb = text("verb");
                if verb == "status" {
                    return Ok(self.bridge.artifact_status().await);
                }
                let body = arg.get("body").cloned().unwrap_or(json!({}));
                if arg.get("background").and_then(Value::as_bool) == Some(true) {
                    let bridge = self.bridge.clone();
                    self.ports.rt.spawn(async move { bridge.artifact_call(&verb, &body).await });
                    return Ok(Value::Null);
                }
                self.bridge.artifact_call(&verb, &body).await.ok_or_else(|| format!("no artifact verb {verb:?}"))
            }
            // The update splash, as a restart into an update shows it (`null` closes it).
            "splash" => {
                let (splash, caption) = (self.ports.splash.clone(), arg.as_str().map(str::to_owned));
                tokio::task::spawn_blocking(move || splash(caption)).await.map_err(|e| e.to_string())?;
                Ok(Value::Null)
            }
            // The machine switcher as the dashboard sees it: `list`, or `switchTo` an id.
            "hosts" => {
                let hosts = self.bridge.hosts().cloned().ok_or("no machine switcher")?;
                match text("verb").as_str() {
                    "list" => Ok(hosts.snapshot()),
                    "switchTo" => {
                        hosts.switch_to(arg.get("id").and_then(Value::as_str).map(str::to_owned)).await;
                        Ok(hosts.snapshot())
                    }
                    verb => Err(format!("no hosts verb {verb:?}")),
                }
            }
            "page" => {
                let probe = self.ports.probe.clone().ok_or("no probe in this run")?;
                let params = json!({
                    "expression": text("expression"),
                    "returnByValue": true,
                    "awaitPromise": arg.get("await").and_then(Value::as_bool).unwrap_or(false),
                });
                let answer = probe.dashboard("Runtime.evaluate", params).await?;
                if let Some(thrown) = answer.get("exceptionDetails") {
                    return Err(format!("the expression threw: {thrown}"));
                }
                Ok(answer.pointer("/result/value").cloned().unwrap_or(Value::Null))
            }
            "signin" => {
                let windows = self.ports.sign_in.as_ref().ok_or("the artifact views show claude.ai itself")?;
                let profile = text("profile");
                if arg.get("close").and_then(Value::as_bool) == Some(true) {
                    return windows.close(&profile).map(|()| Value::Null);
                }
                windows.cdp(&profile, &text("method"), arg.get("params").cloned().unwrap_or(json!({}))).await
            }
            "click" => self.click(arg).await,
            "stalls" => Ok(self.ports.probe.as_ref().ok_or("no probe in this run")?.take_stalls()),
            // A Chromium trace over the run's next steps: `{"trace": {"start": "categories"}}`,
            // then `{"trace": {"stop": "/abs/file.json"}}`.
            "trace" => {
                let probe = self.ports.probe.clone().ok_or("no probe in this run")?;
                match (arg.get("start").and_then(Value::as_str), arg.get("stop").and_then(Value::as_str)) {
                    (Some(categories), _) => probe.trace_start(categories).await,
                    (_, Some(file)) => probe.trace_stop(std::path::Path::new(file)).await,
                    _ => Err("trace: start or stop".into()),
                }
            }
            other => Err(format!("unknown step {other:?}")),
        }
    }
}

pub(crate) async fn run(steps: PathBuf, out: PathBuf, bridge: Arc<Bridge>, ports: Ports, router: Option<Arc<Router>>) {
    let mut run = Run { bridge, ports, router, views: HashMap::new(), tabs: HashMap::new() };
    if std::env::var_os("EOS_DEV_SCRIPT_FOLLOW").is_some() {
        return follow(&mut run, &steps, &out).await;
    }
    let steps: Vec<Value> =
        std::fs::read_to_string(&steps).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default();
    let mut results = Vec::new();
    let write = |results: &[Value], done: bool| {
        let _ = std::fs::write(&out, json!({ "done": done, "results": results }).to_string());
    };
    for step in &steps {
        results.push(run.timed(step).await);
        // Written after every step, so a watcher sees progress and a crash loses nothing.
        write(&results, results.len() == steps.len());
    }
    if steps.is_empty() {
        write(&results, true);
    }
}

/// How long a followed script may go without a new step before it ends by itself.
const FOLLOW_IDLE: Duration = Duration::from_secs(600);

/// Steps as JSON lines appended by the driving run, results appended the same way.
async fn follow(run: &mut Run, steps: &std::path::Path, out: &std::path::Path) {
    use std::io::Write;
    let Ok(mut results) = std::fs::OpenOptions::new().create(true).append(true).open(out) else { return };
    let (mut done, mut idle_since) = (0usize, std::time::Instant::now());
    loop {
        let text = std::fs::read_to_string(steps).unwrap_or_default();
        // Only whole lines: the last one may still be being written.
        let lines: Vec<&str> = text.split_inclusive('\n').filter(|line| line.ends_with('\n')).collect();
        if lines.len() > done {
            idle_since = std::time::Instant::now();
        } else if idle_since.elapsed() > FOLLOW_IDLE {
            return;
        }
        for line in &lines[done.min(lines.len())..] {
            done += 1;
            let step: Value = serde_json::from_str(line).unwrap_or(Value::Null);
            if step.get("end").is_some() {
                return;
            }
            let result = run.timed(&step).await;
            // One write per line, so a reader never sees half of one.
            let _ = results.write_all(format!("{result}\n").as_bytes());
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

/// Finds the element a click step names and says where its center is, or why it may not be
/// clicked. A click is a real input event: only a control that changes what is shown may get
/// one, never one that writes, sends, runs or approves anything, or takes text.
const CLICK_TARGET: &str = r#"((selector, text, index) => {
  const all = [...document.querySelectorAll(selector)].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && (!text || (el.textContent || "").includes(text) || (el.getAttribute("aria-label") || "").includes(text) || (el.getAttribute("title") || "").includes(text));
  });
  const el = all[index];
  if (!el) return { error: `no visible ${selector} ${text ? `with "${text}"` : ""} at ${index} (${all.length} found)` };
  const words = `${el.textContent || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`.slice(0, 200);
  const button = el.closest("button");
  if (el.closest("textarea, input, select") || el.isContentEditable || (button && button.form && button.type === "submit"))
    return { error: "refused: a control that takes text or submits" };
  if (/\b(send|submit|run|approve|allow|deny|delete|remove|archive|stop|kill|restart|install|uninstall|reset|discard|apply|sign (in|out)|log ?out|quit)\b/i.test(words))
    return { error: `refused: "${words.trim().slice(0, 60)}" may act` };
  const r = el.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
  const top = document.elementFromPoint(x, y);
  if (!top || !(el === top || el.contains(top))) return { error: `covered at ${x},${y} by ${top ? top.tagName + "." + top.className : "nothing"}` };
  return { x, y, label: words.trim().slice(0, 60) };
})"#;

impl Run {
    async fn timed(&mut self, step: &Value) -> Value {
        let started = std::time::Instant::now();
        match self.step(step).await {
            Ok(value) => json!({ "ok": true, "ms": started.elapsed().as_millis() as u64, "value": value }),
            Err(error) => json!({ "ok": false, "ms": started.elapsed().as_millis() as u64, "error": error }),
        }
    }

    /// A trusted left click on the dashboard element the step names.
    async fn click(&self, arg: &Value) -> Result<Value, String> {
        let probe = self.ports.probe.clone().ok_or("no probe in this run")?;
        let quoted =
            |key: &str| Value::String(arg.get(key).and_then(Value::as_str).unwrap_or("").to_owned()).to_string();
        let index = arg.get("index").and_then(Value::as_u64).unwrap_or(0);
        let expression = format!("{CLICK_TARGET}({}, {}, {index})", quoted("selector"), quoted("text"));
        let found = probe
            .dashboard("Runtime.evaluate", json!({ "expression": expression, "returnByValue": true }))
            .await?
            .pointer("/result/value")
            .cloned()
            .unwrap_or(Value::Null);
        if let Some(error) = found.get("error").and_then(Value::as_str) {
            return Err(error.to_owned());
        }
        let (Some(x), Some(y)) = (found["x"].as_f64(), found["y"].as_f64()) else {
            return Err("no position".into());
        };
        for (kind, buttons) in [("mouseMoved", 0), ("mousePressed", 1), ("mouseReleased", 0)] {
            let mut params = json!({ "type": kind, "x": x, "y": y, "button": "left", "buttons": buttons });
            if kind != "mouseMoved" {
                params["clickCount"] = json!(1);
            }
            probe.dashboard("Input.dispatchMouseEvent", params).await?;
        }
        Ok(found)
    }
}
