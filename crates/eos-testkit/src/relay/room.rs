//! A relay room held in memory: the test plays the relay and the devices,
//! the code under test owns the room. No socket.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use bytes::Bytes;
use eos_core::BoxFuture;
use eos_core::net::relay::{
    PhonePush, PipeListener, PushResult, PushTarget, Relay, RelayClientId, RelayError, RelayJoinError, RelayPipe,
    RoomClaim, RoomEvent, RoomHosting, RoomJoin,
};
use eos_relay::envelope::MAX_ENVELOPE_BYTES;
use tokio::sync::{Notify, mpsc};

/// A room id as long as the real ones (43 characters), for the size of an envelope.
const ROOM_OF_USUAL_LENGTH: &str = "0123456789012345678901234567890123456789012";

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

/// A room the code under test hosts. `push` plays the relay; `sent` is what
/// the host sent to each device.
pub struct FakeRoom {
    events_tx: mpsc::UnboundedSender<RoomEvent>,
    events_rx: tokio::sync::Mutex<mpsc::UnboundedReceiver<RoomEvent>>,
    sent: Mutex<Vec<(RelayClientId, Bytes)>>,
    changed: Notify,
    online: AtomicBool,
    behind: AtomicBool,
    closed: AtomicBool,
    refreshes: AtomicUsize,
    /// Events pushed, and how often the host asked for the next one.
    pushed: AtomicUsize,
    asked: AtomicUsize,
    /// Wake-up pushes asked for on the room's connection, and the relay's answer.
    phone_pushes: Mutex<Vec<PhonePush>>,
    push_answer: Mutex<Result<PushResult, RelayError>>,
}

/// A relay with one phone that has a push token, and a key to reach Apple.
fn one_phone() -> PushResult {
    PushResult { sent: 1, ..PushResult::default() }
}

impl std::fmt::Debug for FakeRoom {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FakeRoom").field("sent", &lock(&self.sent).len()).finish_non_exhaustive()
    }
}

impl Default for FakeRoom {
    fn default() -> Self {
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        Self {
            events_tx,
            events_rx: tokio::sync::Mutex::new(events_rx),
            sent: Mutex::default(),
            changed: Notify::new(),
            online: AtomicBool::new(true),
            behind: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            refreshes: AtomicUsize::new(0),
            pushed: AtomicUsize::new(0),
            asked: AtomicUsize::new(0),
            phone_pushes: Mutex::default(),
            push_answer: Mutex::new(Ok(one_phone())),
        }
    }
}

impl FakeRoom {
    /// Something happens in the room.
    pub fn push(&self, event: RoomEvent) {
        self.pushed.fetch_add(1, Ordering::SeqCst);
        let _ = self.events_tx.send(event);
    }

    /// Resolves once the host took every event pushed so far and came back
    /// for the next: whatever it does with an event before reading on is done.
    pub async fn idle(&self) {
        let quiet = async {
            loop {
                let changed = self.changed.notified();
                if self.asked.load(Ordering::SeqCst) > self.pushed.load(Ordering::SeqCst) {
                    return;
                }
                changed.await;
            }
        };
        tokio::time::timeout(Duration::from_secs(10), quiet).await.expect("the host stopped reading its room");
    }

    /// A device sends `payload`.
    pub fn data(&self, client: RelayClientId, payload: impl Into<Bytes>) {
        self.push(RoomEvent::Data { client, payload: payload.into() });
    }

    /// Every payload sent to `client`, in order.
    pub fn sent(&self, client: RelayClientId) -> Vec<Bytes> {
        lock(&self.sent).iter().filter(|(to, _)| *to == client).map(|(_, payload)| payload.clone()).collect()
    }

    /// Waits until `client` was sent at least `count` payloads, then returns
    /// them all. Panics when they do not arrive.
    pub async fn wait_sent(&self, client: RelayClientId, count: usize) -> Vec<Bytes> {
        let arrive = async {
            loop {
                let changed = self.changed.notified();
                let sent = self.sent(client);
                if sent.len() >= count {
                    return sent;
                }
                changed.await;
            }
        };
        match tokio::time::timeout(Duration::from_secs(10), arrive).await {
            Ok(sent) => sent,
            Err(_) => panic!("expected {count} payloads for the device, got {}", self.sent(client).len()),
        }
    }

    /// While behind, the queue towards the relay is full: `try_send` fails
    /// and `send` waits.
    pub fn set_behind(&self, behind: bool) {
        self.behind.store(behind, Ordering::SeqCst);
        self.changed.notify_waiters();
    }

    pub fn set_online(&self, online: bool) {
        self.online.store(online, Ordering::SeqCst);
    }

    /// Wake-up pushes asked for on this room's connection, in order.
    pub fn phone_pushes(&self) -> Vec<PhonePush> {
        lock(&self.phone_pushes).clone()
    }

