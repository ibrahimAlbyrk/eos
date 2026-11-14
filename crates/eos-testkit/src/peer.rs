//! Fakes of the peering ports: a relay that joins two ends in memory, and a
//! recorder of what the peer link announces.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use bytes::Bytes;
use eos_core::BoxFuture;
use eos_core::net::peer::{ConnectedDevice, PeerEvents};
use eos_core::net::relay::{
    PipeListener, Relay, RelayError, RelayJoinError, RelayPipe, RoomClaim, RoomHosting, RoomJoin,
};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex as AsyncMutex, mpsc};

/// One end of a pipe held in memory: what it writes, the other end reads;
/// closing or dropping an end ends the other's reads.
struct MemoryPipe {
    incoming: AsyncMutex<mpsc::Receiver<Bytes>>,
    outgoing: Mutex<Option<mpsc::Sender<Bytes>>>,
}

fn pipe_pair() -> (MemoryPipe, MemoryPipe) {
    let (a_tx, a_rx) = mpsc::channel(8);
    let (b_tx, b_rx) = mpsc::channel(8);
    let end = |rx, tx| MemoryPipe { incoming: AsyncMutex::new(rx), outgoing: Mutex::new(Some(tx)) };
    (end(a_rx, b_tx), end(b_rx, a_tx))
}

impl RelayPipe for MemoryPipe {
    fn write(&self, chunk: Bytes) -> BoxFuture<'_, Result<(), RelayError>> {
        let sender = self.outgoing.lock().unwrap_or_else(PoisonError::into_inner).clone();
        Box::pin(async move {
            match sender {
                Some(sender) => sender.send(chunk).await.map_err(|_| RelayError::Closed),
                None => Err(RelayError::Closed),
            }
        })
    }

    fn read(&self) -> BoxFuture<'_, Option<Bytes>> {
        Box::pin(async move { self.incoming.lock().await.recv().await })
    }

    fn close(&self) {
        self.outgoing.lock().unwrap_or_else(PoisonError::into_inner).take();
    }
}

struct Room {
    owner: String,
    allow: Arc<dyn Fn() -> Vec<String> + Send + Sync>,
    pipes: mpsc::Sender<Box<dyn RelayPipe>>,
}

type Rooms = Arc<Mutex<HashMap<String, Room>>>;

/// A relay's pipes in memory, with the real relay's admission rule: a room
/// exists while its owner keeps it open, and a device is let in when the
/// SHA-256 of its bearer is on the room's allow list. For the link between
/// two computers; the phone link's fakes are the relay server's.
#[derive(Default)]
pub struct InMemoryRelay {
    rooms: Rooms,
    joins: AtomicUsize,
    unreachable: AtomicBool,
}

impl std::fmt::Debug for InMemoryRelay {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InMemoryRelay").field("joins", &self.joins()).finish_non_exhaustive()
    }
}

impl InMemoryRelay {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// How many devices were let in.
    pub fn joins(&self) -> usize {
        self.joins.load(Ordering::Relaxed)
    }

    /// The owner secret a room was opened with.
    pub fn owner_of(&self, room: &str) -> Option<String> {
        self.rooms.lock().unwrap_or_else(PoisonError::into_inner).get(room).map(|r| r.owner.clone())
    }

    /// Makes every dial fail as if the relay could not be reached.
    pub fn set_unreachable(&self, unreachable: bool) {
        self.unreachable.store(unreachable, Ordering::Relaxed);
    }
}

struct OpenRoom {
    rooms: Rooms,
    room: String,
    pipes: AsyncMutex<mpsc::Receiver<Box<dyn RelayPipe>>>,
    closed: tokio::sync::Notify,
}

