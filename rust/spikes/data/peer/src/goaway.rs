//! GOAWAY with opaque data, without patching `h2`.
//!
//! The TypeScript host turns a device away with
//! `session.goaway(REFUSED_STREAM, 0, Buffer.from(reason))` and the device reads
//! the reason in its `goaway` event ("not-paired" stops the retries,
//! "remote-access-off" slows them). `h2` 0.4.20 can neither send debug data
//! (`abrupt_shutdown(reason)` only) nor hand it out (only `Display` shows it).
//!
//! - Sending: a refused session never serves a stream, so it needs no HTTP/2
//!   state machine. `refuse` writes the two frames by hand — an empty SETTINGS
//!   (the server preface) and the GOAWAY — and lingers like the TypeScript host.
//! - Reading: `GoAwayTap` sits under `h2` on the dialing side, follows frame
//!   boundaries in the inbound bytes and keeps the last GOAWAY it saw.

use std::{
    io,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::Duration,
};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};

pub const REFUSED_STREAM: u32 = 0x7;
const FRAME_SETTINGS: u8 = 0x4;
const FRAME_GOAWAY: u8 = 0x7;
/// A refused session lives only long enough to deliver its GOAWAY.
const REFUSED_LINGER: Duration = Duration::from_millis(1000);
/// More debug data than this is not a refusal reason; it is dropped.
const MAX_DEBUG_BYTES: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoAway {
    pub last_stream_id: u32,
    pub code: u32,
    pub debug_data: Vec<u8>,
}

impl GoAway {
    /// The refusal reason, when the debug data is text.
    pub fn reason(&self) -> Option<&str> {
        std::str::from_utf8(&self.debug_data).ok().filter(|s| !s.is_empty())
    }
}

fn frame_header(len: usize, kind: u8, flags: u8, stream: u32) -> [u8; 9] {
    let l = (len as u32).to_be_bytes();
    let s = stream.to_be_bytes();
    [l[1], l[2], l[3], kind, flags, s[0], s[1], s[2], s[3]]
}

/// The bytes a refusing server sends: SETTINGS (empty) then GOAWAY.
pub fn refusal_frames(code: u32, reason: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(9 + 9 + 8 + reason.len());
    out.extend_from_slice(&frame_header(0, FRAME_SETTINGS, 0, 0));
    out.extend_from_slice(&frame_header(8 + reason.len(), FRAME_GOAWAY, 0, 0));
    out.extend_from_slice(&0u32.to_be_bytes()); // last stream id: nothing was processed
    out.extend_from_slice(&code.to_be_bytes());
    out.extend_from_slice(reason.as_bytes());
    out
}

/// Turns the peer away on an established TLS stream and closes it.
pub async fn refuse<IO>(mut io: IO, reason: &str) -> io::Result<()>
where
    IO: AsyncRead + AsyncWrite + Unpin,
{
    io.write_all(&refusal_frames(REFUSED_STREAM, reason)).await?;
    io.flush().await?;
    // Read and drop what the client had already sent (its preface, SETTINGS, a
    // first request) until it hangs up or the linger runs out; closing with
    // unread bytes pending could reset the connection ahead of the GOAWAY.
    let drain = async {
        let mut sink = [0u8; 4096];
        while matches!(io.read(&mut sink).await, Ok(n) if n > 0) {}
    };
    let _ = tokio::time::timeout(REFUSED_LINGER, drain).await;
    io.shutdown().await
}

#[derive(Debug, Default)]
enum Parse {
    #[default]
    Header,
    Skip(usize),
    GoAway {
        left: usize,
        payload: Vec<u8>,
    },
}

/// Follows HTTP/2 frames in a byte stream and remembers the last GOAWAY.
#[derive(Debug, Default)]
struct FrameWatcher {
    state: Parse,
    header: Vec<u8>,
}

impl FrameWatcher {
    fn feed(&mut self, mut bytes: &[u8], found: &Mutex<Option<GoAway>>) {
        while !bytes.is_empty() {
            match &mut self.state {
                Parse::Header => {
                    let take = (9 - self.header.len()).min(bytes.len());
                    self.header.extend_from_slice(&bytes[..take]);
                    bytes = &bytes[take..];
                    if self.header.len() == 9 {
                        let len = u32::from_be_bytes([0, self.header[0], self.header[1], self.header[2]]) as usize;
                        let kind = self.header[3];
                        self.header.clear();
                        self.state = if kind == FRAME_GOAWAY && len >= 8 {
                            Parse::GoAway { left: len, payload: Vec::with_capacity(len.min(8 + MAX_DEBUG_BYTES)) }
                        } else {
                            Parse::Skip(len)
                        };
                        self.finish_if_empty(found);
                    }
                }
                Parse::Skip(left) => {
                    let take = (*left).min(bytes.len());
                    bytes = &bytes[take..];
                    *left -= take;
                    self.finish_if_empty(found);
                }
                Parse::GoAway { left, payload } => {
                    let take = (*left).min(bytes.len());
                    let room = (8 + MAX_DEBUG_BYTES).saturating_sub(payload.len());
                    payload.extend_from_slice(&bytes[..take.min(room)]);
                    bytes = &bytes[take..];
                    *left -= take;
                    self.finish_if_empty(found);
                }
            }
        }
    }

