//! Owning a room: dial out, register, and from then on the relay forwards
//! between this computer and each device in the room. The connection is kept: a
//! dead one is redialled with a doubling pause, and at once after the computer
//! wakes.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use bytes::Bytes;
use eos_core::net::relay::{RelayClientId, RelayError, RoomClaim, RoomEvent, RoomHosting};
use eos_core::{BoxFuture, Clock};
use futures_util::StreamExt;
use tokio::sync::{Notify, mpsc, watch};
use tokio::task::JoinHandle;
use tokio::time::{Instant, MissedTickBehavior, interval_at};
use tokio_tungstenite::tungstenite::Message;

use crate::RelayOptions;
use crate::control::{self, Control};
use crate::envelope::{Dir, FrameType, Header, encode_envelope, parse_envelope};
use crate::socket::{self, Outbound, Stream, write_loop};

struct Shared {
    claim: RoomClaim,
    options: RelayOptions,
    clock: Arc<dyn Clock>,
    online: AtomicBool,
    /// The live connection's queue; `None` while there is none.
    out: Mutex<Option<Outbound>>,
    stop: watch::Sender<bool>,
    refresh: Notify,
}

impl Shared {
    fn out(&self) -> MutexGuard<'_, Option<Outbound>> {
        // Holds one `Option` swap at a time: a poisoned lock is still valid.
        self.out.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn register(&self) -> Option<Bytes> {
        control::register(&self.claim.room, &self.claim.owner, &(self.claim.allow)()).ok()
    }

    fn frame(&self, client: RelayClientId, payload: &[u8]) -> Result<(Outbound, Bytes), RelayError> {
        let out = self.out().clone().ok_or(RelayError::Offline)?;
        let header = Header::new(FrameType::Data, Dir::S2c, &self.claim.room, client);
        // The room was checked when the hosting was made.
        let frame = encode_envelope(header, payload).map_err(|_| RelayError::Closed)?;
        Ok((out, frame))
    }
}

/// A room this computer owns. Dropping it gives the room up.
pub(crate) struct Hosting {
    shared: Arc<Shared>,
    events: tokio::sync::Mutex<mpsc::Receiver<RoomEvent>>,
}

impl std::fmt::Debug for Hosting {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Hosting").field("online", &self.online()).finish_non_exhaustive()
    }
}

impl Hosting {
    /// Starts dialling. Must be called inside the async runtime.
    pub(crate) fn start(claim: RoomClaim, options: RelayOptions, clock: Arc<dyn Clock>) -> Self {
        let (events_tx, events_rx) = mpsc::channel(options.inbound_events.max(1));
        let (stop, _) = watch::channel(false);
        let shared = Arc::new(Shared {
            claim,
            options,
            clock,
            online: AtomicBool::new(false),
            out: Mutex::new(None),
            stop,
            refresh: Notify::new(),
        });
        if shared.register().is_some() {
            tokio::spawn(run(shared.clone(), events_tx));
        } else {
            // Dropping the sender ends `next` at once: there is nothing to dial with.
            tracing::error!("the relay room id cannot travel in an envelope; not connecting");
        }
        Self { shared, events: tokio::sync::Mutex::new(events_rx) }
    }
}

impl Drop for Hosting {
    fn drop(&mut self) {
        self.shared.stop.send_replace(true);
    }
}

impl RoomHosting for Hosting {
    fn next(&self) -> BoxFuture<'_, Option<RoomEvent>> {
        Box::pin(async move { self.events.lock().await.recv().await })
    }

    fn send(&self, client: RelayClientId, payload: Bytes) -> BoxFuture<'_, Result<(), RelayError>> {
        Box::pin(async move {
            let (out, frame) = self.shared.frame(client, &payload)?;
            out.send(frame).await
        })
    }

    fn try_send(&self, client: RelayClientId, payload: Bytes) -> Result<(), RelayError> {
        let (out, frame) = self.shared.frame(client, &payload)?;
        out.try_send(frame)
    }

    fn online(&self) -> bool {
        self.shared.online.load(Ordering::SeqCst)
    }

    fn refresh_allow(&self) {
        self.shared.refresh.notify_one();
    }

    fn close(&self) {
        self.shared.stop.send_replace(true);
    }
}

