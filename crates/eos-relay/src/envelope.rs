//! The outer envelope: the only structure the relay parses. One envelope is
//! one binary WebSocket message.
//!
//! ```text
//! ver(1) type(1) dir(1) epoch(1) seq(8, big-endian) roomLen(1) room(roomLen) clientId(16) payload(…)
//! ```
//!
//! Byte for byte what `relay/envelope.ts` and the 0.1.x app
//! write and what the released iOS app reads (`Envelope.swift`); the vectors
//! in `fixtures/relay/envelopes.json` come from the two TypeScript codecs.
//! `epoch` and `seq` are kept for the layout only: written 0, never judged.
//! A `data` payload is opaque here; the relay-control types carry JSON.

use bytes::{BufMut, Bytes, BytesMut};

pub const ENVELOPE_VER: u8 = 0x01;
pub const CLIENT_ID_LEN: usize = 16;
/// The relay refuses anything larger.
pub const MAX_ENVELOPE_BYTES: usize = 5 * 1024 * 1024;
/// What a WebSocket message may be: the envelope limit plus slack, as both
/// TypeScript ends configure it.
pub const MAX_MESSAGE_BYTES: usize = MAX_ENVELOPE_BYTES + 1024;

const FIXED_HEADER: usize = 13;

/// The `type` byte.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum FrameType {
    Data = 0x01,
    Register = 0x02,
    Join = 0x03,
    RelayCtl = 0x04,
    Ka = 0x05,
    Error = 0x06,
}

impl FrameType {
    pub fn from_byte(byte: u8) -> Option<Self> {
        Some(match byte {
            0x01 => Self::Data,
            0x02 => Self::Register,
            0x03 => Self::Join,
            0x04 => Self::RelayCtl,
            0x05 => Self::Ka,
            0x06 => Self::Error,
            _ => return None,
        })
    }
}

/// The `dir` byte: device → owner, or owner → device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Dir {
    C2s = 0x00,
    S2c = 0x01,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum EnvelopeError {
    #[error("envelope shorter than fixed header")]
    ShortHeader,
    #[error("envelope shorter than declared header")]
    ShortBody,
    #[error("room id exceeds 255 bytes")]
    RoomTooLong,
}

/// A parsed envelope. `kind` and `dir` are the bytes as sent: a reader takes
/// the types it knows ([`FrameType::from_byte`]) and drops the rest, as both
/// TypeScript ends do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Envelope {
    pub ver: u8,
    pub kind: u8,
    pub dir: u8,
    pub epoch: u8,
    pub seq: u64,
    pub room: String,
    pub client_id: [u8; CLIENT_ID_LEN],
    pub payload: Bytes,
}

impl Envelope {
    pub fn frame_type(&self) -> Option<FrameType> {
        FrameType::from_byte(self.kind)
    }
}

/// Reads an envelope. The payload shares `buf`'s memory.
pub fn parse_envelope(buf: &Bytes) -> Result<Envelope, EnvelopeError> {
    if buf.len() < FIXED_HEADER {
        return Err(EnvelopeError::ShortHeader);
    }
    let room_len = usize::from(buf[12]);
    let header_len = FIXED_HEADER + room_len + CLIENT_ID_LEN;
    if buf.len() < header_len {
        return Err(EnvelopeError::ShortBody);
    }
    let mut seq = [0u8; 8];
    seq.copy_from_slice(&buf[4..12]);
    let mut client_id = [0u8; CLIENT_ID_LEN];
    client_id.copy_from_slice(&buf[FIXED_HEADER + room_len..header_len]);
    Ok(Envelope {
        ver: buf[0],
        kind: buf[1],
        dir: buf[2],
        epoch: buf[3],
        seq: u64::from_be_bytes(seq),
        // Node's "ascii" decoding: each byte without its top bit.
        room: buf[FIXED_HEADER..FIXED_HEADER + room_len].iter().map(|b| char::from(b & 0x7f)).collect(),
        client_id,
        payload: buf.slice(header_len..),
    })
}

