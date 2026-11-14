//! A relay inside the test process: `relay/server.ts` on a loopback port.
//!
//! It forwards as the real one does, including what the real one lacks: a
//! frame for a slow socket is queued without limit. Tests that need a relay
//! which stops answering use [`FakeRelay::freeze`].

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use bytes::Bytes;
use eos_relay::control::{self, Control};
use eos_relay::envelope::{FrameType, MAX_ENVELOPE_BYTES, MAX_MESSAGE_BYTES, parse_envelope};
use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio::task::{AbortHandle, JoinHandle};
use tokio::time::{Instant, MissedTickBehavior, interval_at};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

use super::registry::{Dropped, RelayErrorCode, RelaySocket, RoomRegistry, SocketRef};

#[derive(Debug, Clone, Default)]
pub struct FakeRelayOptions {
    /// Ping every socket this often and drop the ones that did not answer
    /// the previous ping (`RELAY_HEARTBEAT_MS`); `None`: never.
    pub heartbeat: Option<Duration>,
    pub owner_hash_pin: Option<String>,
    pub max_room_devices: Option<usize>,
}

/// One `register` the relay received.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Registration {
    pub room: String,
    pub owner: String,
    pub allow: Vec<String>,
}

enum Out {
    Frame(Bytes),
    Ping,
    Close,
}

struct Conn {
    tx: mpsc::UnboundedSender<Out>,
}

impl RelaySocket for Conn {
    fn send(&self, data: Bytes) {
        let _ = self.tx.send(Out::Frame(data));
    }
    fn close(&self) {
        let _ = self.tx.send(Out::Close);
    }
}

struct State {
    registry: Mutex<RoomRegistry>,
    conns: Mutex<HashMap<u64, AbortHandle>>,
    next_conn: AtomicU64,
    frozen: watch::Sender<bool>,
    heartbeat: Option<Duration>,
    registrations: Mutex<Vec<Registration>>,
    push_intents: AtomicUsize,
    forwarded: AtomicUsize,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

/// A relay on `127.0.0.1`. Dropping it closes the listener and every socket.
pub struct FakeRelay {
    addr: SocketAddr,
    state: Arc<State>,
    accept: JoinHandle<()>,
}

impl std::fmt::Debug for FakeRelay {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FakeRelay").field("addr", &self.addr).finish_non_exhaustive()
    }
}

/// A loopback port nothing listens on (it was just bound and released).
pub async fn free_port() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a loopback port");
    listener.local_addr().expect("its address")
}

impl FakeRelay {
    pub async fn start() -> Self {
        Self::start_with(FakeRelayOptions::default()).await
    }

    pub async fn start_with(options: FakeRelayOptions) -> Self {
        Self::start_at("127.0.0.1:0".parse().expect("an address"), options).await
    }

