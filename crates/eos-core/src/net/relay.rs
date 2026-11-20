//! The relay: a server both ends dial out to, which forwards between the owner
//! of a room and the devices that joined it.
//!
//! Two shapes of the same thing:
//! - [`Relay::host`]: own a room and exchange whole messages with each device
//!   in it — the phone link;
//! - [`Relay::listen`] / [`Relay::dial`]: a byte pipe to the other end of a
//!   room — the leg of a link between two computers when neither can reach
//!   the other directly.
//!
//! Every queue behind these is bounded. A `send` or `write` waits while the
//! connection to the relay is slow; nothing here buffers without limit.

use std::fmt;
use std::sync::Arc;

use bytes::Bytes;

use crate::BoxFuture;

/// The id the relay gives a device when it joins a room. Hex in logs,
/// unpadded base64url in the relay's own messages.
pub type RelayClientId = [u8; 16];

/// A room to own on a relay.
#[derive(Clone)]
pub struct RoomClaim {
    /// Where both ends dial (`wss://…`).
    pub url: String,
    /// The room: routing key and capability. At most 255 bytes of ASCII.
    pub room: String,
    /// The owner's secret. The relay keeps its hash and pins the first one it sees.
    pub owner: String,
    /// Who may join: the hex SHA-256 of each bearer. Read at every
    /// registration, so a redial always sends the current list.
    pub allow: Arc<dyn Fn() -> Vec<String> + Send + Sync>,
}

impl fmt::Debug for RoomClaim {
    // The room and the owner secret are credentials: never in a log.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RoomClaim").field("url", &self.url).finish_non_exhaustive()
    }
}

/// What happens in a room this computer owns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoomEvent {
    /// The room is registered on a fresh connection. Every device that joined
    /// through the previous one is gone and will join again.
    Registered,
    /// The connection to the relay is gone; a redial follows.
    Offline,
    Joined(RelayClientId),
    Left(RelayClientId),
    /// A message from one device, as it sent it.
    Data {
        client: RelayClientId,
        payload: Bytes,
    },
    /// The relay refused something of ours (its code and message).
    Refused {
        code: String,
        message: String,
    },
}

/// Why a message did not leave.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RelayError {
    /// No connection to the relay right now. What was meant for a device of
    /// the old connection is void anyway: devices join again after a redial.
    #[error("the relay is not connected")]
    Offline,
    /// The queue towards the relay is full ([`RoomHosting::try_send`] only).
    #[error("the relay connection is behind")]
    Behind,
    /// The relay carries at most 5 MiB per message.
    #[error("a relay message of {size} bytes is over the {limit} byte limit")]
    TooLarge { size: usize, limit: usize },
    /// The room was given up, or the pipe closed.
    #[error("closed")]
    Closed,
}

/// A room this computer owns, kept registered until closed: the connection
/// is redialled with back-off, and at once after the computer wakes.
pub trait RoomHosting: Send + Sync + 'static {
    /// The next thing that happened; `None` once closed. One reader. Events
    /// wait in a bounded queue: a reader that stops reading stops the
    /// connection being read, it does not grow a queue.
    fn next(&self) -> BoxFuture<'_, Option<RoomEvent>>;
    /// Sends `payload` to one device. Waits for room in the queue towards the
    /// relay: the back-pressure. Messages leave in the order they got room.
    fn send(&self, client: RelayClientId, payload: Bytes) -> BoxFuture<'_, Result<(), RelayError>>;
    /// [`send`](Self::send) for a caller that cannot wait: fails with
    /// [`RelayError::Behind`] when the queue is full or others are waiting
    /// for room (so it never jumps ahead of them).
    fn try_send(&self, client: RelayClientId, payload: Bytes) -> Result<(), RelayError>;
    /// Whether the room is registered right now.
    fn online(&self) -> bool;
    /// Sends the admission list again on the live connection.
    fn refresh_allow(&self);
    /// Gives the room up: the connection closes, which takes its devices with it.
    fn close(&self);
    /// Asks the relay, on the owner's own connection, to wake the room's
    /// phones, and waits for its answer. [`RelayError::Offline`] when there is
    /// no connection: nothing was sent.
    fn push(&self, push: PhonePush) -> BoxFuture<'_, Result<PushResult, RelayError>>;
}

/// A byte pipe through the relay. Bytes arrive in order and whole; chunk
/// boundaries mean nothing.
pub trait RelayPipe: Send + Sync + 'static {
    /// Sends `chunk`, waiting while the connection to the relay is slow.
    fn write(&self, chunk: Bytes) -> BoxFuture<'_, Result<(), RelayError>>;
    /// The next bytes; `None` once the other end left or the relay closed. One reader.
    fn read(&self) -> BoxFuture<'_, Option<Bytes>>;
    fn close(&self);
}

