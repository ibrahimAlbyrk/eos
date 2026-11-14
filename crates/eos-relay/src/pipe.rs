//! Byte pipes through the relay: the relay leg of a link between two computers.
//! The pipe carries the link's TLS stream inside `data` envelopes; the relay
//! sees only ciphertext.
//!
//! Owner side: a room, and a pipe per device the relay admits.
//! Device side: join the owner's room and get one pipe back.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use bytes::Bytes;
use eos_core::BoxFuture;
use eos_core::net::relay::{
    PipeListener, RelayClientId, RelayError, RelayJoinError, RelayPipe, RoomEvent, RoomHosting, RoomJoin,
};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{Notify, mpsc};
use tokio::time::{Instant, MissedTickBehavior, interval_at};
use tokio_tungstenite::tungstenite::Message;

use crate::RelayOptions;
use crate::control::{self, Control};
use crate::envelope::{Dir, FrameType, Header, encode_envelope, parse_envelope};
use crate::socket::{self, Outbound, Stream, write_loop};

/// One envelope carries at most this much of a write, as today's sender batches.
const CHUNK_BYTES: usize = 256 * 1024;
/// Chunks a pipe holds unread before the connection stops being read.
const UNREAD_CHUNKS: usize = 8;
/// Admitted devices nobody has accepted yet.
const UNACCEPTED_PIPES: usize = 32;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // Guards plain map and flag updates: a poisoned lock is still valid.
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

/// The reading half both kinds of pipe share.
struct Inbound {
    rx: tokio::sync::Mutex<mpsc::Receiver<Bytes>>,
    /// Closed on this side: nothing more is read or written.
    closed: AtomicBool,
    /// The other end left: writes fail, the reader still gets what arrived.
    ended: AtomicBool,
    gone: Notify,
}

impl Inbound {
    fn new() -> (mpsc::Sender<Bytes>, Arc<Self>) {
        let (tx, rx) = mpsc::channel(UNREAD_CHUNKS);
        let inbound = Self {
            rx: tokio::sync::Mutex::new(rx),
            closed: AtomicBool::new(false),
            ended: AtomicBool::new(false),
            gone: Notify::new(),
        };
        (tx, Arc::new(inbound))
    }

    /// The next chunk; `None` after a local close, or once the feeding side
    /// dropped its sender and everything that arrived was read.
    async fn read(&self) -> Option<Bytes> {
        if self.closed.load(Ordering::SeqCst) {
            return None;
        }
        let mut rx = self.rx.lock().await;
        tokio::select! {
            chunk = rx.recv() => chunk,
            () = self.gone.notified() => None,
        }
    }

    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.gone.notify_waiters();
    }

    fn end(&self) {
        self.ended.store(true, Ordering::SeqCst);
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst) || self.ended.load(Ordering::SeqCst)
    }
}

// ---- owner side -------------------------------------------------------------

type Feeds = Arc<Mutex<HashMap<RelayClientId, (mpsc::Sender<Bytes>, Arc<Inbound>)>>>;

/// A device's pipe on the owner's side.
struct HostedPipe {
    hosting: Arc<dyn RoomHosting>,
    client: RelayClientId,
    inbound: Arc<Inbound>,
    feeds: Feeds,
}

impl RelayPipe for HostedPipe {
    fn write(&self, chunk: Bytes) -> BoxFuture<'_, Result<(), RelayError>> {
        Box::pin(async move {
            let mut rest = chunk;
            while !rest.is_empty() {
                if self.inbound.is_closed() {
                    return Err(RelayError::Closed);
                }
                let piece = rest.split_to(rest.len().min(CHUNK_BYTES));
                self.hosting.send(self.client, piece).await?;
            }
            Ok(())
        })
    }

    fn read(&self) -> BoxFuture<'_, Option<Bytes>> {
        Box::pin(self.inbound.read())
    }

    fn close(&self) {
        self.inbound.close();
        let mut feeds = lock(&self.feeds);
        if feeds.get(&self.client).is_some_and(|(_, inbound)| Arc::ptr_eq(inbound, &self.inbound)) {
            feeds.remove(&self.client);
        }
    }
}

