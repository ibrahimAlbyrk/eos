//! The inner frames the app sends a phone (`contracts/src/remote.ts`,
//! `manager/remote/framer.ts`): one JSON object per `data` payload, its keys
//! in the order today's gateway writes them. Rows, event payloads and route
//! answers are embedded as the JSON text they already are, so a frame carries
//! exactly what the route or the publisher wrote.

use std::io::Write;
use std::sync::OnceLock;

use base64::Engine;
use bytes::Bytes;
use eos_contracts::{LiveBlock, REMOTE_CAPS};
use flate2::Compression;
use flate2::write::DeflateEncoder;
use serde::Serialize;
use serde_json::value::RawValue;

/// Small frames gain nothing from compression.
pub(crate) const DEFLATE_MIN_BYTES: usize = 512;
/// A frame above this is sent plain: packing it would hold up everything behind it.
pub(crate) const DEFLATE_MAX_BYTES: usize = 256 * 1024;
/// JSON never starts with this byte.
const DEFLATE_MARK: u8 = 0x01;

/// One frame, serialized once. A device that listed `deflate` gets a frame
/// worth it as the mark byte and the raw DEFLATE of the JSON; that is packed
/// once too, for every such device.
#[derive(Debug)]
pub(crate) struct Frame {
    json: Bytes,
    packed: OnceLock<Option<Bytes>>,
}

fn pack(json: &[u8]) -> Option<Bytes> {
    let mut encoder = DeflateEncoder::new(vec![DEFLATE_MARK], Compression::default());
    encoder.write_all(json).ok()?;
    let packed = encoder.finish().ok()?;
    (packed.len() < json.len()).then(|| packed.into())
}

impl Frame {
    fn new<T: Serialize>(frame: &T) -> Self {
        // Plain structs over strings, numbers and JSON text that was parsed before: they serialize.
        let json = serde_json::to_vec(frame).unwrap_or_default();
        Self { json: json.into(), packed: OnceLock::new() }
    }

    /// The `data` payload for a device.
    pub(crate) fn payload(&self, deflate: bool) -> Bytes {
        if !deflate || self.json.len() < DEFLATE_MIN_BYTES || self.json.len() > DEFLATE_MAX_BYTES {
            return self.json.clone();
        }
        self.packed.get_or_init(|| pack(&self.json)).clone().unwrap_or_else(|| self.json.clone())
    }

    pub(crate) fn json_len(&self) -> usize {
        self.json.len()
    }
}

/// JSON text that parses, as a value to embed; `None` when it does not.
pub(crate) fn raw(json: &[u8]) -> Option<&RawValue> {
    serde_json::from_slice(json).ok()
}

/// `[]`.
pub(crate) fn empty_list() -> &'static RawValue {
    static EMPTY: OnceLock<Box<RawValue>> = OnceLock::new();
    EMPTY.get_or_init(|| RawValue::from_string("[]".to_owned()).unwrap_or_default())
}

#[derive(Serialize)]
struct Event<'a> {
    t: &'static str,
    seq: i64,
    reason: &'a str,
    ts: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    payload: Option<&'a RawValue>,
}

/// A bus event, its topic as `reason`.
pub(crate) fn event(seq: i64, reason: &str, ts: i64, payload: Option<&RawValue>) -> Frame {
    Frame::new(&Event { t: "event", seq, reason, ts, payload })
}

#[derive(Serialize)]
struct Patch<'a> {
    t: &'static str,
    seq: i64,
    resource: &'a str,
    op: &'a str,
    data: &'a RawValue,
}

/// One row changed: `data` is the row as its list route serves it, or `{id}` for a remove.
pub(crate) fn patch(seq: i64, resource: &str, op: &str, data: &RawValue) -> Frame {
    Frame::new(&Patch { t: "patch", seq, resource, op, data })
}

/// What only the snapshot sent on join carries: the terminal list and the ui
/// configuration the phone would fetch next.
#[derive(Debug, Default)]
pub(crate) struct BootExtras {
    pub(crate) ptys: Option<Box<RawValue>>,
    pub(crate) ui_config: Option<Box<RawValue>>,
}

#[derive(Serialize)]
struct Snapshot<'a> {
    t: &'static str,
    seq: i64,
    epoch: &'a str,
    workers: &'a RawValue,
    pending: &'a RawValue,
    live: &'a [LiveBlock],
    caps: &'static [&'static str],
    #[serde(skip_serializing_if = "Option::is_none")]
    ptys: Option<&'a RawValue>,
    #[serde(rename = "uiConfig", skip_serializing_if = "Option::is_none")]
    ui_config: Option<&'a RawValue>,
}

