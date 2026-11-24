//! The quick panel's side of the bridge: the item a door holds for it, and the page asking the
//! panel to close or to fit its content.

use serde_json::Value;

use super::{Bridge, Outcome, Refusal};
use crate::doors::{DoorItem, panel_size};
use crate::events::Surface;

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
