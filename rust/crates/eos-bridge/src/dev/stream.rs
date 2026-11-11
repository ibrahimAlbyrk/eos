//! The daemon's notifications, read from its event stream and shown as native banners.
//! With the core in process this is a direct call; here it is one long-lived request.

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use super::proxy::DevDaemonConfig;
use crate::Bridge;

const TOPIC: &str = "notification:fire";

/// What one line of the stream asks for: the payload of a `notification:fire` frame.
fn notification(line: &str) -> Option<Value> {
    let json = line.strip_prefix("data:")?.trim();
    // Most frames are something else: skip them without parsing.
    if !json.contains(TOPIC) {
        return None;
    }
    let frame: Value = serde_json::from_str(json).ok()?;
    (frame.get("reason").and_then(Value::as_str) == Some(TOPIC))
        .then(|| frame.get("payload").cloned().unwrap_or(Value::Null))
}

/// Follows the stream until the runtime stops, reconnecting with a growing pause.
pub fn spawn_notifications(config: DevDaemonConfig, bridge: Arc<Bridge>, rt: &tokio::runtime::Handle) {
    rt.spawn(async move {
        let Ok(client) = reqwest::Client::builder().no_proxy().build() else { return };
        let url = format!("{}/stream?topics={TOPIC}", config.api_base.trim_end_matches('/'));
        let mut pause = Duration::from_millis(250);
        loop {
            let request =
                client.get(&url).header("accept", "text/event-stream").header("x-eos-ui-token", &config.ui_token);
            if let Ok(mut response) = request.send().await
                && response.status().is_success()
            {
                pause = Duration::from_millis(250);
                let mut pending = Vec::new();
                while let Ok(Some(chunk)) = response.chunk().await {
                    pending.extend_from_slice(&chunk);
                    while let Some(end) = pending.iter().position(|b| *b == b'\n') {
                        let line: Vec<u8> = pending.drain(..=end).collect();
                        if let Some(payload) = notification(String::from_utf8_lossy(&line).trim()) {
                            bridge.notify(&payload);
                        }
                    }
                    // A line this long is not a notification.
                    if pending.len() > 1 << 20 {
                        pending.clear();
                    }
                }
            }
            tokio::time::sleep(pause).await;
            pause = (pause * 2).min(Duration::from_secs(5));
        }
    });
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn only_notification_frames_are_read() {
        let line =
            r#"data: {"reason":"notification:fire","payload":{"title":"Input needed","body":"Pick","workerId":"w1"}}"#;
        assert_eq!(notification(line), Some(json!({ "title": "Input needed", "body": "Pick", "workerId": "w1" })));
        assert_eq!(notification(r#"data: {"reason":"worker:update","payload":{"note":"notification:fire"}}"#), None);
        assert_eq!(notification(r#"data: {"reason":"agent:delta","payload":{}}"#), None);
        assert_eq!(notification("id: 12"), None);
        assert_eq!(notification(": ping"), None);
        assert_eq!(notification("data: notification:fire but not json"), None);
    }
}
