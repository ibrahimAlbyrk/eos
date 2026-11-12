//! The relay's own messages: UTF-8 JSON in a `register`, `join`, `relayctl`
//! or `error` envelope. Fields are written in the order the TypeScript writes
//! them (`fixtures/relay/envelopes.json`), and read leniently, as it reads
//! them: a field of the wrong type is a field that is not there.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use bytes::Bytes;
use eos_core::net::relay::RelayClientId;
use serde::Serialize;
use serde_json::Value;

use crate::envelope::{Dir, EnvelopeError, FrameType, Header, encode_envelope};

/// The id in a device's own position of the header until the relay names one.
pub const ZERO_CLIENT_ID: RelayClientId = [0; 16];

fn json_envelope<T: Serialize>(
    kind: FrameType,
    dir: Dir,
    room: &str,
    client_id: RelayClientId,
    json: &T,
) -> Result<Bytes, EnvelopeError> {
    // These are flat structs of strings: they always serialize.
    let payload = serde_json::to_vec(json).unwrap_or_default();
    encode_envelope(Header::new(kind, dir, room, client_id), &payload)
}

#[derive(Serialize)]
struct Register<'a> {
    t: &'static str,
    room: &'a str,
    owner: &'a str,
    allow: &'a [String],
}

/// The owner claims its room, or sends its admission list again.
pub fn register(room: &str, owner: &str, allow: &[String]) -> Result<Bytes, EnvelopeError> {
    json_envelope(FrameType::Register, Dir::S2c, room, ZERO_CLIENT_ID, &Register { t: "register", room, owner, allow })
}

#[derive(Serialize)]
struct Join<'a> {
    t: &'static str,
    room: &'a str,
    bearer: &'a str,
}

/// A device asks to be let into a room.
pub fn join(room: &str, bearer: &str) -> Result<Bytes, EnvelopeError> {
    json_envelope(FrameType::Join, Dir::C2s, room, ZERO_CLIENT_ID, &Join { t: "join", room, bearer })
}

#[derive(Serialize)]
struct Presence<'a> {
    t: &'static str,
    #[serde(rename = "clientId")]
    client_id: String,
    room: &'a str,
}

fn presence(t: &'static str, room: &str, client: RelayClientId) -> Result<Bytes, EnvelopeError> {
    let json = Presence { t, client_id: URL_SAFE_NO_PAD.encode(client), room };
    json_envelope(FrameType::RelayCtl, Dir::S2c, room, client, &json)
}

/// The relay tells both ends that a device joined, and which id it got.
pub fn joined(room: &str, client: RelayClientId) -> Result<Bytes, EnvelopeError> {
    presence("joined", room, client)
}

/// The relay tells the owner that a device's connection closed.
pub fn left(room: &str, client: RelayClientId) -> Result<Bytes, EnvelopeError> {
    presence("left", room, client)
}

#[derive(Serialize)]
struct Registered<'a> {
    t: &'static str,
    room: &'a str,
}

/// The relay took a registration.
pub fn registered(room: &str) -> Result<Bytes, EnvelopeError> {
    json_envelope(FrameType::RelayCtl, Dir::S2c, room, ZERO_CLIENT_ID, &Registered { t: "registered", room })
}

#[derive(Serialize)]
struct RelayErrorBody<'a> {
    t: &'static str,
    code: &'a str,
    message: &'a str,
}

/// The relay refuses something.
pub fn error(room: &str, code: &str, message: &str) -> Result<Bytes, EnvelopeError> {
    json_envelope(FrameType::Error, Dir::S2c, room, ZERO_CLIENT_ID, &RelayErrorBody { t: "error", code, message })
}

/// A relay-control or error payload, read field by field.
#[derive(Debug, Clone, Default)]
pub struct Control(Option<serde_json::Map<String, Value>>);

impl Control {
    pub fn parse(payload: &[u8]) -> Self {
        match serde_json::from_slice(payload) {
            Ok(Value::Object(map)) => Self(Some(map)),
            _ => Self(None),
        }
    }

    /// Whether the payload was a JSON object at all.
    pub fn is_object(&self) -> bool {
        self.0.is_some()
    }

    pub fn str(&self, key: &str) -> Option<&str> {
        self.0.as_ref()?.get(key)?.as_str()
    }

    /// The strings of an array field; other entries are skipped.
    pub fn strings(&self, key: &str) -> Vec<String> {
        match self.0.as_ref().and_then(|map| map.get(key)) {
            Some(Value::Array(items)) => items.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect(),
            _ => Vec::new(),
        }
    }

    pub fn kind(&self) -> Option<&str> {
        self.str("t")
    }

    /// The device the notice names: its `clientId`, unpadded base64url of 16 bytes.
    pub fn client_id(&self) -> Option<RelayClientId> {
        let bytes = URL_SAFE_NO_PAD.decode(self.str("clientId")?).ok()?;
        bytes.try_into().ok()
    }

    /// An error payload's code and message, with today's fall-backs.
    pub fn error(&self) -> (String, String) {
        (self.str("code").unwrap_or("UNKNOWN").to_owned(), self.str("message").unwrap_or_default().to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::parse_envelope;

    #[test]
    fn a_notice_names_its_device_in_the_header_and_in_the_body() {
        let client: RelayClientId = *b"0123456789abcdef";
        let bytes = joined("room", client).expect("encodes");
        let env = parse_envelope(&bytes).expect("parses");
        assert_eq!((env.frame_type(), env.client_id), (Some(FrameType::RelayCtl), client));
        let notice = Control::parse(&env.payload);
        assert_eq!((notice.kind(), notice.client_id()), (Some("joined"), Some(client)));
    }

    #[test]
    fn reads_leniently() {
        let odd = Control::parse(br#"{"t":"joined","clientId":7,"code":3}"#);
        assert_eq!((odd.kind(), odd.client_id()), (Some("joined"), None));
        assert_eq!(odd.error(), ("UNKNOWN".to_owned(), String::new()));
        assert_eq!(Control::parse(br#"{"clientId":"c2hvcnQ"}"#).client_id(), None, "not 16 bytes");
        assert!(!Control::parse(b"[1]").is_object());
        assert!(!Control::parse(b"nope").is_object());
        assert_eq!(Control::parse(br#"{"allow":["a",1,"b"]}"#).strings("allow"), ["a", "b"]);
    }
}
