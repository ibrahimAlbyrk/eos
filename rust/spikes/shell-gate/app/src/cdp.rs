// DevTools Protocol over CEF's in-process channel: request/response by id, plus events.
// Never call `call` on the main thread: answers are delivered there.
use std::{
  collections::HashMap,
  path::Path,
  sync::{Arc, Mutex, mpsc},
  time::{Duration, Instant},
};

use base64::Engine;
use serde_json::{Value, json};
use tauri_runtime_cef::{DevToolsProtocol, WebviewCefExt, allocate_devtools_message_id};

type EventFn = dyn Fn(&str, &Value) + Send + Sync;

#[derive(Clone)]
pub struct Cdp {
  webview: tauri::Webview,
  pending: Arc<Mutex<HashMap<i32, mpsc::Sender<(bool, Vec<u8>)>>>>,
  listeners: Arc<Mutex<Vec<Arc<EventFn>>>>,
}

impl Cdp {
  pub fn attach(webview: &tauri::Webview) -> Result<Self, String> {
    let cdp = Cdp { webview: webview.clone(), pending: Default::default(), listeners: Default::default() };
    let pending = cdp.pending.clone();
    let listeners = cdp.listeners.clone();
    webview
      .on_dev_tools_protocol(move |protocol| match protocol {
        DevToolsProtocol::MethodResult { message_id, success, result } => {
          if let Some(tx) = pending.lock().unwrap().remove(&message_id) {
            let _ = tx.send((success, result));
          }
        }
        DevToolsProtocol::Event { method, params } => {
          let list: Vec<Arc<EventFn>> = listeners.lock().unwrap().clone();
          if list.is_empty() {
            return;
          }
          let params: Value = serde_json::from_slice(&params).unwrap_or(Value::Null);
          for l in list {
            l(&method, &params);
          }
        }
        DevToolsProtocol::Message(_) => {}
      })
      .map_err(|e| e.to_string())?;
    Ok(cdp)
  }

  pub fn on_event(&self, f: impl Fn(&str, &Value) + Send + Sync + 'static) {
    self.listeners.lock().unwrap().push(Arc::new(f));
  }

  pub fn call_timeout(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
    let id = allocate_devtools_message_id().map_err(|e| e.to_string())?;
    let (tx, rx) = mpsc::channel();
    self.pending.lock().unwrap().insert(id, tx);
    let message = json!({ "id": id, "method": method, "params": params }).to_string();
    self.webview.send_dev_tools_message(message.as_bytes()).map_err(|e| e.to_string())?;
    let (success, result) = rx.recv_timeout(timeout).map_err(|_| {
      self.pending.lock().unwrap().remove(&id);
      format!("{method}: no CDP answer in {} ms", timeout.as_millis())
    })?;
    let value: Value = serde_json::from_slice(&result).unwrap_or(Value::Null);
    if success { Ok(value) } else { Err(format!("{method}: {value}")) }
  }

  pub fn call(&self, method: &str, params: Value) -> Result<Value, String> {
    self.call_timeout(method, params, Duration::from_secs(8))
  }

  /// Runtime.evaluate in the main world, by value, awaiting promises.
  pub fn eval(&self, expression: &str) -> Result<Value, String> {
    let v = self.call(
      "Runtime.evaluate",
      json!({ "expression": expression, "returnByValue": true, "awaitPromise": true }),
    )?;
    if let Some(ex) = v.get("exceptionDetails") {
      return Err(
        ex.pointer("/exception/description")
          .and_then(Value::as_str)
          .unwrap_or_else(|| ex.get("text").and_then(Value::as_str).unwrap_or("evaluate failed"))
          .to_string(),
      );
    }
    Ok(v.pointer("/result/value").cloned().unwrap_or(Value::Null))
  }

  pub fn screenshot(&self, path: &Path, format: &str, timeout: Duration) -> Result<Value, String> {
    let start = Instant::now();
    let v = self.call_timeout("Page.captureScreenshot", json!({ "format": format, "quality": 85 }), timeout)?;
    let data = v.get("data").and_then(Value::as_str).unwrap_or("");
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())?;
    let n = bytes.len();
    std::fs::write(path, bytes).map_err(|e| e.to_string())?;
    Ok(json!({ "bytes": n, "ms": start.elapsed().as_millis() as u64, "file": path.to_string_lossy() }))
  }
}
