//! Host side of a link (`manager/peer/gateway.ts`): every HTTP/2 stream from
//! a paired device becomes one request to this app's own routes, in process.
//! The routes decide what crosses (the local plane never does; everything
//! but the public face needs the device's dashboard); this file only says
//! who is asking and carries the answer back:
//!
//! - identity is the gateway's, never the device's: the certificate
//!   fingerprint and the device's "my dashboard asked" mark;
//! - event streams are gzipped (one context per stream, flushed on every
//!   write) and their small writes coalesced;
//! - the dashboard bundle's text is gzipped: it may cross a WAN.

use std::future::poll_fn;
use std::io::Write;
use std::time::Duration;

use bytes::Bytes;
use eos_contracts::{PEER_DEVICE_HEADER, PEER_HUMAN_HEADER};
use eos_core::net::peer::{ByteStream, LocalApi, PeerCall};
use flate2::Compression;
use flate2::write::GzEncoder;
use h2::{Reason, SendStream};

use super::respond::{ErrorBody, respond_json, send_head};
use super::server::Inbound;
use crate::channel::h2util::{finish, next_chunk, send_all};

/// Connection-scoped (RFC 9113 §8.2.2) or set by the gateway itself.
const DROP_HEADERS: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-connection",
    "transfer-encoding",
    "upgrade",
    "te",
    "host",
    "trailer",
    "x-eos-ui-token",
    PEER_DEVICE_HEADER,
    PEER_HUMAN_HEADER,
    "x-eos-agent-id",
];

/// Event streams (agent tokens, terminal bytes) arrive as many tiny writes;
/// each would cost its own HTTP/2 frame and TLS record. The first write after
/// a quiet spell goes out at once (a keystroke's echo, a turn's first token);
/// whatever follows within the window rides one frame.
const COALESCE_WINDOW: Duration = Duration::from_millis(8);
const COALESCE_MAX_BYTES: usize = 16 * 1024;

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
}

fn accepts_gzip(headers: &[(String, String)]) -> bool {
    header(headers, "accept-encoding")
        .is_some_and(|v| v.split(|c: char| !c.is_ascii_alphanumeric()).any(|token| token == "gzip"))
}

/// The dashboard bundle (`GET /ui/*`), by the path the request resolves to
/// closely enough for this purpose: a wrong guess only costs or saves a gzip.
fn is_bundle(target: &str) -> bool {
    let path = target.split('?').next().unwrap_or(target);
    path == "/ui" || path.starts_with("/ui/")
}

/// What is worth compressing of the bundle: text, JSON, WebAssembly, SVG.
fn compressible(content_type: &str) -> bool {
    content_type.starts_with("text/")
        || content_type.starts_with("application/json")
        || content_type.starts_with("application/wasm")
        || content_type.starts_with("image/svg")
}

/// The device reset the stream (closed tab, dropped link).
async fn reset(stream: &mut SendStream<Bytes>) -> Reason {
    poll_fn(|cx| stream.poll_reset(cx)).await.unwrap_or(Reason::CANCEL)
}

pub(crate) async fn forward(api: &dyn LocalApi, stream: Inbound, device: &str) {
    let Inbound { method, target, headers, mut body, mut respond } = stream;
    let human = header(&headers, PEER_HUMAN_HEADER) == Some("1");
    let limit = api.body_limit(&method, &target);
    // One byte past the limit is enough for the route to answer "too large"
    // in its own words; the rest is never buffered.
    let mut bytes = Vec::new();
    while let Some(chunk) = next_chunk(&mut body).await {
        let Ok(chunk) = chunk else { return };
        let room = (limit + 1).saturating_sub(bytes.len());
        bytes.extend_from_slice(&chunk[..chunk.len().min(room)]);
        if room <= chunk.len() {
            break;
        }
    }
    let gzip_wanted = accepts_gzip(&headers);
    let bundle = method == "GET" && is_bundle(&target);
    let call = PeerCall {
        device: device.to_owned(),
        human,
        method,
        target,
        headers: headers
            .into_iter()
            .filter(|(n, _)| !n.starts_with(':') && !DROP_HEADERS.contains(&n.as_str()))
            .collect(),
        body: bytes.into(),
    };
    let answer = api.call(call).await;

    let mut out: Vec<(String, String)> =
        answer.headers.into_iter().filter(|(n, _)| !DROP_HEADERS.contains(&n.as_str())).collect();
    let events = header(&out, "content-type").is_some_and(|t| t.starts_with("text/event-stream"));
    // Event frames are verbose, repetitive JSON: one gzip context per stream
    // shrinks them about eightfold.
    let text = bundle && answer.status == 200 && header(&out, "content-type").is_some_and(compressible);
    let gzip = (events || text) && gzip_wanted && header(&out, "content-encoding").is_none();
    if gzip {
        out.retain(|(n, _)| n != "content-length");
        out.push(("content-encoding".into(), "gzip".into()));
        out.push(("vary".into(), "accept-encoding".into()));
    }
    let Some(mut send) = send_head(&mut respond, answer.status, &out, false) else { return };
    let sent =
        if events { pump_events(answer.body, &mut send, gzip).await } else { pump(answer.body, &mut send, gzip).await };
    match sent {
        Ok(()) => {
            let _ = finish(&mut send);
        }
        Err(Failed::Local) => send.send_reset(Reason::INTERNAL_ERROR),
        // The device went away: dropping the body released the local request.
        Err(Failed::Device) => {}
    }
}

