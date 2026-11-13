//! One connected phone: what it listed, what it shows, where its transcript
//! push stands (`manager/remote/gateway.ts`, the per-connection state).

use std::collections::HashSet;
use std::sync::Arc;

use eos_contracts::{ControlFrame, FocusFrame};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::{Semaphore, mpsc};

/// The fields of a bus payload the focus rules look at. A field that is
/// absent and one that is `null` are different things to today's rules
/// (`===`), so both are kept apart.
#[derive(Debug, Default, Deserialize)]
pub(crate) struct PayloadKeys {
    #[serde(default, rename = "workerId", deserialize_with = "present")]
    pub(crate) worker_id: Option<Value>,
    #[serde(default, rename = "sessionId", deserialize_with = "present")]
    pub(crate) session_id: Option<Value>,
}

fn present<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

impl PayloadKeys {
    /// Reads the two keys; a payload that is not an object has neither.
    pub(crate) fn of(payload: &[u8]) -> Self {
        serde_json::from_slice(payload).unwrap_or_default()
    }

    /// The worker id, when it is a string.
    pub(crate) fn worker(&self) -> Option<&str> {
        self.worker_id.as_ref().and_then(Value::as_str)
    }

    /// The session id as JavaScript's `String(…)` writes it.
    fn session_text(&self) -> String {
        match &self.session_id {
            None => "undefined".to_owned(),
            Some(Value::String(id)) => id.clone(),
            Some(other) => other.to_string(),
        }
    }
}

/// `payload === focus`, for a payload field and a focus field.
fn same(payload: &Option<Value>, focus: &Option<Option<String>>) -> bool {
    match (payload, focus) {
        (None, None) | (Some(Value::Null), Some(None)) => true,
        (Some(Value::String(a)), Some(Some(b))) => a == b,
        _ => false,
    }
}

/// What a phone gets as events once it said what it shows; the rest reaches
/// it as patches or not at all.
fn on_screen(topic: &str, focus: &FocusFrame, keys: &PayloadKeys, rows: bool, pty_subs: &HashSet<String>) -> bool {
    match topic {
        "agent:delta" | "terminal:chunk" | "terminal:done" => same(&keys.worker_id, &focus.worker),
        // Only a phone that does not take pushed rows fetches the transcript on this nudge.
        "worker:change" => !rows && same(&keys.worker_id, &focus.worker),
        "pty:session" | "pty:exit" => true,
        "pty:conversation" => same(&keys.session_id, &focus.pty) || pty_subs.contains(&keys.session_text()),
        _ => false,
    }
}

#[derive(Debug)]
pub(crate) struct Device {
    /// Tells this connection from an earlier one of the same id.
    pub(crate) generation: u64,
    pub(crate) hex: String,
    /// What the phone listed in its last hello.
    pub(crate) caps: HashSet<String>,
    /// What the phone shows; `None` until it says (an older app gets every event).
    pub(crate) focus: Option<FocusFrame>,
    /// The terminals whose raw output this phone shows.
    pub(crate) pty_subs: HashSet<String>,
    /// The snapshot sent on join answers the phone's first hello.
    pub(crate) boot_snapshot: bool,
    pub(crate) hello_seen: bool,
    /// Pushed transcript rows: the open worker, and the newest row id the
    /// phone holds for it (`None` until it says).
    pub(crate) rows_worker: Option<String>,
    pub(crate) rows_cursor: Option<i64>,
    pub(crate) pulling: bool,
    pub(crate) pull_again: bool,
    /// When the phone last sent anything: its keepalive every 20 s counts.
    pub(crate) last_activity: i64,
    /// The link fell behind while frames for this phone were due. Nothing
    /// more is sent to it until a fresh snapshot goes out.
    pub(crate) lagged: bool,
    pub(crate) recovering: bool,
    /// Bounds the controls of this phone that run at once.
    pub(crate) controls: Arc<Semaphore>,
    /// Keystrokes, written in arrival order.
    pub(crate) input: mpsc::Sender<ControlFrame>,
}

impl Device {
    pub(crate) fn has(&self, cap: &str) -> bool {
        self.caps.contains(cap)
    }

    pub(crate) fn deflate(&self) -> bool {
        self.has("deflate")
    }

    /// Whether this phone wants the bus event at all.
    pub(crate) fn wants(&self, topic: &str, keys: &PayloadKeys) -> bool {
        match &self.focus {
            None => true,
            Some(focus) if !focus.active => false,
            Some(focus) => on_screen(topic, focus, keys, self.has("rows"), &self.pty_subs),
        }
    }

    /// Whether this phone shows the terminal `keys` names.
    pub(crate) fn shows_pty(&self, keys: &PayloadKeys) -> bool {
        // A payload without a session id reads as the empty id, as today.
        self.pty_subs.contains(keys.session_id.as_ref().and_then(Value::as_str).unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn focus(value: Value) -> FocusFrame {
        serde_json::from_value(value).expect("a focus frame")
    }

    fn keys(value: Value) -> PayloadKeys {
        PayloadKeys::of(value.to_string().as_bytes())
    }

    #[test]
    fn a_focused_phone_gets_the_open_workers_events_and_terminal_changes() {
        let on = focus(json!({ "active": true, "worker": "w1", "pty": "p1" }));
        let none = HashSet::new();
        for topic in ["agent:delta", "terminal:chunk", "terminal:done"] {
            assert!(on_screen(topic, &on, &keys(json!({ "workerId": "w1" })), true, &none), "{topic}");
            assert!(!on_screen(topic, &on, &keys(json!({ "workerId": "w2" })), true, &none), "{topic}");
        }
        assert!(on_screen("worker:change", &on, &keys(json!({ "workerId": "w1" })), false, &none));
        assert!(!on_screen("worker:change", &on, &keys(json!({ "workerId": "w1" })), true, &none), "rows are pushed");
        assert!(on_screen("pty:session", &on, &keys(json!({})), true, &none));
        assert!(on_screen("pty:exit", &on, &keys(json!({})), true, &none));
        assert!(on_screen("pty:conversation", &on, &keys(json!({ "sessionId": "p1" })), true, &none));
        assert!(!on_screen("pty:conversation", &on, &keys(json!({ "sessionId": "p2" })), true, &none));
        let subs: HashSet<String> = ["p2".to_owned()].into();
        assert!(on_screen("pty:conversation", &on, &keys(json!({ "sessionId": "p2" })), true, &subs));
        assert!(!on_screen("fs:change", &on, &keys(json!({ "dir": "/x" })), true, &none));
    }

    #[test]
    fn absent_and_null_compare_as_javascript_compares_them() {
        let unset = focus(json!({ "active": true }));
        let null = focus(json!({ "active": true, "worker": null }));
        let none = HashSet::new();
        assert!(on_screen("agent:delta", &unset, &keys(json!({})), true, &none), "undefined === undefined");
        assert!(!on_screen("agent:delta", &unset, &keys(json!({ "workerId": null })), true, &none));
        assert!(on_screen("agent:delta", &null, &keys(json!({ "workerId": null })), true, &none), "null === null");
        assert!(!on_screen("agent:delta", &null, &keys(json!({})), true, &none));
        assert!(!on_screen("agent:delta", &null, &keys(json!({ "workerId": 7 })), true, &none));
        assert_eq!(keys(json!([1, 2])).worker(), None, "a payload that is not an object has no keys");
    }
}
