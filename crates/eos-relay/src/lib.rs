//! The relay: a server both ends of a link dial out to. This crate holds the
//! envelope every message travels in ([`envelope`], [`control`]) and the
//! connections that own or join a room ([`RelayClient`], the
//! `eos_core::net::relay` ports).
//!
//! ## What is bounded
//!
//! Today's connector and relay queue without limit. Here:
//!
//! | Thing | Bound | When full |
//! |---|---|---|
//! | messages waiting for the socket | [`RelayOptions::outbound_bytes`] (16 MiB) per connection | `send` waits in arrival order; `try_send` fails with `Behind` |
//! | events not yet read by the room's owner | [`RelayOptions::inbound_events`] (256) | the socket is not read: TCP slows the relay |
//! | chunks a pipe holds unread | 8 | the room's socket is not read |
//! | admitted devices nobody accepted | 32 | the room's socket is not read |
//! | one message | 5 MiB (the relay's limit) | refused before it is queued |
//!
//! A queue dies with its socket: what it held was addressed to devices that
//! must join again anyway.

pub mod control;
pub mod envelope;
mod hosting;
mod pipe;
mod socket;

use std::sync::Arc;
use std::time::Duration;

use eos_core::net::relay::{PipeListener, Relay, RelayJoinError, RelayPipe, RoomClaim, RoomHosting, RoomJoin};
use eos_core::{BoxFuture, Clock};

/// Timings and bounds. The defaults are today's; tests shorten them.
#[derive(Debug, Clone, Copy)]
pub struct RelayOptions {
    /// The pause before the first redial; doubles up to `backoff_max`.
    pub backoff_min: Duration,
    pub backoff_max: Duration,
    /// How often an owned room's socket is pinged. A socket silent for a
    /// whole interval is taken for dead.
    pub ping_interval: Duration,
    /// How often the wall clock is compared for a wake.
    pub wake_check: Duration,
    /// A tick this much later than due means the computer slept.
    pub wake_gap: Duration,
    /// How long a dial may take.
    pub connect_timeout: Duration,
    /// How long joining a room may take, dial included.
    pub join_timeout: Duration,
    /// How often a joined pipe's socket is pinged.
    pub pipe_ping_interval: Duration,
    /// Bytes that may wait for one socket.
    pub outbound_bytes: usize,
    /// Events that may wait for the room's owner.
    pub inbound_events: usize,
}

impl Default for RelayOptions {
    fn default() -> Self {
        Self {
            backoff_min: Duration::from_secs(1),
            backoff_max: Duration::from_secs(60),
            ping_interval: Duration::from_secs(25),
            wake_check: Duration::from_secs(5),
            wake_gap: Duration::from_secs(20),
            connect_timeout: Duration::from_secs(30),
            join_timeout: Duration::from_secs(8),
            pipe_ping_interval: Duration::from_secs(20),
            outbound_bytes: 16 * 1024 * 1024,
            inbound_events: 256,
        }
    }
}

/// The relay, reached over WebSocket.
#[derive(Clone)]
pub struct RelayClient {
    clock: Arc<dyn Clock>,
    options: RelayOptions,
}

impl std::fmt::Debug for RelayClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RelayClient").field("options", &self.options).finish_non_exhaustive()
    }
}

impl RelayClient {
    /// `clock` is the wall clock a wake is read from.
    pub fn new(clock: Arc<dyn Clock>) -> Self {
        Self::with_options(clock, RelayOptions::default())
    }

    pub fn with_options(clock: Arc<dyn Clock>, options: RelayOptions) -> Self {
        Self { clock, options }
    }
}

impl Relay for RelayClient {
    fn host(&self, claim: RoomClaim) -> Arc<dyn RoomHosting> {
        Arc::new(hosting::Hosting::start(claim, self.options, self.clock.clone()))
    }

    fn listen(&self, claim: RoomClaim) -> Arc<dyn PipeListener> {
        Arc::new(pipe::Listener::start(self.host(claim)))
    }

    fn dial(&self, join: RoomJoin) -> BoxFuture<'_, Result<Box<dyn RelayPipe>, RelayJoinError>> {
        Box::pin(pipe::dial(join, self.options))
    }
}
