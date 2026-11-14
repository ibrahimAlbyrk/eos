//! The packets esbuild's binary exchanges with its host over stdin / stdout
//! (`esbuild --service=<version>`), as esbuild's own JavaScript library
//! writes and reads them:
//!
//! ```text
//! packet  = length:u32le  id:u32le  value        id = request id << 1 | is response
//! value   = 0                      null
//!         | 1 byte                 boolean
//!         | 2 i32le                integer
//!         | 3 length:u32le bytes   string (UTF-8)
//!         | 4 length:u32le bytes   bytes
//!         | 5 count:u32le value…   array
//!         | 6 count:u32le (length:u32le key value)…   object
//! ```
//!
//! The very first packet the binary sends is not a value: it is its version
//! as bare text.

/// A value on the wire. Object keys keep their order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Value {
    Null,
    Bool(bool),
    Int(i32),
    Str(String),
    Bytes(Vec<u8>),
    Array(Vec<Value>),
    Object(Vec<(String, Value)>),
}

impl Value {
    pub(crate) fn str(text: impl Into<String>) -> Self {
        Value::Str(text.into())
    }

    pub(crate) fn object<const N: usize>(fields: [(&str, Value); N]) -> Self {
        Value::Object(fields.into_iter().map(|(key, value)| (key.to_owned(), value)).collect())
    }

    pub(crate) fn strings<S: AsRef<str>>(items: impl IntoIterator<Item = S>) -> Self {
        Value::Array(items.into_iter().map(|s| Value::str(s.as_ref())).collect())
    }

    pub(crate) fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Object(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub(crate) fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(text) => Some(text),
            _ => None,
        }
    }

    pub(crate) fn as_int(&self) -> Option<i32> {
        match self {
            Value::Int(n) => Some(*n),
            _ => None,
        }
    }

    pub(crate) fn as_array(&self) -> &[Value] {
        match self {
            Value::Array(items) => items,
            _ => &[],
        }
    }

    /// Text of a string, or of bytes read as UTF-8 the way a browser's
    /// `TextDecoder` does (bad sequences become U+FFFD).
    pub(crate) fn text(&self) -> Option<String> {
        match self {
            Value::Str(text) => Some(text.clone()),
            Value::Bytes(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Packet {
    pub(crate) id: u32,
    pub(crate) is_request: bool,
    pub(crate) value: Value,
}

fn put_len(out: &mut Vec<u8>, len: usize) {
    // A length that does not fit is cut here and refused by the reader on the other side.
    out.extend_from_slice(&u32::try_from(len).unwrap_or(u32::MAX).to_le_bytes());
}

fn put_value(out: &mut Vec<u8>, value: &Value) {
    match value {
        Value::Null => out.push(0),
        Value::Bool(flag) => out.extend_from_slice(&[1, u8::from(*flag)]),
        Value::Int(n) => {
            out.push(2);
            out.extend_from_slice(&n.to_le_bytes());
        }
        Value::Str(text) => {
            out.push(3);
            put_len(out, text.len());
            out.extend_from_slice(text.as_bytes());
        }
        Value::Bytes(bytes) => {
            out.push(4);
            put_len(out, bytes.len());
            out.extend_from_slice(bytes);
        }
        Value::Array(items) => {
            out.push(5);
            put_len(out, items.len());
            for item in items {
                put_value(out, item);
            }
        }
        Value::Object(fields) => {
            out.push(6);
            put_len(out, fields.len());
            for (key, value) in fields {
                put_len(out, key.len());
                out.extend_from_slice(key.as_bytes());
                put_value(out, value);
            }
        }
    }
}

/// A packet with its length prefix, ready to be written.
pub(crate) fn encode(packet: &Packet) -> Vec<u8> {
    let mut out = vec![0; 4];
    out.extend_from_slice(&(packet.id << 1 | u32::from(!packet.is_request)).to_le_bytes());
    put_value(&mut out, &packet.value);
    let body = u32::try_from(out.len() - 4).unwrap_or(u32::MAX);
    out[..4].copy_from_slice(&body.to_le_bytes());
    out
}

/// A packet the binary sent that does not follow the format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Malformed;

/// How deep arrays and objects may nest before a packet is refused.
const MAX_DEPTH: usize = 32;

struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, len: usize) -> Result<&'a [u8], Malformed> {
        let end = self.at.checked_add(len).filter(|end| *end <= self.bytes.len()).ok_or(Malformed)?;
        let slice = &self.bytes[self.at..end];
        self.at = end;
        Ok(slice)
    }

    fn u32(&mut self) -> Result<u32, Malformed> {
        let raw = self.take(4)?;
        Ok(u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]))
    }

    fn chunk(&mut self) -> Result<&'a [u8], Malformed> {
        let len = self.u32()? as usize;
        self.take(len)
    }

    fn text(&mut self) -> Result<String, Malformed> {
        Ok(String::from_utf8_lossy(self.chunk()?).into_owned())
    }

    /// A count of items still to come: each takes a byte at least, so a count
    /// past what is left is a lie and nothing is reserved for it.
    fn count(&mut self) -> Result<usize, Malformed> {
        let count = self.u32()? as usize;
        if count > self.bytes.len() - self.at { Err(Malformed) } else { Ok(count) }
    }

    fn value(&mut self, depth: usize) -> Result<Value, Malformed> {
        if depth > MAX_DEPTH {
            return Err(Malformed);
        }
        Ok(match self.take(1)?[0] {
            0 => Value::Null,
            1 => Value::Bool(self.take(1)?[0] != 0),
            2 => Value::Int(self.u32()?.cast_signed()),
            3 => Value::Str(self.text()?),
            4 => Value::Bytes(self.chunk()?.to_vec()),
            5 => {
                let count = self.count()?;
                let mut items = Vec::with_capacity(count);
                for _ in 0..count {
                    items.push(self.value(depth + 1)?);
                }
                Value::Array(items)
            }
            6 => {
                let count = self.count()?;
                let mut fields = Vec::with_capacity(count);
                for _ in 0..count {
                    let key = self.text()?;
                    fields.push((key, self.value(depth + 1)?));
                }
                Value::Object(fields)
            }
            _ => return Err(Malformed),
        })
    }
}