/// Resolves once the hosting was closed.
async fn stopped(stop: &mut watch::Receiver<bool>) {
    while !*stop.borrow_and_update() {
        if stop.changed().await.is_err() {
            return;
        }
    }
}

/// Sleep freezes the process, and on wake the socket is almost certainly
/// dead — yet the ping needs up to two intervals to notice. The wall clock
/// jumping between two cheap ticks is the wake signal.
pub(crate) struct WakeWatch {
    clock: Arc<dyn Clock>,
    tick: tokio::time::Interval,
    /// A gap between two ticks longer than this means the computer slept.
    limit_ms: i64,
    last: i64,
}

impl WakeWatch {
    pub(crate) fn new(clock: Arc<dyn Clock>, check: Duration, gap: Duration) -> Self {
        let mut tick = interval_at(Instant::now() + check, check);
        tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let limit_ms = i64::try_from((check + gap).as_millis()).unwrap_or(i64::MAX);
        let last = clock.now_ms();
        Self { clock, tick, limit_ms, last }
    }

    /// Resolves when the wall clock jumped between two ticks. Safe to drop
    /// and call again.
    pub(crate) async fn slept(&mut self) {
        loop {
            self.tick.tick().await;
            let now = self.clock.now_ms();
            let jumped = now - self.last > self.limit_ms;
            self.last = now;
            if jumped {
                return;
            }
        }
    }

    /// Starts counting from now: time spent away from [`slept`](Self::slept) is not a jump.
    fn reset(&mut self) {
        self.last = self.clock.now_ms();
        self.tick.reset();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum End {
    /// The hosting was closed.
    Stop,
    /// The computer woke: the socket is taken for dead.
    Wake,
    /// The socket closed, failed or stopped answering.
    Closed,
}

async fn run(shared: Arc<Shared>, events: mpsc::Sender<RoomEvent>) {
    let options = shared.options;
    let mut stop = shared.stop.subscribe();
    let mut wake = WakeWatch::new(shared.clock.clone(), options.wake_check, options.wake_gap);
    let mut backoff = options.backoff_min;
    loop {
        let dialled = tokio::select! {
            dialled = socket::connect(&shared.claim.url, options.connect_timeout) => dialled,
            () = stopped(&mut stop) => break,
        };
        wake.reset();
        let end = match dialled {
            Ok((sink, stream)) => {
                let mut session = Session { shared: &shared, events: &events, stop: &mut stop, wake: &mut wake };
                session.run(sink, stream, &mut backoff).await
            }
            Err(error) => {
                tracing::info!(url = %shared.claim.url, %error, "relay not reached");
                End::Closed
            }
        };
        match end {
            End::Stop => break,
            // As after any wake: start the pauses over.
            End::Wake => backoff = options.backoff_min,
            End::Closed => {}
        }
        let delay = backoff;
        backoff = (backoff * 2).min(options.backoff_max);
        tracing::info!(delay_ms = delay.as_millis() as u64, "relay reconnect scheduled");
        tokio::select! {
            () = tokio::time::sleep(delay) => {}
            () = wake.slept() => {
                tracing::info!("system wake detected — redialing relay");
                backoff = options.backoff_min;
            }
            () = stopped(&mut stop) => break,
        }
    }
}

struct Session<'a> {
    shared: &'a Arc<Shared>,
    events: &'a mpsc::Sender<RoomEvent>,
    stop: &'a mut watch::Receiver<bool>,
    wake: &'a mut WakeWatch,
}

impl Session<'_> {
    /// Hands an event to the reader. Waits while its queue is full, which
    /// stops this socket being read: the back-pressure towards the relay.
    /// False once the hosting was closed.
    async fn emit(&mut self, event: RoomEvent) -> bool {
        tokio::select! {
            sent = self.events.send(event) => sent.is_ok(),
            () = stopped(self.stop) => false,
        }
    }