enum Failed {
    /// This app's answer broke off.
    Local,
    Device,
}

async fn pump(mut body: Box<dyn ByteStream>, send: &mut SendStream<Bytes>, gzip: bool) -> Result<(), Failed> {
    let mut packed = gzip.then(|| Outgoing::new(true));
    loop {
        let chunk = tokio::select! {
            chunk = body.next() => chunk,
            _ = reset(send) => return Err(Failed::Device),
        };
        let out = match (chunk, &mut packed) {
            (None, None) => return Ok(()),
            (None, Some(_)) => {
                let rest = packed.take().map(Outgoing::end).unwrap_or_default();
                send_all(send, rest).await.map_err(|_| Failed::Device)?;
                return Ok(());
            }
            (Some(Err(_)), _) => return Err(Failed::Local),
            (Some(Ok(chunk)), None) => chunk,
            (Some(Ok(chunk)), Some(packed)) => {
                packed.push(&chunk);
                packed.take()
            }
        };
        send_all(send, out).await.map_err(|_| Failed::Device)?;
    }
}

/// What is waiting to go out as one frame, compressed or not.
struct Outgoing {
    gzip: Option<GzEncoder<Vec<u8>>>,
    plain: Vec<u8>,
}

impl Outgoing {
    fn new(gzip: bool) -> Self {
        Self { gzip: gzip.then(|| GzEncoder::new(Vec::new(), Compression::default())), plain: Vec::new() }
    }

    fn push(&mut self, chunk: &[u8]) {
        match &mut self.gzip {
            // Writing into a Vec cannot fail.
            Some(encoder) => drop(encoder.write_all(chunk)),
            None => self.plain.extend_from_slice(chunk),
        }
    }

    /// Everything pushed so far, readable on the device the moment it lands
    /// (a sync flush: the frame is complete without the stream's end).
    fn take(&mut self) -> Bytes {
        match &mut self.gzip {
            Some(encoder) => {
                let _ = encoder.flush();
                std::mem::take(encoder.get_mut()).into()
            }
            None => std::mem::take(&mut self.plain).into(),
        }
    }

    fn end(self) -> Bytes {
        match self.gzip {
            Some(encoder) => encoder.finish().unwrap_or_default().into(),
            None => self.plain.into(),
        }
    }
}

async fn pump_events(mut body: Box<dyn ByteStream>, send: &mut SendStream<Bytes>, gzip: bool) -> Result<(), Failed> {
    let mut out = Outgoing::new(gzip);
    let mut held = 0usize;
    // Open from a write until the first window that passes with nothing held.
    let mut window: Option<tokio::time::Instant> = None;
    loop {
        let tick = async {
            match window {
                Some(at) => tokio::time::sleep_until(at).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            chunk = body.next() => match chunk {
                None => {
                    let rest = out.end();
                    if !rest.is_empty() {
                        send_all(send, rest).await.map_err(|_| Failed::Device)?;
                    }
                    return Ok(());
                }
                Some(Err(_)) => return Err(Failed::Local),
                Some(Ok(chunk)) => {
                    out.push(&chunk);
                    held += chunk.len();
                    if window.is_none() {
                        window = Some(tokio::time::Instant::now() + COALESCE_WINDOW);
                        held = 0;
                        send_all(send, out.take()).await.map_err(|_| Failed::Device)?;
                    } else if held >= COALESCE_MAX_BYTES {
                        held = 0;
                        send_all(send, out.take()).await.map_err(|_| Failed::Device)?;
                    }
                }
            },
            () = tick => {
                if held > 0 {
                    held = 0;
                    window = Some(tokio::time::Instant::now() + COALESCE_WINDOW);
                    send_all(send, out.take()).await.map_err(|_| Failed::Device)?;
                } else {
                    window = None;
                }
            }
            _ = reset(send) => return Err(Failed::Device),
        }
    }
}

/// The link has no app behind it yet (start-up) or any more (shutdown).
pub(crate) async fn unavailable(stream: Inbound) {
    respond_json(stream.respond, 503, &ErrorBody { error: "this computer is starting up" }).await;
}
