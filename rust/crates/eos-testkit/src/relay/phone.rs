//! The phone's side of the link, as the released iOS app speaks it
//! (`ios/EosRemoteKit`: `Connector`, `WSConnection`, `SessionState`,
//! `QRPayload`): one relay socket, a `join` answered by the id the relay
//! names, then plaintext inner frames — a control per request, answered by a
//! `reply`, an `asset` or an `error` with the same correlation id.

use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use base64::Engine;
use bytes::Bytes;
use eos_core::net::relay::RelayClientId;
use eos_relay::control::{self, Control};
use eos_relay::envelope::{Dir, FrameType, Header, MAX_ENVELOPE_BYTES, encode_envelope, parse_envelope};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

/// How long a test waits for the Mac before it fails.
const PATIENCE: Duration = Duration::from_secs(10);

/// What the app lists in its `hello` (`HelloFrame.clientCaps`).
pub const PHONE_CAPS: &[&str] = &["focus", "rows", "deflate"];

/// Why the phone could not connect (`Connector.ConnectError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JoinFailure {
    /// The relay did not know the bearer: the pairing is void, scan again.
    AuthRejected,
    /// Anything else: the app retries with back-off.
    Transient(String),
}

/// Why a scanned code was not taken (`QRPayload.QRError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QrFailure {
    BadType,
    Expired,
}

/// The whole credential a pairing code carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pairing {
    pub relay: String,
    pub room: String,
    pub bearer: String,
}

/// Reads a pairing code as the app does: version 3, the room and the bearer
/// at least 43 characters, the display window still open at `now_s`.
pub fn read_qr(code: &Value, now_s: f64) -> Result<Pairing, QrFailure> {
    let text = |key: &str| code.get(key).and_then(Value::as_str);
    let (Some(relay), Some(room)) = (text("relay"), text("room")) else { return Err(QrFailure::BadType) };
    if text("typ") != Some("eos-pair") || code.get("v").and_then(Value::as_i64) != Some(3) || room.len() < 43 {
        return Err(QrFailure::BadType);
    }
    let bearer = text("bearer").unwrap_or_default();
    if code.get("bearer").is_some() && bearer.len() < 43 {
        return Err(QrFailure::BadType);
    }
    let Some(exp) = code.get("exp").and_then(Value::as_f64) else { return Err(QrFailure::BadType) };
    if exp <= now_s {
        return Err(QrFailure::Expired);
    }
    Ok(Pairing { relay: relay.to_owned(), room: room.to_owned(), bearer: bearer.to_owned() })
}

/// A control's answer.
#[derive(Debug, Clone, PartialEq)]
pub enum ControlAnswer {
    Reply { status: i64, body: Value },
    Asset { status: i64, mime: String, bytes: Vec<u8> },
    Error { code: String, message: String },
}

impl ControlAnswer {
    /// The JSON body of a 2xx reply; panics on anything else.
    pub fn ok(self) -> Value {
        match self {
            Self::Reply { status, body } if (200..300).contains(&status) => body,
            other => panic!("expected a 2xx reply, got {other:?}"),
        }
    }
}

#[derive(Default)]
struct Shared {
    pending: Mutex<HashMap<String, oneshot::Sender<ControlAnswer>>>,
    deflated: AtomicUsize,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

/// A paired phone, connected.
pub struct FakePhone {
    room: String,
    client: RelayClientId,
    out: mpsc::UnboundedSender<Message>,
    frames: mpsc::UnboundedReceiver<Value>,
    shared: Arc<Shared>,
    next_id: AtomicU64,
    tasks: [JoinHandle<()>; 2],
}

impl std::fmt::Debug for FakePhone {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FakePhone").field("client", &self.client_hex()).finish_non_exhaustive()
    }
}

/// The inner frame of a `data` payload: the JSON as sent, or the raw DEFLATE
/// of it behind the mark byte `0x01`. Returns the JSON text and whether it
/// travelled deflated.
pub fn inner_json(payload: &[u8]) -> (String, bool) {
    if payload.first() != Some(&0x01) {
        return (String::from_utf8_lossy(payload).into_owned(), false);
    }
    let mut text = String::new();
    flate2::read::DeflateDecoder::new(&payload[1..]).read_to_string(&mut text).expect("a deflated frame inflates");
    (text, true)
}

impl FakePhone {
    /// Scans `code` and connects.
    pub async fn pair(code: &Value, now_s: f64) -> Result<Self, JoinFailure> {
        let pairing = read_qr(code, now_s).map_err(|e| JoinFailure::Transient(format!("{e:?}")))?;
        Self::join(&pairing.relay, &pairing.room, &pairing.bearer).await
    }