    /// How the relay answers a push from here on; one phone reached at first.
    pub fn answer_pushes(&self, answer: Result<PushResult, RelayError>) {
        *lock(&self.push_answer) = answer;
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// How often the admission list was sent again.
    pub fn refreshes(&self) -> usize {
        self.refreshes.load(Ordering::SeqCst)
    }

    fn deliver(&self, client: RelayClientId, payload: Bytes) -> Result<(), RelayError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(RelayError::Closed);
        }
        if !self.online.load(Ordering::SeqCst) {
            return Err(RelayError::Offline);
        }
        // As the real connection: the envelope around the payload must fit the relay's limit.
        let size = payload.len() + eos_relay::envelope::overhead(ROOM_OF_USUAL_LENGTH);
        if size > MAX_ENVELOPE_BYTES {
            return Err(RelayError::TooLarge { size, limit: MAX_ENVELOPE_BYTES });
        }
        lock(&self.sent).push((client, payload));
        self.changed.notify_waiters();
        Ok(())
    }
}

impl RoomHosting for FakeRoom {
    fn next(&self) -> BoxFuture<'_, Option<RoomEvent>> {
        Box::pin(async move {
            if self.closed.load(Ordering::SeqCst) {
                return None;
            }
            // The n-th ask follows n - 1 events: more asks than pushes means all were handled.
            self.asked.fetch_add(1, Ordering::SeqCst);
            self.changed.notify_waiters();
            self.events_rx.lock().await.recv().await
        })
    }

    fn send(&self, client: RelayClientId, payload: Bytes) -> BoxFuture<'_, Result<(), RelayError>> {
        Box::pin(async move {
            loop {
                let changed = self.changed.notified();
                if !self.behind.load(Ordering::SeqCst) {
                    return self.deliver(client, payload);
                }
                changed.await;
            }
        })
    }

    fn try_send(&self, client: RelayClientId, payload: Bytes) -> Result<(), RelayError> {
        if self.behind.load(Ordering::SeqCst) {
            return Err(RelayError::Behind);
        }
        self.deliver(client, payload)
    }

    fn online(&self) -> bool {
        self.online.load(Ordering::SeqCst)
    }

    fn refresh_allow(&self) {
        self.refreshes.fetch_add(1, Ordering::SeqCst);
    }

    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        // Ends a reader that is waiting.
        self.push(RoomEvent::Offline);
    }

    fn push(&self, push: PhonePush) -> BoxFuture<'_, Result<PushResult, RelayError>> {
        Box::pin(async move {
            if !self.online.load(Ordering::SeqCst) || self.closed.load(Ordering::SeqCst) {
                return Err(RelayError::Offline);
            }
            lock(&self.phone_pushes).push(push);
            lock(&self.push_answer).clone()
        })
    }
}

/// A relay that hands out [`FakeRoom`]s and remembers what was claimed.
#[derive(Default)]
pub struct FakeRelayPort {
    rooms: Mutex<Vec<(RoomClaim, Arc<FakeRoom>)>>,
    /// Pushes asked for over HTTP, and the relay's answer; `None`: one phone reached.
    http_pushes: Mutex<Vec<(PushTarget, PhonePush)>>,
    http_answer: Mutex<Option<Result<PushResult, eos_core::Error>>>,
}

impl std::fmt::Debug for FakeRelayPort {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FakeRelayPort").field("rooms", &lock(&self.rooms).len()).finish()
    }
}

impl FakeRelayPort {
    pub fn new() -> Self {
        Self::default()
    }

    /// Every room claimed so far, oldest first.
    pub fn claims(&self) -> Vec<RoomClaim> {
        lock(&self.rooms).iter().map(|(claim, _)| claim.clone()).collect()
    }

    /// The room claimed last; panics when none was.
    pub fn room(&self) -> Arc<FakeRoom> {
        lock(&self.rooms).last().map(|(_, room)| room.clone()).expect("no room was claimed")
    }

    /// Pushes asked for over HTTP, in order.
    pub fn http_pushes(&self) -> Vec<(PushTarget, PhonePush)> {
        lock(&self.http_pushes).clone()
    }

    /// How the relay answers a push over HTTP from here on.
    pub fn answer_http_pushes(&self, answer: Result<PushResult, eos_core::Error>) {
        *lock(&self.http_answer) = Some(answer);
    }

    /// Rooms claimed and not given up.
    pub fn open_rooms(&self) -> usize {
        lock(&self.rooms).iter().filter(|(_, room)| !room.is_closed()).count()
    }
}

impl Relay for FakeRelayPort {
    fn host(&self, claim: RoomClaim) -> Arc<dyn RoomHosting> {
        let room = Arc::new(FakeRoom::default());
        lock(&self.rooms).push((claim, room.clone()));
        room.push(RoomEvent::Registered);
        room
    }

    fn listen(&self, _claim: RoomClaim) -> Arc<dyn PipeListener> {
        unimplemented!("FakeRelayPort hosts rooms; pipes need the fake relay server")
    }

    fn dial(&self, _join: RoomJoin) -> BoxFuture<'_, Result<Box<dyn RelayPipe>, RelayJoinError>> {
        Box::pin(async {
            Err(RelayJoinError { code: "UNREACHABLE".into(), message: "FakeRelayPort has no relay behind it".into() })
        })
    }

    fn push(&self, target: PushTarget, push: PhonePush) -> BoxFuture<'_, Result<PushResult, eos_core::Error>> {
        Box::pin(async move {
            lock(&self.http_pushes).push((target, push));
            lock(&self.http_answer).clone().unwrap_or_else(|| Ok(one_phone()))
        })
    }
}
