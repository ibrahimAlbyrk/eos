//! The DevTools protocol over CEF's in-process channel: request and answer by id, plus events.
//! No debugging port is opened.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use eos_core::shell::ViewError;
use serde_json::{Value, json};
use tauri_runtime_cef::{DevToolsProtocol, WebviewCefExt, allocate_devtools_message_id};
use tokio::sync::oneshot;

/// Long enough for a page load or a full accessibility tree; an answer never takes longer
/// unless the renderer is gone.
const TIMEOUT: Duration = Duration::from_secs(30);

type Pending = Arc<Mutex<HashMap<i32, oneshot::Sender<(bool, Vec<u8>)>>>>;

#[derive(Clone)]
pub(crate) struct Cdp {
    webview: tauri::Webview,
    pending: Pending,
}

impl Cdp {
    /// Attaches to the view; `on_event` gets every protocol event (on the main thread: it
    /// must return quickly).
    pub(crate) fn attach(
        webview: &tauri::Webview,
        on_event: impl Fn(&str, Value) + Send + Sync + 'static,
    ) -> Result<Self, ViewError> {
        let pending: Pending = Arc::default();
        let answers = pending.clone();
        webview
            .on_dev_tools_protocol(move |protocol| match protocol {
                DevToolsProtocol::MethodResult { message_id, success, result } => {
                    let waiter = answers.lock().ok().and_then(|mut p| p.remove(&message_id));
                    if let Some(waiter) = waiter {
                        let _ = waiter.send((success, result));
                    }
                }
                DevToolsProtocol::Event { method, params } => {
                    on_event(&method, serde_json::from_slice(&params).unwrap_or(Value::Null))
                }
                DevToolsProtocol::Message(_) => {}
            })
            .map_err(|e| ViewError::Shell(e.to_string()))?;
        Ok(Cdp { webview: webview.clone(), pending })
    }

    pub(crate) async fn call(&self, method: &str, params: Value) -> Result<Value, ViewError> {
        let id = allocate_devtools_message_id().map_err(|e| ViewError::Shell(e.to_string()))?;
        let (tx, rx) = oneshot::channel();
        if let Ok(mut pending) = self.pending.lock() {
            pending.insert(id, tx);
        }
        let message = json!({ "id": id, "method": method, "params": params }).to_string();
        if let Err(e) = self.webview.send_dev_tools_message(message.as_bytes()) {
            self.forget(id);
            return Err(ViewError::Shell(e.to_string()));
        }
        let (success, result) = match tokio::time::timeout(TIMEOUT, rx).await {
            Ok(Ok(answer)) => answer,
            _ => {
                self.forget(id);
                return Err(ViewError::Timeout(method.to_string()));
            }
        };
        let value: Value = serde_json::from_slice(&result).unwrap_or(Value::Null);
        if success {
            Ok(value)
        } else {
            let message =
                value.get("message").and_then(Value::as_str).map_or_else(|| value.to_string(), str::to_string);
            Err(ViewError::Cdp { method: method.to_string(), message })
        }
    }

    fn forget(&self, id: i32) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&id);
        }
    }
}
