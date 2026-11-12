//! A phone's request, answered by the app's own routes
//! (`manager/remote/dispatch.ts`, `virtual-dispatch.ts`). There is no second
//! command surface: a `control` frame becomes a router call made as the
//! phone, and the route's answer becomes a `reply`, an `asset` or an `error`
//! frame. The route's access rule decides whether the phone may call it.

use std::sync::Arc;

use bytes::Bytes;
use eos_contracts::{ControlFrame, ControlFrameMethod};
use eos_core::Clock;
use eos_core::store::{RemoteAuditEntry, RemoteAuditResult, RemoteStore};
use eos_runtime::access::{Caller, Tier};
use eos_runtime::http::{Body, Method, Request};
use eos_runtime::router::Router;
use serde_json::value::RawValue;

use crate::frames::{self, Frame};

/// The relay carries at most this per message (`MAX_ENVELOPE_BYTES`).
pub(crate) const MAX_FRAME_BYTES: usize = 5 * 1024 * 1024;
/// Room kept for the envelope around an asset frame (13 + a room of at most
/// 255 + the 16-byte id), so the framed message stays inside the relay's limit.
const ASSET_FRAME_OVERHEAD: usize = 512;

/// Every joined device calls at full capability: the relay's admission is the
/// whole sign-in, and the routes' own rules do the rest.
pub(crate) const PHONE: Caller = Caller::Phone { grant: Tier::High, mutate: true };

/// A route's answer, read whole.
pub(crate) struct Answer {
    pub(crate) status: u16,
    pub(crate) content_type: String,
    pub(crate) body: Bytes,
}

/// The answer was a stream larger than any frame can carry.
pub(crate) struct TooLarge;

/// Reads a body, giving up once it is larger than a frame can carry: a file
/// of any size must never be pulled into memory for a phone.
async fn collect(body: Body) -> Result<Bytes, TooLarge> {
    match body {
        Body::Empty => Ok(Bytes::new()),
        Body::Bytes(bytes) => Ok(bytes),
        Body::Stream(mut stream) => {
            let mut out = Vec::new();
            while let Some(chunk) = stream.next().await {
                // A stream that fails part-way is a cut-off answer: what arrived stands, as today.
                let Ok(chunk) = chunk else { break };
                if out.len() + chunk.len() > MAX_FRAME_BYTES {
                    return Err(TooLarge);
                }
                out.extend_from_slice(&chunk);
            }
            Ok(out.into())
        }
    }
}

/// Calls a route as the phone.
pub(crate) async fn call(router: &Router, method: Method, target: &str, body: Bytes) -> Result<Answer, TooLarge> {
    let request = Request::new(method, target, PHONE).header("content-type", "application/json").body(body);
    let response = router.handle(request).await;
    let content_type = response.header_value("content-type").unwrap_or_default().to_owned();
    Ok(Answer { status: response.status, content_type, body: collect(response.body).await? })
}

/// A `GET` whose answer is a list of rows; anything else reads as no rows.
pub(crate) async fn list(router: &Router, target: &str) -> Box<RawValue> {
    let listed = match call(router, Method::Get, target, Bytes::new()).await {
        Ok(answer) => frames::raw(&answer.body).filter(|json| json.get().starts_with('[')).map(RawValue::to_owned),
        Err(TooLarge) => None,
    };
    listed.unwrap_or_else(|| frames::empty_list().to_owned())
}

fn method_of(method: ControlFrameMethod) -> Method {
    match method {
        ControlFrameMethod::Get => Method::Get,
        ControlFrameMethod::Post => Method::Post,
        ControlFrameMethod::Put => Method::Put,
        ControlFrameMethod::Delete => Method::Delete,
    }
}

fn method_name(method: ControlFrameMethod) -> &'static str {
    method_of(method).as_str()
}

/// A reply's `body`: JSON answers as they are, an empty JSON answer as `{}`,
/// text as a string — what today's virtual response makes of a route's bytes.
fn reply_body(answer: &Answer) -> Box<RawValue> {
    let text = String::from_utf8_lossy(&answer.body);
    let json = answer.content_type.contains("application/json");
    if json || text.trim_start().starts_with(['[', '{']) {
        if text.is_empty() {
            return RawValue::from_string("{}".to_owned()).unwrap_or_default();
        }
        if let Some(parsed) = frames::raw(&answer.body) {
            return parsed.to_owned();
        }
    }
    serde_json::value::to_raw_value(text.as_ref()).unwrap_or_default()
}

pub(crate) struct Dispatcher {
    pub(crate) router: Arc<Router>,
    pub(crate) store: Arc<dyn RemoteStore>,
    pub(crate) clock: Arc<dyn Clock>,
}

impl Dispatcher {
    fn audit(&self, device: &str, frame: &ControlFrame, result: RemoteAuditResult) {
        let entry = RemoteAuditEntry {
            device: device.to_owned(),
            action: format!("{} {}", method_name(frame.method), frame.path),
            target: frame.path.clone(),
            ts: self.clock.now_ms(),
            result,
        };
        if let Err(error) = self.store.audit(&entry) {
            tracing::warn!(%error, "the phone audit log could not be written");
        }
    }