/// A room this computer owns, as pipes: one per device that joins.
pub trait PipeListener: Send + Sync + 'static {
    /// The next device's pipe; `None` once closed. One reader.
    fn accept(&self) -> BoxFuture<'_, Option<Box<dyn RelayPipe>>>;
    fn online(&self) -> bool;
    fn refresh_allow(&self);
    fn close(&self);
}

/// A room to join as a device.
#[derive(Clone)]
pub struct RoomJoin {
    pub url: String,
    pub room: String,
    /// What the room's owner listed the hash of.
    pub bearer: String,
}

impl fmt::Debug for RoomJoin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RoomJoin").field("url", &self.url).finish_non_exhaustive()
    }
}

/// Why a room could not be joined. `code` is the relay's own
/// (`ROOM_NOT_FOUND`, `BEARER_DENIED`, `ROOM_FULL`, …) or one of `TIMEOUT`,
/// `CLOSED`, `UNREACHABLE` when the relay never answered.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct RelayJoinError {
    pub code: String,
    pub message: String,
}

pub trait Relay: Send + Sync + 'static {
    /// Claims the room and keeps it. Call inside the async runtime.
    fn host(&self, claim: RoomClaim) -> Arc<dyn RoomHosting>;
    /// Claims the room and hands out a pipe per device. Call inside the async runtime.
    fn listen(&self, claim: RoomClaim) -> Arc<dyn PipeListener>;
    /// Joins a room; resolves with the pipe once the relay admitted this device.
    fn dial(&self, join: RoomJoin) -> BoxFuture<'_, Result<Box<dyn RelayPipe>, RelayJoinError>>;
    /// Asks the relay over HTTP to wake the room's phones, for when the room's
    /// connection is not held. A room the relay never saw registered is
    /// [`Error::NotFound`](crate::Error::NotFound).
    fn push(&self, target: PushTarget, push: PhonePush) -> BoxFuture<'_, Result<PushResult, crate::Error>>;
}

/// What a wake-up push says: a closed kind and a count, never a title, a
/// name or anything a person, an agent or an outside service wrote. The
/// relay builds the phone's text from its own table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PhonePush {
    pub kind: PushKind,
    pub count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushKind {
    NeedsYou,
    RunFailed,
    RoutinePaused,
    Ready,
    Test,
}

impl PushKind {
    /// The word on the relay's wire.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NeedsYou => "needs_you",
            Self::RunFailed => "run_failed",
            Self::RoutinePaused => "routine_paused",
            Self::Ready => "ready",
            Self::Test => "test",
        }
    }
}

/// Where a push goes over HTTP: the relay's URL (`wss://…`, as the room's),
/// the room, and the owner's secret that proves the room is this computer's.
#[derive(Clone)]
pub struct PushTarget {
    pub url: String,
    pub room: String,
    pub owner: String,
}

impl fmt::Debug for PushTarget {
    // The room and the owner secret are credentials: never in a log.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PushTarget").field("url", &self.url).finish_non_exhaustive()
    }
}

/// The relay's answer to a push: phones reached, phones not reached, phones
/// Apple called gone, and why nothing was tried (`throttled`,
/// `not-configured`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PushResult {
    pub sent: u32,
    pub failed: u32,
    pub gone: u32,
    pub reason: Option<String>,
}

/// How a push ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushOutcome {
    /// Apple took it for `devices` phones; `failed` were not reached.
    Sent { devices: u32, failed: u32 },
    /// The room has no phone that can be woken.
    NoDevices,
    /// No phone was ever paired with this computer, or this app reaches no relay.
    LinkOff,
    /// The room asked for too many pushes lately.
    Throttled,
    /// The relay holds no key to reach Apple with; `failed` phones were not reached.
    NotConfigured { failed: u32 },
}

impl From<PushResult> for PushOutcome {
    fn from(result: PushResult) -> Self {
        match result.reason.as_deref() {
            Some("throttled") => Self::Throttled,
            Some("not-configured") => Self::NotConfigured { failed: result.failed },
            _ if result.sent + result.failed + result.gone == 0 => Self::NoDevices,
            _ => Self::Sent { devices: result.sent, failed: result.failed + result.gone },
        }
    }
}

/// Wakes the user's phone with a kind and a count.
pub trait PhoneNotify: Send + Sync + 'static {
    /// An error means the relay was not reached or refused this computer:
    /// the caller falls back to what it shows on this computer.
    fn push(&self, push: PhonePush) -> BoxFuture<'_, Result<PushOutcome, crate::Error>>;
}