/// The full state: both lists, the text of blocks still streaming, what this
/// app understands beyond the base protocol.
pub(crate) fn snapshot(
    seq: i64,
    epoch: &str,
    workers: &RawValue,
    pending: &RawValue,
    live: &[LiveBlock],
    extras: &BootExtras,
) -> Frame {
    Frame::new(&Snapshot {
        t: "snapshot",
        seq,
        epoch,
        workers,
        pending,
        live,
        caps: REMOTE_CAPS,
        ptys: extras.ptys.as_deref(),
        ui_config: extras.ui_config.as_deref(),
    })
}

#[derive(Serialize)]
struct Rows<'a> {
    t: &'static str,
    seq: i64,
    #[serde(rename = "workerId")]
    worker_id: &'a str,
    rows: &'a [&'a RawValue],
    #[serde(skip_serializing_if = "Option::is_none")]
    live: Option<&'a [LiveBlock]>,
}

/// New transcript rows of the worker the phone has open, oldest first; or,
/// right after a focus change, no rows and the worker's live text.
pub(crate) fn rows(seq: i64, worker_id: &str, rows: &[&RawValue], live: Option<&[LiveBlock]>) -> Frame {
    Frame::new(&Rows { t: "rows", seq, worker_id, rows, live })
}

#[derive(Serialize)]
struct Reply<'a> {
    t: &'static str,
    #[serde(rename = "correlationId")]
    correlation_id: &'a str,
    status: u16,
    body: &'a RawValue,
}

pub(crate) fn reply(correlation_id: &str, status: u16, body: &RawValue) -> Frame {
    Frame::new(&Reply { t: "reply", correlation_id, status, body })
}

#[derive(Serialize)]
struct Asset<'a> {
    t: &'static str,
    #[serde(rename = "correlationId")]
    correlation_id: &'a str,
    status: u16,
    mime: &'a str,
    #[serde(rename = "bytesB64")]
    bytes_b64: String,
}

/// An answer that is not JSON travels as base64 beside its content type.
pub(crate) fn asset(correlation_id: &str, status: u16, mime: &str, bytes: &[u8]) -> Frame {
    let bytes_b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Frame::new(&Asset { t: "asset", correlation_id, status, mime, bytes_b64 })
}

#[derive(Serialize)]
struct Failure<'a> {
    t: &'static str,
    code: &'a str,
    message: &'a str,
    #[serde(rename = "correlationId")]
    correlation_id: &'a str,
}

/// A control that was not dispatched, or whose answer cannot travel.
pub(crate) fn error(code: &str, message: &str, correlation_id: &str) -> Frame {
    Frame::new(&Failure { t: "error", code, message, correlation_id })
}

#[derive(Serialize)]
struct Ka {
    t: &'static str,
    ts: i64,
}

/// A keepalive: the phone drops it.
pub(crate) fn ka(ts: i64) -> Frame {
    Frame::new(&Ka { t: "ka", ts })
}

#[cfg(test)]
mod tests {
    //! Against `fixtures/relay/frames.json`: the frames as today's framer
    //! writes them.

    use std::io::Read;

    use eos_testkit::relay::inner_json;
    use serde_json::Value;
    use sha2::{Digest, Sha256};

    use super::*;

    fn corpus() -> Value {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/relay/frames.json");
        serde_json::from_str(&std::fs::read_to_string(path).expect("the corpus")).expect("JSON")
    }

