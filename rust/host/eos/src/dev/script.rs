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
//! the core would ask for one).
//! The output file gets one result per step, in order.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use eos_bridge::Bridge;

use eos_core::shell::{CaptureTarget, ImageFormat, Rect, ViewId, ViewSpec};
use eos_shell::Ports;
use serde_json::{Value, json};

struct Run {
    bridge: Arc<Bridge>,
    ports: Ports,
    views: HashMap<String, ViewId>,
}

impl Run {
    fn view(&self, alias: &Value) -> Result<ViewId, String> {
        let alias = alias.as_str().unwrap_or("");
        self.views
            .get(alias)
            .cloned()
            .ok_or_else(|| format!("no view named {alias:?}: a step can only use a view this script created"))
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
            other => Err(format!("unknown step {other:?}")),
        }
    }
}

pub(crate) async fn run(steps: PathBuf, out: PathBuf, bridge: Arc<Bridge>, ports: Ports) {
    let steps: Vec<Value> =
        std::fs::read_to_string(&steps).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default();
    let mut run = Run { bridge, ports, views: HashMap::new() };
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
