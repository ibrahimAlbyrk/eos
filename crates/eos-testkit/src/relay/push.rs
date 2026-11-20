//! The relay's push, as `relay/push/` answers it: relayctl `push` from the
//! room's owner socket, and `POST /push/v1/<room>` with the owner's secret.
//! No phone and no Apple: the answer is what the test set.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Mutex, MutexGuard};

use eos_core::net::relay::PushResult;
use eos_relay::control::Control;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::registry::sha256_hex;

const KINDS: [&str; 5] = ["needs_you", "run_failed", "routine_paused", "ready", "test"];
/// The relay reads at most this much of a push request.
const MAX_REQUEST_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushVia {
    Socket,
    Http,
}

/// One push the relay took.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pushed {
    pub room: String,
    pub kind: String,
    pub count: u32,
    pub via: PushVia,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

/// What the relay knows of push: the phones' stored tokens (a count) and
/// whether it has an APNs key, or is past the room's rate.
#[derive(Debug, Default)]
pub(super) struct PushDesk {
    pushes: Mutex<Vec<Pushed>>,
    tokens: AtomicU32,
    not_configured: AtomicBool,
    throttled: AtomicBool,
}

impl PushDesk {
    pub(super) fn pushes(&self) -> Vec<Pushed> {
        lock(&self.pushes).clone()
    }

    pub(super) fn set_tokens(&self, tokens: u32) {
        self.tokens.store(tokens, Ordering::SeqCst);
    }

    pub(super) fn set_configured(&self, configured: bool) {
        self.not_configured.store(!configured, Ordering::SeqCst);
    }

    pub(super) fn set_throttled(&self, throttled: bool) {
        self.throttled.store(throttled, Ordering::SeqCst);
    }

    /// The kind and count of a push body, when both are what the relay takes.
    pub(super) fn valid(body: &Control) -> Option<(String, u32)> {
        let kind = body.str("kind").filter(|kind| KINDS.contains(kind))?;
        Some((kind.to_owned(), body.count("count")?))
    }

    /// Every stored token is sent, as with a working APNs key.
    pub(super) fn answer(&self, room: &str, kind: String, count: u32, via: PushVia) -> PushResult {
        lock(&self.pushes).push(Pushed { room: room.to_owned(), kind, count, via });
        let tokens = self.tokens.load(Ordering::SeqCst);
        if self.throttled.load(Ordering::SeqCst) {
            PushResult { reason: Some("throttled".into()), ..PushResult::default() }
        } else if self.not_configured.load(Ordering::SeqCst) {
            PushResult { failed: tokens, reason: Some("not-configured".into()), ..PushResult::default() }
        } else {
            PushResult { sent: tokens, ..PushResult::default() }
        }
    }
}

/// Answers one HTTP request on `tcp`, as `relay/push/routes.ts` does.
/// `owner_hash` names the hash of the secret that owns a room the relay knows.
pub(super) async fn serve_http(mut tcp: TcpStream, desk: &PushDesk, owner_hash: impl Fn(&str) -> Option<String>) {
    let Some((head, body)) = read_request(&mut tcp).await else { return };
    let (status, answer) = route(&head, &body, desk, owner_hash);
    let response = format!(
        "HTTP/1.1 {status} {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{answer}",
        if status == 200 { "OK" } else { "Error" },
        answer.len()
    );
    let _ = tcp.write_all(response.as_bytes()).await;
    let _ = tcp.shutdown().await;
}

fn route(head: &str, body: &[u8], desk: &PushDesk, owner_hash: impl Fn(&str) -> Option<String>) -> (u16, String) {
    let error = |status: u16, message: &str| (status, serde_json::json!({ "error": message }).to_string());
    let mut lines = head.split("\r\n");
    let mut request = lines.next().unwrap_or_default().split(' ');
    let (method, path) = (request.next().unwrap_or_default(), request.next().unwrap_or_default());
    let Some(room) = path.strip_prefix("/push/v1/").filter(|room| !room.is_empty() && !room.contains('/')) else {
        return error(404, "not found");
    };
    if method != "POST" {
        return error(405, "method not allowed");
    }
    let bearer = lines.find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim().eq_ignore_ascii_case("authorization").then(|| value.trim().strip_prefix("Bearer ")).flatten()
    });
    let Some(bearer) = bearer else { return error(401, "unauthorized") };
    let Some(stored) = owner_hash(room) else { return error(404, "unknown room") };
    if sha256_hex(bearer) != stored {
        return error(401, "unauthorized");
    }
    let Some((kind, count)) = PushDesk::valid(&Control::parse(body)) else { return error(400, "bad body") };
    let answer = desk.answer(room, kind, count, PushVia::Http);
    if answer.reason.as_deref() == Some("throttled") {
        return error(429, "throttled");
    }
    let mut json = serde_json::json!({ "sent": answer.sent, "failed": answer.failed, "gone": answer.gone });
    if let Some(reason) = answer.reason {
        json["reason"] = reason.into();
    }
    (200, json.to_string())
}

/// The request's head and its body, read as far as `content-length` says.
async fn read_request(tcp: &mut TcpStream) -> Option<(String, Vec<u8>)> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let split = loop {
        if let Some(at) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break at;
        }
        let n = tcp.read(&mut chunk).await.ok().filter(|n| *n > 0)?;
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > MAX_REQUEST_BYTES {
            return None;
        }
    };
    let head = String::from_utf8_lossy(&buf[..split]).into_owned();
    let length = head
        .split("\r\n")
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.trim().parse::<usize>().ok())
        .unwrap_or(0)
        .min(MAX_REQUEST_BYTES);
    let mut body = buf[split + 4..].to_vec();
    while body.len() < length {
        let n = tcp.read(&mut chunk).await.ok().filter(|n| *n > 0)?;
        body.extend_from_slice(&chunk[..n]);
    }
    Some((head, body))
}
