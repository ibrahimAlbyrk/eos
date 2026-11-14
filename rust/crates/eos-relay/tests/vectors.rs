//! The envelope and the relay's own messages against what the two TypeScript
//! codecs wrote (`fixtures/relay/envelopes.json`, frozen from the TypeScript, see `rust/fixtures/README.md`).

use bytes::Bytes;
use eos_relay::control::{self, Control};
use eos_relay::envelope::{Dir, EnvelopeError, FrameType, Header, encode_envelope, parse_envelope};
use serde_json::Value;

fn corpus() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/relay/envelopes.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("the corpus")).expect("JSON")
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex")).collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn client_id(case: &Value) -> [u8; 16] {
    match case["clientId"].as_str() {
        Some(text) => unhex(text).try_into().expect("16 bytes"),
        None => [0; 16],
    }
}

/// What `parse_envelope` makes of `bytes`, in the corpus's own shape.
fn parsed(bytes: &[u8]) -> Value {
    match parse_envelope(&Bytes::copy_from_slice(bytes)) {
        Ok(env) => serde_json::json!({
            "ver": env.ver, "type": env.kind, "dir": env.dir, "epoch": env.epoch, "seq": env.seq.to_string(),
            "room": env.room, "clientId": hex(&env.client_id), "payload": hex(&env.payload),
        }),
        Err(e) => serde_json::json!({ "error": e.to_string() }),
    }
}

#[test]
fn encodes_every_envelope_as_the_typescript_does() {
    let corpus = corpus();
    let cases = corpus["encode"].as_array().expect("cases");
    assert!(cases.len() >= 10);
    for case in cases {
        let kind = FrameType::from_byte(case["type"].as_u64().expect("type") as u8).expect("a known type");
        let dir = if case["dir"] == 0 { Dir::C2s } else { Dir::S2c };
        let header = Header {
            epoch: case["epoch"].as_u64().unwrap_or(0) as u8,
            seq: case["seq"].as_str().map_or(0, |s| s.parse().expect("u64")),
            ..Header::new(kind, dir, case["room"].as_str().expect("room"), client_id(case))
        };
        let bytes = encode_envelope(header, &unhex(case["payload"].as_str().expect("payload"))).expect("encodes");
        assert_eq!(hex(&bytes), case["bytes"].as_str().expect("bytes"), "{case}");
        assert_eq!(parsed(&bytes), case["parsed"], "{case}");
    }
}

#[test]
fn reads_or_refuses_every_buffer_as_the_typescript_does() {
    let corpus = corpus();
    let cases = corpus["parse"].as_array().expect("cases");
    assert!(cases.len() >= 10);
    for case in cases {
        assert_eq!(parsed(&unhex(case["bytes"].as_str().expect("bytes"))), case["parsed"], "{case}");
    }
    let long = "x".repeat(256);
    let refused = encode_envelope(Header::new(FrameType::Data, Dir::S2c, &long, [0; 16]), b"");
    assert_eq!(refused, Err(EnvelopeError::RoomTooLong));
    assert_eq!(EnvelopeError::RoomTooLong.to_string(), corpus["errors"]["roomTooLong"].as_str().expect("message"));
}

#[test]
fn writes_the_relays_own_messages_byte_for_byte() {
    let corpus = corpus();
    let c = &corpus["control"];
    let text = |key: &str| c[key].as_str().expect(key);
    let (room, owner, bearer) = (text("room"), text("owner"), text("bearer"));
    let client: [u8; 16] = unhex(text("clientId")).try_into().expect("16 bytes");
    let allow = vec![text("bearerHash").to_owned()];

    assert_eq!(hex(&control::register(room, owner, &allow).expect("encodes")), text("register"));
    assert_eq!(hex(&control::register(room, owner, &[]).expect("encodes")), text("registerNoDevices"));
    assert_eq!(hex(&control::join(room, bearer).expect("encodes")), text("join"));
    assert_eq!(hex(&control::joined(room, client).expect("encodes")), text("joined"));
    assert_eq!(hex(&control::left(room, client).expect("encodes")), text("left"));
    assert_eq!(hex(&control::registered(room).expect("encodes")), text("registered"));
    for case in c["errors"].as_array().expect("errors") {
        let code = case["code"].as_str().expect("code");
        let in_room = if code == "FRAME_TOO_LARGE" { "" } else { room };
        assert_eq!(
            hex(&control::error(in_room, code, "why").expect("encodes")),
            case["bytes"].as_str().expect("bytes")
        );
    }

    // One chunk of a link between two computers, each way.
    let chunk = [0x16, 0x03, 0x03];
    let up = encode_envelope(Header::new(FrameType::Data, Dir::C2s, room, client), &chunk).expect("encodes");
    let down = encode_envelope(Header::new(FrameType::Data, Dir::S2c, room, client), &chunk).expect("encodes");
    assert_eq!((hex(&up), hex(&down)), (text("pipeC2s").to_owned(), text("pipeS2c").to_owned()));
}

#[test]
fn reads_the_relays_own_messages() {
    let corpus = corpus();
    let c = &corpus["control"];
    let client: [u8; 16] = unhex(c["clientId"].as_str().expect("id")).try_into().expect("16 bytes");
    for (key, kind) in [("joined", "joined"), ("left", "left")] {
        let env = parse_envelope(&Bytes::from(unhex(c[key].as_str().expect(key)))).expect("parses");
        let notice = Control::parse(&env.payload);
        assert_eq!(
            (env.frame_type(), notice.kind(), notice.client_id()),
            (Some(FrameType::RelayCtl), Some(kind), Some(client))
        );
        assert_eq!(env.client_id, client, "the header names the device too");
    }
    for case in c["errors"].as_array().expect("errors") {
        let env = parse_envelope(&Bytes::from(unhex(case["bytes"].as_str().expect("bytes")))).expect("parses");
        assert_eq!(env.frame_type(), Some(FrameType::Error));
        assert_eq!(
            Control::parse(&env.payload).error(),
            (case["code"].as_str().expect("code").to_owned(), "why".to_owned())
        );
    }
}
