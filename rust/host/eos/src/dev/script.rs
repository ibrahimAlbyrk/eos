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
//! makes it (`verb: "status"` reads the views' states and places).
//! `{"hosts": {"verb": "list"}}`, `{"hosts": {"verb": "switchTo", "id": "…"}}`: the machine
//! switcher as the dashboard sees it. `{"splash": "Updating · …"}` shows the update splash,
//! `{"splash": null}` closes it.
//! The output file gets one result per step, in order.

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
            other => Err(format!("unknown step {other:?}")),
        }
    }
}

pub(crate) async fn run(steps: PathBuf, out: PathBuf, bridge: Arc<Bridge>, ports: Ports, router: Option<Arc<Router>>) {
    let steps: Vec<Value> =
        std::fs::read_to_string(&steps).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default();
    let mut run = Run { bridge, ports, router, views: HashMap::new(), tabs: HashMap::new() };
    let mut results = Vec::new();
    let write = |results: &[Value], done: bool| {
        let _ = std::fs::write(&out, json!({ "done": done, "results": results }).to_string());
    };
    for step in &steps {
        let started = std::time::Instant::now();
        let result = match run.step(step).await {
            Ok(value) => json!({ "ok": true, "ms": started.elapsed().as_millis() as u64, "value": value }),
            Err(error) => json!({ "ok": false, "ms": started.elapsed().as_millis() as u64, "error": error }),
        };
        results.push(result);
        // Written after every step, so a watcher sees progress and a crash loses nothing.
        write(&results, results.len() == steps.len());
    }
    if steps.is_empty() {
        write(&results, true);
    }
}