impl Drop for HostedPipe {
    fn drop(&mut self) {
        self.close();
    }
}

/// A room as pipes: every admitted device becomes one.
pub(crate) struct Listener {
    hosting: Arc<dyn RoomHosting>,
    accepted: tokio::sync::Mutex<mpsc::Receiver<Box<dyn RelayPipe>>>,
}

impl Listener {
    pub(crate) fn start(hosting: Arc<dyn RoomHosting>) -> Self {
        let (tx, rx) = mpsc::channel(UNACCEPTED_PIPES);
        tokio::spawn(demux(hosting.clone(), tx));
        Self { hosting, accepted: tokio::sync::Mutex::new(rx) }
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        self.hosting.close();
    }
}

impl PipeListener for Listener {
    fn accept(&self) -> BoxFuture<'_, Option<Box<dyn RelayPipe>>> {
        Box::pin(async move { self.accepted.lock().await.recv().await })
    }

    fn online(&self) -> bool {
        self.hosting.online()
    }

    fn refresh_allow(&self) {
        self.hosting.refresh_allow();
    }

    fn close(&self) {
        self.hosting.close();
    }
}

/// Turns the room's events into pipes and the bytes that flow into them.
async fn demux(hosting: Arc<dyn RoomHosting>, accepted: mpsc::Sender<Box<dyn RelayPipe>>) {
    let feeds: Feeds = Arc::default();
    let drop_all = |feeds: &Feeds| {
        for (_, (_, inbound)) in lock(feeds).drain() {
            inbound.end();
        }
    };
    while let Some(event) = hosting.next().await {
        match event {
            RoomEvent::Joined(client) => {
                let (tx, inbound) = Inbound::new();
                if let Some((_, old)) = lock(&feeds).insert(client, (tx, inbound.clone())) {
                    old.end();
                }
                let pipe = HostedPipe { hosting: hosting.clone(), client, inbound, feeds: feeds.clone() };
                if accepted.send(Box::new(pipe)).await.is_err() {
                    break;
                }
            }
            RoomEvent::Data { client, payload } => {
                let feed = lock(&feeds).get(&client).map(|(tx, inbound)| (tx.clone(), inbound.clone()));
                if let Some((tx, inbound)) = feed {
                    // Waits for the pipe's reader: the room's connection is not
                    // read meanwhile, so the sender is slowed, not buffered.
                    tokio::select! {
                        _ = tx.send(payload) => {}
                        () = inbound.gone.notified() => {}
                    }
                }
            }
            RoomEvent::Left(client) => {
                if let Some((_, inbound)) = lock(&feeds).remove(&client) {
                    inbound.end();
                }
            }
            // The devices of a connection do not outlive it: they join again.
            RoomEvent::Registered | RoomEvent::Offline => drop_all(&feeds),
            RoomEvent::Refused { code, message } => tracing::warn!(%code, %message, "relay error"),
        }
    }
    drop_all(&feeds);
}

// ---- device side ------------------------------------------------------------

/// The pipe a device gets after joining a room.
struct DialledPipe {
    room: String,
    client: RelayClientId,
    out: Outbound,
    inbound: Arc<Inbound>,
}

impl RelayPipe for DialledPipe {
    fn write(&self, chunk: Bytes) -> BoxFuture<'_, Result<(), RelayError>> {
        Box::pin(async move {
            let mut rest = chunk;
            while !rest.is_empty() {
                if self.inbound.is_closed() {
                    return Err(RelayError::Closed);
                }
                let piece = rest.split_to(rest.len().min(CHUNK_BYTES));
                let header = Header::new(FrameType::Data, Dir::C2s, &self.room, self.client);
                let frame = encode_envelope(header, &piece).map_err(|_| RelayError::Closed)?;
                self.out
                    .send(frame)
                    .await
                    .map_err(|e| if e == RelayError::Offline { RelayError::Closed } else { e })?;
            }
            Ok(())
        })
    }

    fn read(&self) -> BoxFuture<'_, Option<Bytes>> {
        Box::pin(self.inbound.read())
    }

    fn close(&self) {
        self.inbound.close();
    }
}

