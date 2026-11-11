//! The app half of the daemon's `/browser/host` control channel: the shell connects, registers
//! as the browser host, answers the daemon's port verbs from the [`Driver`] and pushes tab
//! events back. One frame per verb.

use std::sync::Arc;
use std::time::Duration;

use eos_core::shell::FilePicker;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

use super::driver::Driver;

const RECONNECT: Duration = Duration::from_millis(1500);
/// Replies waiting for the socket; the daemon sends one verb at a time per tab.
const REPLY_QUEUE: usize = 64;

pub struct HostChannel {
    /// `ws://…/browser/host?uiToken=…` — holds the token, never logged.
    pub url: String,
    pub driver: Arc<Driver>,
    pub picker: Arc<dyn FilePicker>,
    pub app_version: String,
}

impl std::fmt::Debug for HostChannel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostChannel").finish_non_exhaustive()
    }
}

/// The reply frame for one verb.
async fn answer(channel: &HostChannel, frame: &Value) -> Option<Value> {
    let id = frame.get("id").and_then(Value::as_i64)?;
    let method = frame.get("method").and_then(Value::as_str)?;
    let session = frame.get("sessionKey").and_then(Value::as_str).unwrap_or("");
    let args = frame.get("args").and_then(Value::as_array).cloned().unwrap_or_default();
    let result = match method {
        "dialog.pickDirectory" => Ok(json!(channel.picker.pick_directory().await)),
        "dialog.pickFiles" => Ok(json!(channel.picker.pick_files().await)),
        // The location helper and the plugin preview come in later phases.
        "location.get" | "plugin.preview" => Err(("Error", format!("{method}: not available in this shell yet"))),
        _ => channel.driver.handle(method, session, &args).await.map_err(|e| (e.name, e.message)),
    };
    Some(match result {
        Ok(result) => json!({ "id": id, "ok": true, "result": result }),
        Err((name, message)) => json!({ "id": id, "ok": false, "error": { "name": name, "message": message } }),
    })
}

/// Keeps the channel up until the runtime stops: reconnects after a drop.
pub fn spawn_host_channel(
    channel: HostChannel,
    mut events: tokio::sync::mpsc::Receiver<Value>,
    rt: &tokio::runtime::Handle,
) {
    let channel = Arc::new(channel);
    rt.spawn(async move {
        loop {
            if let Ok((socket, _)) = tokio_tungstenite::connect_async(channel.url.as_str()).await {
                let (mut tx, mut rx) = socket.split();
                let register = json!({ "type": "register", "role": "browser-host", "appVersion": channel.app_version, "pid": std::process::id() });
                if tx.send(Message::Text(register.to_string().into())).await.is_ok() {
                    let (reply_tx, mut reply_rx) = tokio::sync::mpsc::channel::<String>(REPLY_QUEUE);
                    loop {
                        tokio::select! {
                            message = rx.next() => {
                                let Some(Ok(message)) = message else { break };
                                let Message::Text(text) = message else { continue };
                                let Ok(frame) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                                let (channel, reply_tx) = (channel.clone(), reply_tx.clone());
                                tokio::spawn(async move {
                                    if let Some(reply) = answer(&channel, &frame).await {
                                        let _ = reply_tx.send(reply.to_string()).await;
                                    }
                                });
                            }
                            Some(text) = reply_rx.recv() => {
                                if tx.send(Message::Text(text.into())).await.is_err() {
                                    break;
                                }
                            }
                            Some(event) = events.recv() => {
                                if tx.send(Message::Text(event.to_string().into())).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                }
            }
            tokio::time::sleep(RECONNECT).await;
        }
    });
}