impl PipeListener for OpenRoom {
    fn accept(&self) -> BoxFuture<'_, Option<Box<dyn RelayPipe>>> {
        Box::pin(async move {
            let mut pipes = self.pipes.lock().await;
            tokio::select! {
                pipe = pipes.recv() => pipe,
                () = self.closed.notified() => None,
            }
        })
    }

    fn online(&self) -> bool {
        self.rooms.lock().unwrap_or_else(PoisonError::into_inner).contains_key(&self.room)
    }

    fn refresh_allow(&self) {}

    fn close(&self) {
        self.rooms.lock().unwrap_or_else(PoisonError::into_inner).remove(&self.room);
        self.closed.notify_one();
    }
}

impl Relay for InMemoryRelay {
    fn host(&self, _claim: RoomClaim) -> Arc<dyn RoomHosting> {
        unimplemented!("InMemoryRelay carries pipes; the phone link's rooms need the fake relay server")
    }

    fn listen(&self, claim: RoomClaim) -> Arc<dyn PipeListener> {
        let (tx, rx) = mpsc::channel(32);
        let room = claim.room.clone();
        let entry = Room { owner: claim.owner, allow: claim.allow, pipes: tx };
        self.rooms.lock().unwrap_or_else(PoisonError::into_inner).insert(room.clone(), entry);
        Arc::new(OpenRoom {
            rooms: self.rooms.clone(),
            room,
            pipes: AsyncMutex::new(rx),
            closed: tokio::sync::Notify::new(),
        })
    }

    fn dial(&self, join: RoomJoin) -> BoxFuture<'_, Result<Box<dyn RelayPipe>, RelayJoinError>> {
        Box::pin(async move {
            let refused =
                |code: &str, message: &str| RelayJoinError { code: code.to_owned(), message: message.to_owned() };
            if self.unreachable.load(Ordering::Relaxed) {
                return Err(refused("UNREACHABLE", "the relay did not answer"));
            }
            let (allow, pipes) = {
                let rooms = self.rooms.lock().unwrap_or_else(PoisonError::into_inner);
                let room = rooms.get(&join.room).ok_or_else(|| refused("ROOM_NOT_FOUND", "no such room"))?;
                (room.allow.clone(), room.pipes.clone())
            };
            let presented =
                Sha256::digest(join.bearer.as_bytes()).iter().map(|b| format!("{b:02x}")).collect::<String>();
            if !allow().contains(&presented) {
                return Err(refused("BEARER_DENIED", "bearer not allowed"));
            }
            let (device, host) = pipe_pair();
            pipes.send(Box::new(host)).await.map_err(|_| refused("ROOM_NOT_FOUND", "no such room"))?;
            self.joins.fetch_add(1, Ordering::Relaxed);
            Ok(Box::new(device) as Box<dyn RelayPipe>)
        })
    }
}

/// Everything the peer link announced, in order.
#[derive(Debug, Default)]
pub struct RecordedPeerEvents {
    presence: Mutex<Vec<Vec<ConnectedDevice>>>,
    host_changes: Mutex<Vec<String>>,
    notifications: Mutex<Vec<serde_json::Value>>,
}

impl RecordedPeerEvents {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// The devices connected at the last announcement.
    pub fn connected(&self) -> Vec<ConnectedDevice> {
        self.presence.lock().unwrap_or_else(PoisonError::into_inner).last().cloned().unwrap_or_default()
    }

    pub fn host_changes(&self) -> Vec<String> {
        self.host_changes.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    pub fn notifications(&self) -> Vec<serde_json::Value> {
        self.notifications.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }
}

impl PeerEvents for RecordedPeerEvents {
    fn presence(&self, devices: Vec<ConnectedDevice>) {
        self.presence.lock().unwrap_or_else(PoisonError::into_inner).push(devices);
    }

    fn host_changed(&self, host_id: &str) {
        self.host_changes.lock().unwrap_or_else(PoisonError::into_inner).push(host_id.to_owned());
    }

    fn notification(&self, payload: serde_json::Value) {
        self.notifications.lock().unwrap_or_else(PoisonError::into_inner).push(payload);
    }
}