    /// Listens on `addr`, which must be a loopback address.
    pub async fn start_at(addr: SocketAddr, options: FakeRelayOptions) -> Self {
        assert!(addr.ip().is_loopback(), "a test relay listens on loopback only");
        let listener = TcpListener::bind(addr).await.expect("the relay's port");
        let addr = listener.local_addr().expect("its address");
        let state = Arc::new(State {
            registry: Mutex::new(RoomRegistry::new(options.owner_hash_pin, options.max_room_devices.unwrap_or(32))),
            conns: Mutex::default(),
            next_conn: AtomicU64::new(0),
            frozen: watch::channel(false).0,
            heartbeat: options.heartbeat,
            registrations: Mutex::default(),
            push_intents: AtomicUsize::new(0),
            forwarded: AtomicUsize::new(0),
        });
        let accepting = state.clone();
        let accept = tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let id = accepting.next_conn.fetch_add(1, Ordering::SeqCst);
                let task = tokio::spawn(serve(accepting.clone(), id, tcp));
                lock(&accepting.conns).insert(id, task.abort_handle());
            }
        });
        Self { addr, state, accept }
    }

    pub fn url(&self) -> String {
        format!("ws://{}/", self.addr)
    }

    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    pub fn room_count(&self) -> usize {
        lock(&self.state.registry).room_count()
    }

    pub fn device_count(&self, room: &str) -> usize {
        lock(&self.state.registry).device_count(room)
    }

    /// Sockets open right now.
    pub fn connections(&self) -> usize {
        lock(&self.state.conns).len()
    }

    /// Every socket the relay ever accepted.
    pub fn accepted(&self) -> u64 {
        self.state.next_conn.load(Ordering::SeqCst)
    }

    pub fn registrations(&self) -> Vec<Registration> {
        lock(&self.state.registrations).clone()
    }

    /// `pushIntent` messages received: requests to wake a phone through APNs.
    pub fn push_intents(&self) -> usize {
        self.state.push_intents.load(Ordering::SeqCst)
    }

    /// Data frames forwarded so far.
    pub fn forwarded(&self) -> usize {
        self.state.forwarded.load(Ordering::SeqCst)
    }

    /// While frozen the relay reads nothing: no pong, no forwarding. What its
    /// peers send piles up in the sockets.
    pub fn freeze(&self, frozen: bool) {
        self.state.frozen.send_replace(frozen);
    }

    /// Cuts every socket, as a relay restart does; keeps listening.
    pub fn drop_connections(&self) {
        let conns: Vec<AbortHandle> = lock(&self.state.conns).drain().map(|(_, task)| task).collect();
        for task in conns {
            task.abort();
        }
    }

    /// Stops listening and cuts every socket. Nothing is left running.
    pub async fn stop(self) {
        self.accept.abort();
        self.drop_connections();
        // The port is free once the accept loop is gone.
        while !self.accept.is_finished() {
            tokio::task::yield_now().await;
        }
    }
}

impl Drop for FakeRelay {
    fn drop(&mut self) {
        self.accept.abort();
        self.drop_connections();
    }
}

/// Runs when the connection's task ends, however it ends.
struct Leaving {
    state: Arc<State>,
    id: u64,
    socket: SocketRef,
}

impl Drop for Leaving {
    fn drop(&mut self) {
        lock(&self.state.conns).remove(&self.id);
        let dropped = lock(&self.state.registry).drop_socket(&self.socket);
        if let Some(Dropped::Device { room, client, mac: Some(mac) }) = dropped
            && let Ok(notice) = control::left(&room, client)
        {
            mac.send(notice);
        }
    }
}

async fn serve(state: Arc<State>, id: u64, tcp: TcpStream) {
    let config =
        WebSocketConfig::default().max_message_size(Some(MAX_MESSAGE_BYTES)).max_frame_size(Some(MAX_MESSAGE_BYTES));
    let Ok(ws) = tokio_tungstenite::accept_async_with_config(tcp, Some(config)).await else {
        lock(&state.conns).remove(&id);
        return;
    };
    let (mut sink, mut stream) = ws.split();
    // Without a bound, as the relay's own `socket.send`.
    let (tx, mut rx) = mpsc::unbounded_channel();
    let socket: SocketRef = Arc::new(Conn { tx: tx.clone() });
    let _leaving = Leaving { state: state.clone(), id, socket: socket.clone() };
    let writer = tokio::spawn(async move {
        while let Some(out) = rx.recv().await {
            let sent = match out {
                Out::Frame(frame) => sink.send(Message::Binary(frame)).await,
                Out::Ping => sink.send(Message::Ping(Bytes::new())).await,
                Out::Close => {
                    let _ = sink.close().await;
                    return;
                }
            };
            if sent.is_err() {
                return;
            }
        }
    });
    let _stop_writer = AbortOnDrop(writer.abort_handle());

    let mut frozen = state.frozen.subscribe();
    let period = state.heartbeat.unwrap_or(Duration::from_secs(3600));
    let mut heartbeat = interval_at(Instant::now() + period, period);
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut alive = true;
    loop {
        let reading = !*frozen.borrow_and_update();
        tokio::select! {
            _ = frozen.changed() => {}
            _ = heartbeat.tick(), if state.heartbeat.is_some() => {
                if !alive {
                    return;
                }
                alive = false;
                let _ = tx.send(Out::Ping);
            }
            message = stream.next(), if reading => match message {
                Some(Ok(Message::Binary(raw))) => handle_message(&state, &socket, raw),
                Some(Ok(Message::Pong(_))) => alive = true,
                Some(Ok(Message::Close(_)) | Err(_)) | None => return,
                Some(Ok(_)) => {}
            },
        }
    }
}

