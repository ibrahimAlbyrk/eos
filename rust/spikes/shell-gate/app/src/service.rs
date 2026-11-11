// What answers the dashboard on its own origin, in process.
//
//   http://eos.localhost/                index.html (+ bridge script tag, CSP header)
//   http://eos.localhost/assets/...      the built dashboard (app/ui/dist)
//   http://eos.localhost/_core/...       the core's router   (gate: proxied to the isolated daemon)
//   http://eos.localhost/_shell/...      the shell's bridges (Rust, this file)
//   http://eos.localhost/plugins/...     plugin builds       (gate: daemon /ui/plugins/...)
//   http://raw.eos.localhost/...         raw-content origin  (gate: proxied to the daemon's raw port)
use std::{
  path::PathBuf,
  sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicU64, Ordering},
  },
  time::Duration,
};

use serde_json::{Value, json};
use tauri::Url;

use crate::{
  browser::Browser,
  log,
  transport::{Head, Req, Service, Sink},
};

pub const APP_HOST: &str = "eos.localhost";
pub const RAW_HOST: &str = "raw.eos.localhost";
const BRIDGE_JS: &str = include_str!("bridge.js");

pub struct Cfg {
  pub api_base: String,
  pub raw_base: String,
  pub ui_dist: PathBuf,
  pub ui_token: String,
  /// JSON object of localStorage keys carried over from the Electron profile, if any.
  pub ls_seed: Option<String>,
  pub out: PathBuf,
}

pub struct GateService {
  pub cfg: Cfg,
  pub rt: tokio::runtime::Handle,
  client: reqwest::Client,
  pub browser: OnceLock<Arc<Browser>>,
  pub window: OnceLock<tauri::Window>,
  event_sinks: Mutex<Vec<Sink>>,
  pub proxied: AtomicU64,
  pub shell_calls: AtomicU64,
  pub log: Mutex<Vec<Value>>,
}

fn mime(path: &str) -> &'static str {
  match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
    "html" => "text/html",
    "js" | "mjs" => "text/javascript",
    "css" => "text/css",
    "json" | "map" => "application/json",
    "svg" => "image/svg+xml",
    "png" => "image/png",
    "jpg" | "jpeg" => "image/jpeg",
    "gif" => "image/gif",
    "webp" => "image/webp",
    "woff2" => "font/woff2",
    "woff" => "font/woff",
    "ico" => "image/x-icon",
    "wasm" => "application/wasm",
    _ => "application/octet-stream",
  }
}

fn csp() -> String {
  let raw = format!("http://{RAW_HOST}");
  [
    "default-src 'self'".to_string(),
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'".into(),
    "style-src 'self' 'unsafe-inline'".into(),
    format!("img-src 'self' data: blob: {raw} https://img.logo.dev"),
    "font-src 'self' data:".into(),
    "connect-src 'self'".into(),
    format!("frame-src 'self' {raw}"),
    "worker-src 'self' blob:".into(),
    format!("media-src 'self' data: blob: {raw}"),
    "object-src 'none'".into(),
  ]
  .join("; ")
}

fn h(k: &str, v: &str) -> (String, String) {
  (k.to_string(), v.to_string())
}

impl GateService {
  pub fn new(cfg: Cfg, rt: tokio::runtime::Handle) -> Arc<Self> {
    Arc::new(GateService {
      cfg,
      rt,
      client: reqwest::Client::builder().pool_max_idle_per_host(8).build().expect("http client"),
      browser: OnceLock::new(),
      window: OnceLock::new(),
      event_sinks: Default::default(),
      proxied: AtomicU64::new(0),
      shell_calls: AtomicU64::new(0),
      log: Default::default(),
    })
  }

  /// Shell → page event (the bridge script holds one EventSource on /_shell/events).
  pub fn emit(&self, name: &str, payload: Value) {
    let frame = format!("data: {}\n\n", json!({ "name": name, "payload": payload }));
    self.event_sinks.lock().unwrap().retain(|sink| sink.chunk(frame.as_bytes()));
  }