    /// The generator's "$lorem:N" / "$noise:N" placeholders, written out.
    fn expand(value: &Value) -> Value {
        match value {
            Value::String(s) => {
                let filler = s.strip_prefix('$').and_then(|rest| rest.split_once(':'));
                match filler.and_then(|(kind, n)| Some((kind, n.parse::<usize>().ok()?))) {
                    Some(("lorem", n)) => {
                        Value::String("lorem ipsum dolor sit amet ".repeat(n / 27 + 1)[..n].to_owned())
                    }
                    Some(("noise", n)) => Value::String(noise(n)),
                    _ => value.clone(),
                }
            }
            Value::Array(items) => Value::Array(items.iter().map(expand).collect()),
            Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), expand(v))).collect()),
            other => other.clone(),
        }
    }

    fn noise(n: usize) -> String {
        const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
        let mut x: u32 = 0x9e37_79b9;
        let mut out = String::new();
        while out.len() < n {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            let (mut v, mut digits) = (x, Vec::new());
            while v > 0 {
                digits.push(DIGITS[(v % 36) as usize]);
                v /= 36;
            }
            digits.reverse();
            out.push_str(std::str::from_utf8(&digits).expect("ascii"));
        }
        out.truncate(n);
        out
    }

    fn text(value: &Value) -> Box<RawValue> {
        RawValue::from_string(value.to_string()).expect("JSON")
    }

    /// The corpus's frame, built the way the gateway builds it.
    fn build(frame: &Value) -> Frame {
        let seq = frame["seq"].as_i64().unwrap_or(0);
        let id = frame["correlationId"].as_str().unwrap_or_default();
        let status = frame["status"].as_u64().unwrap_or(0) as u16;
        let live = |key: &str| -> Option<Vec<LiveBlock>> {
            frame.get(key).map(|blocks| serde_json::from_value(blocks.clone()).expect("live blocks"))
        };
        match frame["t"].as_str().expect("a kind") {
            "ka" => ka(frame["ts"].as_i64().expect("ts")),
            "event" => {
                let payload = frame.get("payload").map(text);
                event(
                    seq,
                    frame["reason"].as_str().expect("reason"),
                    frame["ts"].as_i64().expect("ts"),
                    payload.as_deref(),
                )
            }
            "patch" => patch(
                seq,
                frame["resource"].as_str().expect("resource"),
                frame["op"].as_str().expect("op"),
                &text(&frame["data"]),
            ),
            "snapshot" => {
                let extras =
                    BootExtras { ptys: frame.get("ptys").map(text), ui_config: frame.get("uiConfig").map(text) };
                snapshot(
                    seq,
                    frame["epoch"].as_str().expect("epoch"),
                    &text(&frame["workers"]),
                    &text(&frame["pending"]),
                    &live("live").expect("live"),
                    &extras,
                )
            }
            "rows" => {
                let list: Vec<Box<RawValue>> = frame["rows"].as_array().expect("rows").iter().map(text).collect();
                let borrowed: Vec<&RawValue> = list.iter().map(|row| &**row).collect();
                rows(seq, frame["workerId"].as_str().expect("worker"), &borrowed, live("live").as_deref())
            }
            "reply" => reply(id, status, &text(&frame["body"])),
            "asset" => {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(frame["bytesB64"].as_str().expect("bytes"))
                    .expect("base64");
                asset(id, status, frame["mime"].as_str().expect("mime"), &bytes)
            }
            "error" => error(frame["code"].as_str().expect("code"), frame["message"].as_str().expect("message"), id),
            other => panic!("no builder for {other}"),
        }
    }

    #[test]
    fn writes_every_frame_as_the_typescript_framer_does() {
        let corpus = corpus();
        let cases = corpus["server"].as_array().expect("cases");
        assert!(cases.len() >= 20);
        for case in cases {
            let frame = build(&expand(&case["frame"]));
            let plain = frame.payload(false);
            assert_eq!(plain.len() as u64, case["jsonBytes"].as_u64().expect("size"), "{}", case["frame"]);
            let digest: String = Sha256::digest(&plain).iter().map(|b| format!("{b:02x}")).collect();
            assert_eq!(digest, case["jsonSha256"].as_str().expect("hash"), "{}", case["frame"]);
            if let Some(json) = case["json"].as_str() {
                assert_eq!(std::str::from_utf8(&plain).expect("utf-8"), json);
            }

            // Whether a frame is packed is today's rule; the packed bytes are the compressor's own.
            let packed = frame.payload(true);
            let (inflated, deflated) = inner_json(&packed);
            assert_eq!(deflated, case["compressed"].as_bool().expect("flag"), "{} bytes", plain.len());
            assert_eq!(inflated.as_bytes(), &plain[..]);
            assert!(packed.len() <= plain.len());
        }
    }

    #[test]
    fn a_phone_can_inflate_what_todays_framer_packed() {
        let corpus = corpus();
        let mut seen = 0;
        for case in corpus["server"].as_array().expect("cases") {
            let (Some(packed), Some(json)) = (case["packed"].as_str(), case["json"].as_str()) else { continue };
            let envelope: Vec<u8> =
                (0..packed.len()).step_by(2).map(|i| u8::from_str_radix(&packed[i..i + 2], 16).expect("hex")).collect();
            // The payload follows the 13-byte header, the room and the 16-byte id.
            let payload = &envelope[13 + usize::from(envelope[12]) + 16..];
            assert_eq!(payload[0], DEFLATE_MARK);
            let mut inflated = String::new();
            flate2::read::DeflateDecoder::new(&payload[1..]).read_to_string(&mut inflated).expect("inflates");
            assert_eq!(inflated, json);
            seen += 1;
        }
        assert!(seen >= 2);
    }
}