/// Reads a packet's body (what follows the length prefix).
pub(crate) fn decode(body: &[u8]) -> Result<Packet, Malformed> {
    let mut cursor = Cursor { bytes: body, at: 0 };
    let id = cursor.u32()?;
    let value = cursor.value(0)?;
    Ok(Packet { id: id >> 1, is_request: id & 1 == 0, value })
}

/// Splits a byte stream into packet bodies. Holds at most one unfinished
/// packet; a packet longer than `max` is refused before it is buffered.
#[derive(Debug)]
pub(crate) struct Frames {
    buffer: Vec<u8>,
    max: usize,
}

/// A packet announced a length past the cap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TooLarge;

impl Frames {
    pub(crate) fn new(max: usize) -> Self {
        Self { buffer: Vec::new(), max }
    }

    pub(crate) fn push(&mut self, chunk: &[u8]) {
        self.buffer.extend_from_slice(chunk);
    }

    /// The next complete packet body, if one has arrived.
    pub(crate) fn next(&mut self) -> Result<Option<Vec<u8>>, TooLarge> {
        let Some(prefix) = self.buffer.first_chunk::<4>() else { return Ok(None) };
        let len = u32::from_le_bytes(*prefix) as usize;
        if len > self.max {
            return Err(TooLarge);
        }
        if self.buffer.len() < 4 + len {
            return Ok(None);
        }
        let body = self.buffer[4..4 + len].to_vec();
        self.buffer.drain(..4 + len);
        Ok(Some(body))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Packet {
        Packet {
            id: 3,
            is_request: false,
            value: Value::object([
                ("id", Value::Int(1)),
                ("contents", Value::Bytes(b"module.exports = 1;".to_vec())),
                ("loader", Value::str("js")),
                ("flags", Value::strings(["--bundle", "--format=esm"])),
                ("write", Value::Bool(false)),
                ("stdin", Value::Null),
                ("neg", Value::Int(-1)),
            ]),
        }
    }

    #[test]
    fn a_packet_reads_back_as_it_was_written() {
        let bytes = encode(&sample());
        assert_eq!(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize, bytes.len() - 4);
        assert_eq!(decode(&bytes[4..]), Ok(sample()));
    }

    #[test]
    fn bytes_match_the_javascript_encoder() {
        // encodePacket({ id: 1, isRequest: false, value: { id: 0, path: "react", namespace: "eos-shared" } })
        // captured from esbuild 0.28.2's lib/main.js.
        let packet = Packet {
            id: 1,
            is_request: false,
            value: Value::object([
                ("id", Value::Int(0)),
                ("path", Value::str("react")),
                ("namespace", Value::str("eos-shared")),
            ]),
        };
        let expected = "420000000300000006030000000200000069640200000000040000007061746803050000007265616374\
                        090000006e616d657370616365030a000000656f732d736861726564";
        let hex: String = encode(&packet).iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, expected);
    }

    #[test]
    fn requests_and_responses_are_told_apart_by_the_low_bit() {
        let request = encode(&Packet { id: 5, is_request: true, value: Value::Null });
        assert_eq!(&request[4..8], &10u32.to_le_bytes());
        assert_eq!(decode(&request[4..]).map(|p| (p.id, p.is_request)), Ok((5, true)));
    }

    #[test]
    fn broken_packets_are_refused_not_trusted() {
        assert_eq!(decode(&[]), Err(Malformed));
        assert_eq!(decode(&[0, 0, 0, 0, 9]), Err(Malformed), "an unknown tag");
        assert_eq!(decode(&[0, 0, 0, 0, 3, 10, 0, 0, 0, b'a']), Err(Malformed), "a string past the end");
        assert_eq!(decode(&[0, 0, 0, 0, 5, 255, 255, 255, 255]), Err(Malformed), "a count past the end");
        let mut deep = vec![0, 0, 0, 0];
        for _ in 0..40 {
            deep.extend_from_slice(&[5, 1, 0, 0, 0]);
        }
        deep.push(0);
        assert_eq!(decode(&deep), Err(Malformed), "nested past the limit");
    }

    #[test]
    fn frames_arrive_whole_however_the_stream_is_cut() {
        let a = encode(&sample());
        let b = encode(&Packet { id: 0, is_request: true, value: Value::str("x") });
        let stream: Vec<u8> = a.iter().chain(&b).copied().collect();
        let mut frames = Frames::new(1024);
        let mut bodies = Vec::new();
        for byte in &stream {
            frames.push(std::slice::from_ref(byte));
            while let Some(body) = frames.next().expect("small") {
                bodies.push(body);
            }
        }
        assert_eq!(bodies, vec![a[4..].to_vec(), b[4..].to_vec()]);
    }

    #[test]
    fn a_frame_past_the_cap_is_refused_before_it_is_read() {
        let mut frames = Frames::new(16);
        frames.push(&100u32.to_le_bytes());
        assert_eq!(frames.next(), Err(TooLarge));
    }
}