  fn serve_static(&self, path: &str, sink: Sink) {
    let rel = if path == "/" || path.is_empty() { "index.html" } else { path.trim_start_matches('/') };
    let rel = percent_decode(rel);
    let root = &self.cfg.ui_dist;
    let full = root.join(&rel);
    // Containment: only the root itself or paths beneath it.
    let ok = full.canonicalize().ok().filter(|p| root.canonicalize().is_ok_and(|r| p.starts_with(r)));
    let Some(full) = ok else {
      return sink.respond(404, vec![h("content-type", "text/plain")], b"not found");
    };
    match std::fs::read(&full) {
      Ok(bytes) if rel == "index.html" => {
        // The bridge script must run before the app's own scripts: first thing in <head>.
        let html = String::from_utf8_lossy(&bytes);
        let tag = "<script src=\"/_shell/bridge.js\"></script>";
        let html = match html.find("<head>") {
          Some(i) => format!("{}{}{}", &html[..i + 6], tag, &html[i + 6..]),
          None => format!("{tag}{html}"),
        };
        sink.respond(
          200,
          vec![h("content-type", "text/html; charset=utf-8"), h("content-security-policy", &csp()), h("cache-control", "no-store")],
          html.as_bytes(),
        );
      }
      Ok(bytes) => sink.respond(200, vec![h("content-type", mime(&rel)), h("cache-control", "no-cache")], &bytes),
      Err(_) => sink.respond(404, vec![h("content-type", "text/plain")], b"not found"),
    }
  }

  fn proxy(self: &Arc<Self>, target: String, req: Req, sink: Sink) {
    self.proxied.fetch_add(1, Ordering::Relaxed);
    let client = self.client.clone();
    self.rt.spawn(async move {
      let method = reqwest::Method::from_bytes(req.method.as_bytes()).unwrap_or(reqwest::Method::GET);
      let mut rb = client.request(method, &target);
      for (k, v) in &req.headers {
        match k.to_ascii_lowercase().as_str() {
          // The daemon's CORS gate knows the Electron origin; the page is same-origin here.
          "origin" => rb = rb.header("origin", "eos://app"),
          "host" | "referer" | "accept-encoding" | "connection" | "content-length" | "cookie" => {}
          lower if lower.starts_with("sec-") => {}
          _ => rb = rb.header(k.as_str(), v.as_str()),
        }
      }
      if !req.body.is_empty() {
        rb = rb.body(req.body);
      }
      let resp = tokio::select! {
        r = rb.send() => r,
        _ = sink.cancelled() => return,
      };
      let mut resp = match resp {
        Ok(r) => r,
        Err(e) => return sink.respond(502, vec![h("content-type", "text/plain")], format!("upstream: {e}").as_bytes()),
      };
      let headers = resp
        .headers()
        .iter()
        .filter(|(k, _)| {
          let k = k.as_str();
          !matches!(k, "transfer-encoding" | "connection" | "keep-alive") && !k.starts_with("access-control-")
        })
        .filter_map(|(k, v)| Some((k.as_str().to_string(), v.to_str().ok()?.to_string())))
        .collect();
      sink.head(Head { status: resp.status().as_u16(), headers });
      loop {
        tokio::select! {
          chunk = resp.chunk() => match chunk {
            Ok(Some(bytes)) => { if !sink.chunk_async(&bytes).await { break } }
            _ => { sink.end(); break }
          },
          // The page dropped the request (EventSource closed, navigation): drop upstream too.
          _ = sink.cancelled() => break,
        }
      }
    });
  }