    /// Opens the relay socket, joins the room, waits for the id the relay
    /// names. Nothing else is sent before that.
    pub async fn join(url: &str, room: &str, bearer: &str) -> Result<Self, JoinFailure> {
        let transient = |e: &dyn std::fmt::Display| JoinFailure::Transient(e.to_string());
        let (socket, _) = tokio_tungstenite::connect_async(url).await.map_err(|e| transient(&e))?;
        let (mut sink, mut stream) = socket.split();
        let hello = control::join(room, bearer).map_err(|e| transient(&e))?;
        sink.send(Message::Binary(hello)).await.map_err(|e| transient(&e))?;
        let ack = loop {
            match tokio::time::timeout(PATIENCE, stream.next()).await {
                Ok(Some(Ok(Message::Binary(buf)))) => break buf,
                Ok(Some(Ok(_))) => continue,
                Ok(_) => return Err(JoinFailure::Transient("join-ack: socket closed".into())),
                Err(_) => return Err(JoinFailure::Transient("join-ack: no answer".into())),
            }
        };
        let envelope = parse_envelope(&ack).map_err(|e| transient(&e))?;
        let notice = Control::parse(&envelope.payload);
        if envelope.frame_type() == Some(FrameType::Error) {
            let code = notice.str("code").unwrap_or("UNKNOWN");
            return Err(match code {
                "BEARER_DENIED" => JoinFailure::AuthRejected,
                other => JoinFailure::Transient(format!("relay {other}")),
            });
        }
        let client = match (envelope.frame_type(), notice.kind(), notice.client_id()) {
            (Some(FrameType::RelayCtl), Some("joined"), Some(client)) => client,
            _ => return Err(JoinFailure::Transient("bad join-ack".into())),
        };
        assert_eq!(envelope.client_id, client, "the join-ack names the device in its header and in its body");

        let shared = Arc::new(Shared::default());
        let (out, mut out_rx) = mpsc::unbounded_channel::<Message>();
        let writer = tokio::spawn(async move {
            while let Some(message) = out_rx.recv().await {
                if sink.send(message).await.is_err() {
                    return;
                }
            }
            let _ = sink.close().await;
        });
        let (frames_tx, frames) = mpsc::unbounded_channel();
        let reading = shared.clone();
        let reader = tokio::spawn(async move {
            while let Some(Ok(message)) = stream.next().await {
                if let Message::Binary(buf) = message {
                    route(&reading, &frames_tx, &buf);
                }
            }
        });
        Ok(Self {
            room: room.to_owned(),
            client,
            out,
            frames,
            shared,
            next_id: AtomicU64::new(1),
            tasks: [writer, reader],
        })
    }

    pub fn client(&self) -> RelayClientId {
        self.client
    }

