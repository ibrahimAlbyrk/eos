//! The quick panel's side of the bridge: the item a door holds for it, and the page asking the
//! panel to close or to fit its content.

use serde_json::{Value, json};

use super::{Bridge, Outcome, Refusal};
use crate::doors::{DoorItem, panel_size, valid_accelerator};
use crate::events::Surface;
use crate::host::Shortcut;

impl Bridge {
    /// Holds what a door brought for the quick panel. A panel already open hears it at once
    /// (`doors:held`); showing the panel is the shell's.
    pub fn hold(&self, item: DoorItem) {
        // The source, kinds and counts only: never what the item holds.
        tracing::info!(target: "eos::doors", item = %item.describe(), "a door handed the quick panel an item");
        let payload = item.to_json();
        self.held.hold(item);
        self.events.emit_to(Surface::Quick, "doors:held", payload);
    }

    /// The panel closed, whatever closed it: the item it held goes, and its page lets go of it.
    pub fn panel_closed(&self) {
        self.held.drop_item();
        self.events.emit_to(Surface::Quick, "doors:held", Value::Null);
    }

    /// `GET /_shell/doors/held`: the held item, or `null`.
    pub(super) fn held_item(&self) -> Value {
        self.held.read()
    }

    /// `GET /_shell/doors/shortcut` answers the shortcut as it holds; `PUT {accelerator}` asks
    /// for another. `{available: false}` where this app owns no door.
    pub(super) async fn shortcut_call(&self, put: bool, body: &Value) -> Outcome {
        let asked = if put {
            let accelerator = body.get("accelerator").and_then(Value::as_str).unwrap_or("").trim().to_owned();
            if !valid_accelerator(&accelerator) {
                return Err(Refusal(400, "a shortcut is modifiers and one key"));
            }
            Some(accelerator)
        } else {
            None
        };
        let held = self
            .blocking_value(move |host| {
                let held = match &asked {
                    Some(accelerator) => host.set_shortcut(accelerator),
                    None => host.shortcut(),
                };
                held.map_or_else(|| json!({ "available": false }), |s| shortcut_json(&s))
            })
            .await?;
        Ok(held)
    }

    /// `GET /_shell/doors/accessibility` answers `{available, trusted}`; `POST` with `{prompt:
    /// true}` raises the system's request, with `{openSettings: true}` opens its pane.
    pub(super) async fn accessibility_call(&self, post: bool, body: &Value) -> Outcome {
        let ask = match (body.get("prompt"), body.get("openSettings")) {
            _ if !post => None,
            (Some(Value::Bool(true)), _) => Some(true),
            (_, Some(Value::Bool(true))) => Some(false),
            _ => return Err(Refusal(400, "prompt or openSettings required")),
        };
        self.blocking_value(move |host| {
            let Some(trusted) = host.accessibility() else { return json!({ "available": false }) };
            if let Some(prompt) = ask {
                host.ask_accessibility(prompt);
            }
            json!({ "available": true, "trusted": trusted })
        })
        .await
    }

    /// `POST /_shell/doors/panel` with `{close: true}` or `{size: {width, height}}`.
    pub(super) async fn panel_call(&self, body: &Value) -> Outcome {
        if body.get("close").and_then(Value::as_bool) == Some(true) {
            return self.blocking(|host| host.close_panel()).await;
        }
        let size = body.get("size").ok_or(Refusal(400, "close or size required"))?;
        let n = |key: &str| size.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN);
        let (width, height) = panel_size(n("width"), n("height")).ok_or(Refusal(400, "width and height required"))?;
        self.blocking(move |host| host.size_panel(width, height)).await
    }
}

fn shortcut_json(shortcut: &Shortcut) -> Value {
    let mut answer = json!({ "available": true, "accelerator": shortcut.accelerator, "held": shortcut.held });
    if let Some(problem) = &shortcut.problem {
        answer["problem"] = json!(problem);
    }
    answer
}