/// What goes into an envelope. `epoch` and `seq` are 0 unless set.
#[derive(Debug, Clone, Copy)]
pub struct Header<'a> {
    pub kind: FrameType,
    pub dir: Dir,
    pub epoch: u8,
    pub seq: u64,
    pub room: &'a str,
    pub client_id: [u8; CLIENT_ID_LEN],
}

impl<'a> Header<'a> {
    pub fn new(kind: FrameType, dir: Dir, room: &'a str, client_id: [u8; CLIENT_ID_LEN]) -> Self {
        Self { kind, dir, epoch: 0, seq: 0, room, client_id }
    }
}

/// The room as it travels: Node's "ascii" encoding keeps the low byte of each
/// UTF-16 unit. Room ids are ASCII, where that is the text itself.
fn room_bytes(room: &str) -> Result<Vec<u8>, EnvelopeError> {
    let bytes: Vec<u8> = room.encode_utf16().map(|unit| (unit & 0xff) as u8).collect();
    if bytes.len() > 0xff { Err(EnvelopeError::RoomTooLong) } else { Ok(bytes) }
}

/// Writes an envelope around `payload`.
pub fn encode_envelope(header: Header<'_>, payload: &[u8]) -> Result<Bytes, EnvelopeError> {
    let room = room_bytes(header.room)?;
    let mut out = BytesMut::with_capacity(FIXED_HEADER + room.len() + CLIENT_ID_LEN + payload.len());
    out.put_u8(ENVELOPE_VER);
    out.put_u8(header.kind as u8);
    out.put_u8(header.dir as u8);
    out.put_u8(header.epoch);
    out.put_u64(header.seq);
    // Checked above: at most 255.
    out.put_u8(room.len() as u8);
    out.put_slice(&room);
    out.put_slice(&header.client_id);
    out.put_slice(payload);
    Ok(out.freeze())
}

/// How many bytes the envelope adds around a payload for `room`.
pub fn overhead(room: &str) -> usize {
    FIXED_HEADER + room.encode_utf16().count() + CLIENT_ID_LEN
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_keeps_a_full_u64_seq() {
        let header = Header { seq: u64::MAX, epoch: 3, ..Header::new(FrameType::Data, Dir::C2s, "r", [7; 16]) };
        let bytes = encode_envelope(header, b"payload").expect("encodes");
        let env = parse_envelope(&bytes).expect("parses");
        assert_eq!((env.ver, env.frame_type(), env.dir, env.epoch), (1, Some(FrameType::Data), 0, 3));
        assert_eq!(env.seq, u64::MAX);
        assert_eq!((env.room.as_str(), env.client_id, &env.payload[..]), ("r", [7; 16], &b"payload"[..]));
        assert_eq!(bytes.len(), overhead("r") + 7);
    }

    #[test]
    fn refuses_what_cannot_be_an_envelope() {
        assert_eq!(parse_envelope(&Bytes::from_static(&[0; 5])), Err(EnvelopeError::ShortHeader));
        let bytes = encode_envelope(Header::new(FrameType::Data, Dir::C2s, "ABCDEFGH", [0; 16]), b"").expect("encodes");
        assert_eq!(parse_envelope(&bytes.slice(..15)), Err(EnvelopeError::ShortBody));
        let long = "x".repeat(256);
        assert_eq!(
            encode_envelope(Header::new(FrameType::Data, Dir::S2c, &long, [0; 16]), b""),
            Err(EnvelopeError::RoomTooLong)
        );
    }

    #[test]
    fn an_unknown_type_is_read_and_left_to_the_caller() {
        let mut bytes =
            encode_envelope(Header::new(FrameType::Ka, Dir::C2s, "", [0; 16]), b"").expect("encodes").to_vec();
        bytes[1] = 0x77;
        let env = parse_envelope(&Bytes::from(bytes)).expect("parses");
        assert_eq!((env.kind, env.frame_type()), (0x77, None));
    }
}