    fn deny(&self, device: &str, frame: &ControlFrame, code: &str, message: &str) -> Frame {
        self.audit(device, frame, RemoteAuditResult::Denied);
        frames::error(code, message, &frame.correlation_id)
    }

    /// Answers one control: refused, or dispatched and framed.
    pub(crate) async fn handle(&self, device: &str, frame: &ControlFrame) -> Frame {
        let method = method_of(frame.method);
        // A route the phone has no rule for — or no route at all — is never called.
        if self.router.access_of(method, &frame.path).and_then(|access| access.phone).is_none() {
            return self.deny(device, frame, "ROUTE_REFUSED", "route not exposed remotely");
        }
        // The body travels as a string and is dispatched as sent. No body reads as `{}`.
        let body = frame.body.as_deref().unwrap_or("{}");
        if serde_json::from_str::<serde::de::IgnoredAny>(body).is_err() {
            return self.deny(device, frame, "INTERNAL", "control body is not valid JSON");
        }
        let answer = match call(&self.router, method, &frame.path, Bytes::copy_from_slice(body.as_bytes())).await {
            Ok(answer) => answer,
            Err(TooLarge) => {
                self.audit(device, frame, RemoteAuditResult::Error);
                return frames::error("FRAME_TOO_LARGE", "asset exceeds relay envelope limit", &frame.correlation_id);
            }
        };
        self.audit(
            device,
            frame,
            match answer.status {
                403 => RemoteAuditResult::Denied,
                400.. => RemoteAuditResult::Error,
                _ => RemoteAuditResult::Ok,
            },
        );
        // An answer that is not JSON is carried beside its type, its bytes untouched.
        if !answer.content_type.is_empty() && !answer.content_type.contains("application/json") {
            let asset = frames::asset(&frame.correlation_id, answer.status, &answer.content_type, &answer.body);
            if asset.json_len() + ASSET_FRAME_OVERHEAD > MAX_FRAME_BYTES {
                return frames::error("FRAME_TOO_LARGE", "asset exceeds relay envelope limit", &frame.correlation_id);
            }
            return asset;
        }
        frames::reply(&frame.correlation_id, answer.status, &reply_body(&answer))
    }
}

/// Keystrokes go to the terminal in the order they arrived, whatever else runs at once.
pub(crate) fn is_pty_input(frame: &ControlFrame) -> bool {
    if frame.method != ControlFrameMethod::Post {
        return false;
    }
    let path = frame.path.split('?').next().unwrap_or_default();
    match path.strip_prefix("/pty/").and_then(|rest| rest.strip_suffix("/input")) {
        Some(id) => !id.is_empty() && !id.contains('/'),
        None => false,
    }
}

/// JavaScript's `encodeURIComponent`.
pub(crate) fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn control(method: ControlFrameMethod, path: &str) -> ControlFrame {
        ControlFrame { correlation_id: "c".into(), method, path: path.into(), body: None }
    }

    #[test]
    fn only_a_post_to_one_terminals_input_is_a_keystroke() {
        assert!(is_pty_input(&control(ControlFrameMethod::Post, "/pty/p1/input")));
        assert!(is_pty_input(&control(ControlFrameMethod::Post, "/pty/p1/input?x=1")));
        assert!(!is_pty_input(&control(ControlFrameMethod::Get, "/pty/p1/input")));
        assert!(!is_pty_input(&control(ControlFrameMethod::Post, "/pty/p1/input/x")));
        assert!(!is_pty_input(&control(ControlFrameMethod::Post, "/pty//input")));
        assert!(!is_pty_input(&control(ControlFrameMethod::Post, "/pty/a/b/input")));
        assert!(!is_pty_input(&control(ControlFrameMethod::Post, "/pty/p1/message")));
    }

    #[test]
    fn encodes_a_path_segment_as_javascript_does() {
        assert_eq!(encode_uri_component("w-1_a.b!~*'()"), "w-1_a.b!~*'()");
        assert_eq!(encode_uri_component("a b/c?d=é"), "a%20b%2Fc%3Fd%3D%C3%A9");
    }

    #[test]
    fn a_reply_body_is_json_as_sent_an_empty_object_or_text() {
        let answer = |content_type: &str, body: &str| Answer {
            status: 200,
            content_type: content_type.to_owned(),
            body: Bytes::copy_from_slice(body.as_bytes()),
        };
        assert_eq!(reply_body(&answer("application/json", r#"{"a":1.50,"b":[]}"#)).get(), r#"{"a":1.50,"b":[]}"#);
        assert_eq!(reply_body(&answer("application/json", "")).get(), "{}");
        assert_eq!(reply_body(&answer("application/json; charset=utf-8", "[1]")).get(), "[1]");
        assert_eq!(reply_body(&answer("", "")).get(), r#""""#);
        assert_eq!(reply_body(&answer("", "{\"a\":1}")).get(), "{\"a\":1}", "text that is JSON is read as JSON");
        assert_eq!(reply_body(&answer("", "{broken")).get(), r#""{broken""#);
        assert_eq!(reply_body(&answer("application/json", "not json")).get(), r#""not json""#);
    }
}