  fn shell(self: &Arc<Self>, path: &str, query: &str, req: Req, sink: Sink) {
    self.shell_calls.fetch_add(1, Ordering::Relaxed);
    let json_ok = |sink: &Sink, value: Value| sink.respond(200, vec![h("content-type", "application/json")], json!({ "value": value }).to_string().as_bytes());
    match path {
      "bridge.js" => {
        let cfg = json!({
          "daemonUrl": format!("http://{APP_HOST}/_core"),
          "rawUrl": format!("http://{RAW_HOST}"),
          "uiToken": self.cfg.ui_token,
          "lsSeed": self.cfg.ls_seed.as_deref().and_then(|s| serde_json::from_str::<Value>(s).ok()),
        });
        // ASCII-only: a script's encoding follows its document unless a charset says so,
        // and the carried-over localStorage values are not all ASCII.
        let js = BRIDGE_JS.replace("__CFG__", &ascii_json(&cfg));
        return sink.respond(200, vec![h("content-type", "text/javascript; charset=utf-8"), h("cache-control", "no-store")], js.as_bytes());
      }
      "ping" => return sink.respond(200, vec![h("content-type", "text/plain")], b"ok"),
      // The bridge script alone, without the dashboard: lets a test read what the one-time
      // localStorage carry-over wrote, before any app code touches it.
      "seed-check.html" => {
        return sink.respond(
          200,
          vec![h("content-type", "text/html; charset=utf-8"), h("cache-control", "no-store")],
          b"<!doctype html><meta charset=\"utf-8\"><title>seed check</title><script src=\"/_shell/bridge.js\"></script>",
        );
      }
      // ---- transport proofs, answered here with no proxy behind them
      "test/sse" | "test/chunks" => {
        let sse = path == "test/sse";
        sink.head(Head {
          status: 200,
          headers: vec![h("content-type", if sse { "text/event-stream" } else { "application/octet-stream" }), h("cache-control", "no-cache")],
        });
        self.rt.spawn(async move {
          for i in 0..15 {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let chunk = if sse { format!("data: {i}\n\n") } else { format!("chunk-{i};") };
            if !sink.chunk(chunk.as_bytes()) {
              return;
            }
          }
          sink.end();
        });
        return;
      }
      "test/range.bin" => {
        let all: Vec<u8> = (0..=255u8).collect();
        let range = req
          .header("range")
          .and_then(|r| r.strip_prefix("bytes="))
          .and_then(|r| r.split_once('-'))
          .and_then(|(a, b)| Some((a.parse::<usize>().ok()?, b.parse::<usize>().unwrap_or(255).min(255))))
          .filter(|(a, b)| a <= b);
        return match range {
          Some((a, b)) => sink.respond(
            206,
            vec![h("content-type", "application/octet-stream"), h("accept-ranges", "bytes"), h("content-range", &format!("bytes {a}-{b}/256"))],
            &all[a..=b],
          ),
          None => sink.respond(200, vec![h("content-type", "application/octet-stream"), h("accept-ranges", "bytes")], &all),
        };
      }
      "test/echo" => {
        let sum: u64 = req.body.iter().map(|b| *b as u64).sum();
        let body = json!({ "method": req.method, "bytes": req.body.len(), "sum": sum, "contentType": req.header("content-type") });
        return sink.respond(200, vec![h("content-type", "application/json")], body.to_string().as_bytes());
      }
      "events" => {
        if !query.contains(&format!("t={}", self.cfg.ui_token)) {
          return sink.respond(403, vec![], b"");
        }
        sink.head(Head { status: 200, headers: vec![h("content-type", "text/event-stream"), h("cache-control", "no-cache")] });
        sink.chunk(b": hello\n\n");
        self.event_sinks.lock().unwrap().push(sink);
        return;
      }
      _ => {}
    }
    // Everything below is a bridge call: this Mac's dashboard only.
    if req.header("x-eos-ui-token") != Some(self.cfg.ui_token.as_str()) {
      return sink.respond(403, vec![h("content-type", "application/json")], br#"{"error":"ui token required"}"#);
    }
    let body: Value = serde_json::from_slice(&req.body).unwrap_or(Value::Null);
    let me = self.clone();
    let path = path.to_string();
    // Off CEF's IO thread: bridge calls reach into the window and the views.
    self.rt.spawn_blocking(move || {
      let num = |k: &str| body.get(k).and_then(Value::as_f64).unwrap_or(0.);
      let flag = || body.get("value").and_then(Value::as_bool).unwrap_or(false);
      let browser = me.browser.get();
      let value = match path.as_str() {
        "hosts/list" => json!({ "hosts": [], "active": null, "local": { "id": "shell-gate", "name": "This Mac (shell gate)" } }),
        "browserView/setActiveView" => {
          if let Some(b) = browser {
            b.set_active_view(body["sessionKey"].as_str().unwrap_or(""), body["tabId"].as_str().unwrap_or(""));
          }
          Value::Null
        }
        "browserView/setBounds" => {
          if let Some(b) = browser {
            b.set_bounds(body.get("seq").and_then(Value::as_u64).unwrap_or(0), num("x"), num("y"), num("width"), num("height"));
          }
          Value::Null
        }
        "browserView/setVisible" | "browserView/overlay" | "browserView/occluded" => {
          if let Some(b) = browser {
            b.set_flag(match path.as_str() { "browserView/setVisible" => "visible", "browserView/overlay" => "overlay", _ => "occluded" }, flag());
          }
          Value::Null
        }
        "browserView/snapshot" => browser.map(|b| b.snapshot()).unwrap_or(Value::Null),
        "window/startDragging" => {
          let r = me.window.get().map(|w| w.start_dragging().map_err(|e| e.to_string()));
          json!(format!("{r:?}"))
        }
        "window/toggleMaximize" => {
          if let Some(w) = me.window.get() {
            let max = w.is_maximized().unwrap_or(false);
            let _ = if max { w.unmaximize() } else { w.maximize() };
          }
          Value::Null
        }
        "artifacts/state" => json!("idle"),
        "artifacts/account" => json!({ "signedIn": false }),
        "pasteboard/paths" => json!([]),
        _ => {
          // notify, theme/*, artifacts/*, saveFile…: recorded, not acted on in the gate.
          me.log.lock().unwrap().push(json!({ "bridge": path, "body": body }));
          Value::Null
        }
      };
      json_ok(&sink, value);
    });
  }
}

/// JSON with every non-ASCII character written as a \\uXXXX escape.
fn ascii_json(value: &Value) -> String {
  let mut out = String::new();
  for c in value.to_string().chars() {
    if c.is_ascii() {
      out.push(c);
    } else {
      let mut units = [0u16; 2];
      for unit in c.encode_utf16(&mut units) {
        out.push_str(&format!("\\u{unit:04x}"));
      }
    }
  }
  out
}

fn percent_decode(s: &str) -> String {
  let bytes = s.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut i = 0;
  while i < bytes.len() {
    if bytes[i] == b'%' && i + 2 < bytes.len() {
      if let Ok(v) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16) {
        out.push(v);
        i += 3;
        continue;
      }
    }
    out.push(bytes[i]);
    i += 1;
  }
  String::from_utf8_lossy(&out).into_owned()
}