    fn finish_if_empty(&mut self, found: &Mutex<Option<GoAway>>) {
        match &self.state {
            Parse::Skip(0) => self.state = Parse::Header,
            Parse::GoAway { left: 0, payload } => {
                let be = |o: usize| u32::from_be_bytes([payload[o], payload[o + 1], payload[o + 2], payload[o + 3]]);
                let frame =
                    GoAway { last_stream_id: be(0) & 0x7fff_ffff, code: be(4), debug_data: payload[8..].to_vec() };
                *found.lock().unwrap_or_else(|p| p.into_inner()) = Some(frame);
                self.state = Parse::Header;
            }
            _ => {}
        }
    }
}

/// Where a tap leaves the GOAWAY it saw.
#[derive(Debug, Clone, Default)]
pub struct GoAwaySlot(Arc<Mutex<Option<GoAway>>>);

impl GoAwaySlot {
    pub fn get(&self) -> Option<GoAway> {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
}

/// A pass-through stream for the dialing side of an HTTP/2 connection (what it
/// reads is frames from the first byte) that records the server's GOAWAY.
#[derive(Debug)]
pub struct GoAwayTap<IO> {
    io: IO,
    watcher: FrameWatcher,
    slot: GoAwaySlot,
}

impl<IO> GoAwayTap<IO> {
    pub fn new(io: IO) -> (Self, GoAwaySlot) {
        let slot = GoAwaySlot::default();
        (Self { io, watcher: FrameWatcher::default(), slot: slot.clone() }, slot)
    }
}

impl<IO: AsyncRead + Unpin> AsyncRead for GoAwayTap<IO> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let this = &mut *self;
        let res = Pin::new(&mut this.io).poll_read(cx, buf);
        if let Poll::Ready(Ok(())) = &res {
            this.watcher.feed(&buf.filled()[before..], &this.slot.0);
        }
        res
    }
}

impl<IO: AsyncWrite + Unpin> AsyncWrite for GoAwayTap<IO> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.io).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.io).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.io).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn watch(chunks: &[&[u8]]) -> Option<GoAway> {
        let slot = Mutex::new(None);
        let mut w = FrameWatcher::default();
        for c in chunks {
            w.feed(c, &slot);
        }
        slot.into_inner().unwrap()
    }

    #[test]
    fn the_refusal_is_a_settings_frame_then_a_goaway_with_the_reason() {
        let bytes = refusal_frames(REFUSED_STREAM, "not-paired");
        assert_eq!(&bytes[..9], &[0, 0, 0, 4, 0, 0, 0, 0, 0]);
        assert_eq!(&bytes[9..18], &[0, 0, 18, 7, 0, 0, 0, 0, 0]);
        assert_eq!(&bytes[18..26], &[0, 0, 0, 0, 0, 0, 0, 7]);
        assert_eq!(&bytes[26..], b"not-paired");
    }

    #[test]
    fn the_watcher_finds_the_goaway_however_the_bytes_are_split() {
        let mut stream = Vec::new();
        stream.extend_from_slice(&frame_header(6, FRAME_SETTINGS, 0, 0));
        stream.extend_from_slice(&[0, 4, 1, 0, 0, 0]);
        stream.extend_from_slice(&frame_header(5, 0x0, 0, 1));
        stream.extend_from_slice(b"hello");
        stream.extend_from_slice(&refusal_frames(REFUSED_STREAM, "remote-access-off")[9..]);
        let want = GoAway { last_stream_id: 0, code: 7, debug_data: b"remote-access-off".to_vec() };

        assert_eq!(watch(&[&stream]), Some(want.clone()));
        let bytewise: Vec<&[u8]> = stream.chunks(1).collect();
        assert_eq!(watch(&bytewise), Some(want.clone()));
        let odd: Vec<&[u8]> = stream.chunks(7).collect();
        assert_eq!(watch(&odd), Some(want.clone()));
        assert_eq!(want.reason(), Some("remote-access-off"));
    }

    #[test]
    fn a_goaway_without_data_has_no_reason_and_oversized_data_is_cut() {
        let plain = refusal_frames(0, "");
        assert_eq!(watch(&[&plain]).unwrap().reason(), None);
        let long = "x".repeat(5000);
        let got = watch(&[&refusal_frames(REFUSED_STREAM, &long)]).unwrap();
        assert_eq!(got.debug_data.len(), MAX_DEBUG_BYTES);
    }
}