    async fn run(&mut self, mut sink: socket::Sink, stream: Stream, backoff: &mut Duration) -> End {
        use futures_util::SinkExt;
        let options = self.shared.options;
        let Some(register) = self.shared.register() else { return End::Stop };
        if sink.send(Message::Binary(register)).await.is_err() {
            return End::Closed;
        }
        // The relay acks a registration by silence (an older one) or a notice
        // (a current one): a sent registration counts as registered.
        tracing::info!(url = %self.shared.claim.url, "relay connected");
        *backoff = options.backoff_min;
        let (out, queue) = Outbound::new(options.outbound_bytes);
        let (urgent, urgent_rx) = mpsc::channel(4);
        *self.shared.out() = Some(out.clone());
        self.shared.online.store(true, Ordering::SeqCst);
        let mut writer = tokio::spawn(write_loop(sink, queue, urgent_rx));

        let end = if self.emit(RoomEvent::Registered).await {
            self.live(stream, &urgent, &mut writer).await
        } else {
            End::Stop
        };

        self.shared.online.store(false, Ordering::SeqCst);
        *self.shared.out() = None;
        out.close();
        writer.abort();
        if end != End::Stop {
            self.emit(RoomEvent::Offline).await;
        }
        end
    }

    async fn live(&mut self, mut stream: Stream, urgent: &mpsc::Sender<Message>, writer: &mut JoinHandle<()>) -> End {
        let period = self.shared.options.ping_interval;
        let mut ping = interval_at(Instant::now() + period, period);
        ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
        // An idle socket can die without a close (sleep, a network change, an
        // expired NAT mapping). Anything the relay sent since the last ping
        // proves it alive; silence across a whole interval ends it.
        let mut alive = true;
        loop {
            tokio::select! {
                () = stopped(self.stop) => return End::Stop,
                () = self.wake.slept() => {
                    tracing::info!("system wake detected — redialing relay");
                    return End::Wake;
                }
                _ = ping.tick() => {
                    if !alive {
                        tracing::info!("relay ping unanswered — reconnecting");
                        return End::Closed;
                    }
                    alive = false;
                    // A full urgent queue means the writer is stuck: the next tick ends the socket.
                    let _ = urgent.try_send(Message::Ping(Bytes::new()));
                }
                () = self.shared.refresh.notified() => {
                    if let Some(register) = self.shared.register() {
                        let _ = urgent.try_send(Message::Binary(register));
                    }
                }
                _ = &mut *writer => return End::Closed,
                message = stream.next() => match message {
                    Some(Ok(Message::Binary(buf))) => {
                        alive = true;
                        if !self.on_message(&buf).await {
                            return End::Stop;
                        }
                    }
                    Some(Ok(Message::Close(_)) | Err(_)) | None => return End::Closed,
                    Some(Ok(_)) => alive = true,
                },
            }
        }
    }

    /// False once the hosting was closed.
    async fn on_message(&mut self, buf: &Bytes) -> bool {
        let Ok(envelope) = parse_envelope(buf) else { return true };
        let event = match envelope.frame_type() {
            Some(FrameType::Data) => RoomEvent::Data { client: envelope.client_id, payload: envelope.payload },
            Some(FrameType::RelayCtl) => {
                let notice = Control::parse(&envelope.payload);
                match (notice.kind(), notice.client_id()) {
                    (Some("joined"), Some(client)) => RoomEvent::Joined(client),
                    (Some("left"), Some(client)) => RoomEvent::Left(client),
                    _ => return true,
                }
            }
            Some(FrameType::Error) => {
                let (code, message) = Control::parse(&envelope.payload).error();
                RoomEvent::Refused { code, message }
            }
            _ => return true,
        };
        self.emit(event).await
    }
}