    pub fn client_hex(&self) -> String {
        self.client.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Frames that arrived deflated so far.
    pub fn deflated(&self) -> usize {
        self.shared.deflated.load(Ordering::SeqCst)
    }

    /// Sends one inner frame.
    pub fn send(&self, frame: &Value) {
        self.send_raw(frame.to_string().as_bytes());
    }

    /// Sends bytes as a `data` payload, whatever they are.
    pub fn send_raw(&self, payload: &[u8]) {
        let header = Header::new(FrameType::Data, Dir::C2s, &self.room, self.client);
        let envelope = encode_envelope(header, payload).expect("the room fits an envelope");
        assert!(envelope.len() <= MAX_ENVELOPE_BYTES, "the relay refuses more than 5 MiB");
        let _ = self.out.send(Message::Binary(envelope));
    }

    /// The resume hint: the Mac answers with a snapshot (not the first one,
    /// which the snapshot sent on join already answered).
    pub fn hello(&self, last_content_id: i64, caps: &[&str]) {
        self.send(&json!({ "t": "hello", "lastContentId": last_content_id, "caps": caps }));
    }

    /// What the phone shows for this Mac.
    pub fn focus(&self, active: bool, worker: Option<&str>, after_id: Option<i64>, pty: Option<&str>) {
        self.send(&json!({ "t": "focus", "active": active, "worker": worker, "afterId": after_id, "pty": pty }));
    }

    /// The terminals whose raw output the phone wants; replaces the last set.
    pub fn sub(&self, pty: &[&str]) {
        self.send(&json!({ "t": "sub", "pty": pty }));
    }

    pub fn ka(&self) {
        self.send(&json!({ "t": "ka", "ts": 0 }));
    }

    fn control_frame(&self, method: &str, target: &str, body: &str) -> (String, Value) {
        let n = self.next_id.fetch_add(1, Ordering::SeqCst);
        let id = format!("00000000-0000-4000-8000-{n:012}");
        let frame = json!({ "t": "control", "correlationId": id, "method": method, "path": target, "body": body });
        (id, frame)
    }

    /// A tunnelled request: `body` is the request body serialized once, sent
    /// as a string. Waits for its answer.
    pub async fn control(&self, method: &str, target: &str, body: &str) -> ControlAnswer {
        let (id, frame) = self.control_frame(method, target, body);
        let (tx, rx) = oneshot::channel();
        lock(&self.shared.pending).insert(id, tx);
        self.send(&frame);
        match tokio::time::timeout(PATIENCE, rx).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) => panic!("the link closed before {method} {target} was answered"),
            Err(_) => panic!("{method} {target} was not answered"),
        }
    }

    /// `GET` with the empty body the app sends.
    pub async fn get(&self, target: &str) -> ControlAnswer {
        self.control("GET", target, "{}").await
    }

    /// A request whose answer is dropped (keystrokes): sent in call order.
    pub fn control_no_reply(&self, method: &str, target: &str, body: &str) {
        let (_, frame) = self.control_frame(method, target, body);
        self.send(&frame);
    }

    /// The next frame that is not a control's answer; panics when none comes.
    pub async fn next(&mut self) -> Value {
        match tokio::time::timeout(PATIENCE, self.frames.recv()).await {
            Ok(Some(frame)) => frame,
            Ok(None) => panic!("the link closed"),
            Err(_) => panic!("no frame arrived"),
        }
    }

    /// Skips frames until one satisfies `wanted`.
    pub async fn wait_for(&mut self, wanted: impl Fn(&Value) -> bool) -> Value {
        loop {
            let frame = self.next().await;
            if wanted(&frame) {
                return frame;
            }
        }
    }

    /// The next frame of kind `t` (`snapshot`, `patch`, `rows`, `event`).
    pub async fn next_of(&mut self, t: &str) -> Value {
        self.wait_for(|frame| frame["t"] == t).await
    }

    /// The next `event` frame for bus topic `reason`.
    pub async fn event(&mut self, reason: &str) -> Value {
        self.wait_for(|frame| frame["t"] == "event" && frame["reason"] == reason).await
    }

    /// A frame already here, without waiting.
    pub fn try_next(&mut self) -> Option<Value> {
        self.frames.try_recv().ok()
    }

    /// Resolves once the socket closed (the relay cut it, or the Mac's
    /// connection to the relay went away).
    pub async fn closed(&mut self) {
        let end = async { while self.frames.recv().await.is_some() {} };
        tokio::time::timeout(PATIENCE, end).await.expect("the link did not close");
    }

    /// Hangs up.
    pub fn close(self) {}
}

impl Drop for FakePhone {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

/// Folds one envelope into the phone: answers resolve their control, `ka` is
/// dropped, everything else is a frame for the test.
fn route(shared: &Shared, frames: &mpsc::UnboundedSender<Value>, buf: &Bytes) {
    // Relay-control frames only matter during the join.
    let Ok(envelope) = parse_envelope(buf) else { return };
    if envelope.frame_type() != Some(FrameType::Data) {
        return;
    }
    let (text, deflated) = inner_json(&envelope.payload);
    let Ok(frame) = serde_json::from_str::<Value>(&text) else { return };
    if deflated {
        shared.deflated.fetch_add(1, Ordering::SeqCst);
    }
    let answer = match frame["t"].as_str() {
        Some("reply") => ControlAnswer::Reply {
            status: frame["status"].as_i64().unwrap_or(0),
            body: frame.get("body").cloned().unwrap_or(Value::Null),
        },
        Some("asset") => ControlAnswer::Asset {
            status: frame["status"].as_i64().unwrap_or(0),
            mime: frame["mime"].as_str().unwrap_or_default().to_owned(),
            bytes: base64::engine::general_purpose::STANDARD
                .decode(frame["bytesB64"].as_str().unwrap_or_default())
                .unwrap_or_default(),
        },
        Some("error") => ControlAnswer::Error {
            code: frame["code"].as_str().unwrap_or_default().to_owned(),
            message: frame["message"].as_str().unwrap_or_default().to_owned(),
        },
        Some("ka") => return,
        _ => {
            let _ = frames.send(frame);
            return;
        }
    };
    let waiter = frame["correlationId"].as_str().and_then(|id| lock(&shared.pending).remove(id));
    match waiter {
        Some(waiter) => {
            let _ = waiter.send(answer);
        }
        // An error with no control behind it fails the session: the app shows it.
        None if frame["t"] == "error" => {
            let _ = frames.send(frame);
        }
        None => {}
    }
}