struct AbortOnDrop(AbortHandle);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn send_error(socket: &SocketRef, room: &str, code: RelayErrorCode, message: &str) {
    if let Ok(frame) = control::error(room, code.as_str(), message) {
        socket.send(frame);
    }
}

fn handle_message(state: &State, socket: &SocketRef, raw: Bytes) {
    if raw.len() > MAX_ENVELOPE_BYTES {
        send_error(socket, "", RelayErrorCode::FrameTooLarge, "envelope exceeds 5 MiB");
        return;
    }
    let Ok(envelope) = parse_envelope(&raw) else { return };
    if envelope.frame_type() == Some(FrameType::Data) {
        // Forwarded as it came; the payload is never looked at.
        let routed = lock(&state.registry).route_data(&envelope.room, envelope.dir, &envelope.client_id, raw);
        match routed {
            Ok(()) => {
                state.forwarded.fetch_add(1, Ordering::SeqCst);
            }
            Err(code) => send_error(socket, &envelope.room, code, "no route for frame"),
        }
        return;
    }
    let body = Control::parse(&envelope.payload);
    let room = body.str("room").unwrap_or(&envelope.room).to_owned();
    match envelope.frame_type() {
        Some(FrameType::Register) => {
            let owner = body.str("owner").unwrap_or_default();
            if !body.is_object() || owner.is_empty() || room.is_empty() {
                send_error(socket, &room, RelayErrorCode::BadRequest, "register needs room + owner");
                return;
            }
            let allow = body.strings("allow");
            lock(&state.registrations).push(Registration {
                room: room.clone(),
                owner: owner.to_owned(),
                allow: allow.clone(),
            });
            match lock(&state.registry).register(&room, owner, &allow, socket) {
                Err(code) => send_error(socket, &room, code, "register rejected"),
                Ok(_) => {
                    if let Ok(notice) = control::registered(&room) {
                        socket.send(notice);
                    }
                }
            }
        }
        Some(FrameType::Join) => {
            let bearer = body.str("bearer").unwrap_or_default();
            // Silence here would leave the device waiting for its join-ack forever.
            if !body.is_object() || bearer.is_empty() || room.is_empty() {
                send_error(socket, &room, RelayErrorCode::BadRequest, "join needs room + bearer");
                return;
            }
            match lock(&state.registry).join(&room, bearer, socket) {
                Err(code) => send_error(socket, &room, code, "join rejected"),
                // Both are told: the owner starts the device's session, the
                // device learns the id it must put on every frame.
                Ok((client, mac)) => {
                    if let Ok(notice) = control::joined(&room, client) {
                        mac.send(notice.clone());
                        socket.send(notice);
                    }
                }
            }
        }
        Some(FrameType::RelayCtl) => match body.kind() {
            Some(kind @ ("allow-add" | "allow-remove")) if !room.is_empty() => {
                let Some(hash) = body.str("hash") else { return };
                if let Err(code) = lock(&state.registry).update_allow(&room, kind == "allow-add", hash, socket) {
                    send_error(socket, &room, code, "allowlist update rejected");
                }
            }
            Some("pushIntent") => {
                state.push_intents.fetch_add(1, Ordering::SeqCst);
            }
            _ => {}
        },
        // The app-level keepalive is tolerated: neither forwarded nor answered.
        _ => {}
    }
}