pub struct Router(pub Arc<GateService>);

impl Service for Router {
  fn call(&self, req: Req, sink: Sink) {
    let me = &self.0;
    let Ok(url) = Url::parse(&req.url) else {
      return sink.respond(400, vec![], b"bad url");
    };
    let path = url.path().to_string();
    let query = url.query().map(|q| format!("?{q}")).unwrap_or_default();
    if url.host_str() == Some(RAW_HOST) {
      return me.proxy(format!("{}{path}{query}", me.cfg.raw_base), req, sink);
    }
    if let Some(rest) = path.strip_prefix("/_core") {
      // Gate rule: the isolated daemon must never run an agent (no model calls). Writes pass
      // only for the browser panel and directory watches; everything else is refused here.
      let write = !matches!(req.method.as_str(), "GET" | "HEAD" | "OPTIONS");
      let allowed = rest.starts_with("/browser/") || rest == "/fs/watch" || rest == "/fs/unwatch";
      if write && !allowed && std::env::var_os("GATE_ALLOW_WRITES").is_none() {
        me.log.lock().unwrap().push(json!({ "blockedWrite": format!("{} {rest}", req.method) }));
        return sink.respond(403, vec![h("content-type", "application/json")], br#"{"error":"shell gate: writes to the daemon are blocked"}"#);
      }
      return me.proxy(format!("{}{rest}{query}", me.cfg.api_base), req, sink);
    }
    if let Some(rest) = path.strip_prefix("/_shell/") {
      return me.shell(rest, &query, req, sink);
    }
    if path.starts_with("/plugins/") {
      return me.proxy(format!("{}/ui{path}", me.cfg.api_base), req, sink);
    }
    if req.method != "GET" && req.method != "HEAD" {
      log("service", &format!("unrouted {} {}", req.method, path));
      return sink.respond(405, vec![], b"");
    }
    me.serve_static(&path, sink);
  }
}
