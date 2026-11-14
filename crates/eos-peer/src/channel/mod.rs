//! The secure channel: HTTP/2 over TLS
//! 1.3 with both ends pinned.
//!
//! One stack for every path. A TCP socket, a relayed pipe and a reverse
//! tunnel all feed the same TLS code, so the relay only ever sees ciphertext
//! and a path switch changes nothing above the socket. Chains are never
//! validated: each side checks the other's certificate fingerprint against
//! what it pinned when pairing.
//!
//! - `pin`:    certificate verification by fingerprint only
//! - `secure`: connect / accept over any byte stream
//! - `goaway`: refusing a peer with a reason in GOAWAY, and reading one
//! - `pipe`:   one HTTP/2 stream as a byte pipe (the reverse tunnel)
//! - `h2util`: opening both windows wide, bodies under flow control

pub(crate) mod goaway;
pub(crate) mod h2util;
mod pin;
pub(crate) mod pipe;
mod secure;

use tokio::io::{AsyncRead, AsyncWrite};

pub(crate) use secure::{Channel, ConnectError};

/// HTTP/2 starts every stream and the connection at a 64 KB window: a link
/// would move at most 64 KB per round trip, and one large response would hold
/// every event stream behind it. Both are opened wide so a link runs at its
/// bandwidth, not its latency.
pub(crate) const PEER_WINDOW_BYTES: u32 = 16 * 1024 * 1024;

/// Any byte stream a link can ride on.
pub trait Io: AsyncRead + AsyncWrite + Send + Unpin + 'static {}

impl<T: AsyncRead + AsyncWrite + Send + Unpin + 'static> Io for T {}

pub type BoxIo = Box<dyn Io>;