impl Drop for DialledPipe {
    fn drop(&mut self) {
        self.close();
    }
}

fn join_error(code: &str, message: impl Into<String>) -> RelayJoinError {
    RelayJoinError { code: code.to_owned(), message: message.into() }
}

/// Dials the relay, joins the room and waits for the relay to name this
/// device. Everything inside one `join_timeout`.
pub(crate) async fn dial(join: RoomJoin, options: RelayOptions) -> Result<Box<dyn RelayPipe>, RelayJoinError> {
    let admitted = async {
        let (mut sink, mut stream) =
            socket::connect(&join.url, options.connect_timeout).await.map_err(|e| join_error("UNREACHABLE", e))?;
        let hello = control::join(&join.room, &join.bearer).map_err(|e| join_error("BAD_REQUEST", e.to_string()))?;
        sink.send(Message::Binary(hello)).await.map_err(|e| join_error("CLOSED", e.to_string()))?;
        loop {
            let buf = match stream.next().await {
                Some(Ok(Message::Binary(buf))) => buf,
                Some(Ok(Message::Close(_)) | Err(_)) | None => {
                    return Err(join_error("CLOSED", "relay closed the connection"));
                }
                Some(Ok(_)) => continue,
            };
            let Ok(envelope) = parse_envelope(&buf) else { continue };
            let notice = Control::parse(&envelope.payload);
            match envelope.frame_type() {
                Some(FrameType::Error) => {
                    let code = notice.str("code").unwrap_or("RELAY_ERROR");
                    return Err(join_error(code, notice.str("message").unwrap_or("relay refused")));
                }
                Some(FrameType::RelayCtl) if notice.kind() == Some("joined") => {
                    if let Some(client) = notice.client_id() {
                        return Ok((sink, stream, client));
                    }
                }
                _ => {}
            }
        }
    };
    let (sink, stream, client) = match tokio::time::timeout(options.join_timeout, admitted).await {
        Ok(result) => result?,
        Err(_) => return Err(join_error("TIMEOUT", "relay did not admit this device in time")),
    };

    let (out, queue) = Outbound::new(options.outbound_bytes);
    let (urgent, urgent_rx) = mpsc::channel(4);
    let (feed, inbound) = Inbound::new();
    let writer = tokio::spawn(write_loop(sink, queue, urgent_rx));
    tokio::spawn(read_loop(stream, client, feed, inbound.clone(), out.clone(), urgent, writer, options));
    Ok(Box::new(DialledPipe { room: join.room, client, out, inbound }))
}

/// Feeds the pipe from the socket until either ends; pings so a dead socket
/// is noticed and the NAT mapping stays warm.
#[allow(clippy::too_many_arguments)]
async fn read_loop(
    mut stream: Stream,
    client: RelayClientId,
    feed: mpsc::Sender<Bytes>,
    inbound: Arc<Inbound>,
    out: Outbound,
    urgent: mpsc::Sender<Message>,
    mut writer: tokio::task::JoinHandle<()>,
    options: RelayOptions,
) {
    let mut ping = interval_at(Instant::now() + options.pipe_ping_interval, options.pipe_ping_interval);
    ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut alive = true;
    loop {
        tokio::select! {
            () = inbound.gone.notified() => break,
            _ = ping.tick() => {
                if !alive || inbound.is_closed() {
                    break;
                }
                alive = false;
                let _ = urgent.try_send(Message::Ping(Bytes::new()));
            }
            _ = &mut writer => break,
            message = stream.next() => match message {
                Some(Ok(Message::Binary(buf))) => {
                    alive = true;
                    let Ok(envelope) = parse_envelope(&buf) else { continue };
                    if envelope.frame_type() != Some(FrameType::Data) || envelope.client_id != client {
                        continue;
                    }
                    tokio::select! {
                        sent = feed.send(envelope.payload) => if sent.is_err() { break },
                        () = inbound.gone.notified() => break,
                    }
                }
                Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                Some(Ok(_)) => alive = true,
            },
        }
    }
    // Dropping `feed` ends the reader after what is already queued.
    inbound.end();
    out.close();
    writer.abort();
}
