//! Spikes 2–4: the Eos ↔ Eos secure channel on rustls + h2, against today's
//! TypeScript implementation (infra/src/peer/secure-channel.ts).
//!
//! - `identity`: the identity files as they are on disk; fingerprint = sha256(cert DER)
//! - `pin`:      TLS 1.3 with both ends pinned — no chain, name or date checks
//! - `link`:     connect / accept over any byte stream
//! - `goaway`:   refusing a peer with a reason in GOAWAY, and reading one
//! - `pipe`:     one HTTP/2 stream as a byte pipe (the reverse tunnel)
//! - `h2util`:   the few lines of h2 the demos need

pub mod goaway;
pub mod h2util;
pub mod identity;
pub mod link;
pub mod pin;
pub mod pipe;

/// HTTP/2 starts streams and the connection at a 64 KB window; the TypeScript
/// side opens both to 16 MiB so a link runs at its bandwidth, not its latency.
pub const PEER_WINDOW_BYTES: u32 = 16 * 1024 * 1024;
