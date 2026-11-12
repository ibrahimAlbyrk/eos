//! The phone gateway while armed (`manager/remote/gateway.ts`, `WsBridge.ts`,
//! `wire.ts`): this computer's room on the relay, a session per phone that
//! joined it, and the fan-out of the app's events to those phones.
//!
//! ## Order
//!
//! Today's gateway got its ordering from Node's single thread. Here every
//! change to the sessions and every seq-stamped frame (`event`, `patch`,
//! `snapshot`, `rows`) happens on the runtime's ordered lane, where the bus
//! delivers: a frame's seq, the live text it carries and its place in the
//! phone's stream describe one instant. Reads of routes run as tasks and come
//! back to the lane to send.
//!
//! ## A link that falls behind
//!
//! Frames stamped on the lane cannot wait. When the queue towards the relay
//! is full the frame is dropped and the phone is marked behind: it gets
//! nothing more until there is room again, then a fresh snapshot (lists,
//! live text, terminals) and the transcript rows it missed — rows only count
//! as sent once they were queued. Answers to controls are never dropped:
//! they wait for room, which slows the phone's requests instead.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use bytes::Bytes;
use eos_contracts::{ClientFrame, ControlFrame, FocusFrame, HelloFrame};
use eos_core::net::relay::{RelayClientId, RelayError, RoomEvent, RoomHosting};
use eos_core::store::RemoteStore;
use eos_core::{Clock, Ids};
use eos_runtime::Kernel;
use eos_runtime::bus::{Event, Filter, Subscription};
use eos_runtime::http::Method;
use eos_runtime::patches::{PatchOptions, PatchSink, RowChange, StatePatcher};
use eos_runtime::router::{BoxFuture, Router};
use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::value::RawValue;
use tokio::runtime::Handle;
use tokio::sync::{Semaphore, mpsc};
use tokio::task::JoinHandle;

use crate::device::{Device, PayloadKeys};
use crate::dispatch::{self, Dispatcher, PHONE};
use crate::frames::{self, BootExtras, Frame};

/// One page of pushed transcript rows: the phone's own page size.
const ROWS_PAGE: usize = 500;
/// A patch that lands while the snapshot's lists are being read carries newer
/// rows than the read may return; the lists are read again, at most this often.
const SNAPSHOT_READ_ATTEMPTS: usize = 3;

#[derive(Debug, Clone, Copy)]
pub struct GatewayOptions {
    /// How long a burst of row changes is collected (today: 150 ms).
    pub patch_debounce: Duration,
    /// A phone silent this long is gone: it sends a keepalive every 20 s, so
    /// 90 s is at least four missed. The backstop for a relay that does not
    /// announce a phone that left.
    pub idle_ttl: Duration,
    pub sweep_interval: Duration,
    /// Controls of one phone that run at once; more wait in the socket.
    pub controls_at_once: usize,
    /// Keystrokes of one phone waiting for the terminal; more wait in the socket.
    pub queued_keystrokes: usize,
}

impl Default for GatewayOptions {
    fn default() -> Self {
        Self {
            patch_debounce: Duration::from_millis(150),
            idle_ttl: Duration::from_secs(90),
            sweep_interval: Duration::from_secs(30),
            controls_at_once: 32,
            queued_keystrokes: 256,
        }
    }
}

struct State {
    /// The content cursor: lets a phone see that it missed frames. Restarts
    /// with every arming; `epoch` tells a phone its old cursor means nothing.
    seq: i64,
    patch_seq: i64,
    epoch: String,
    devices: IndexMap<RelayClientId, Device>,
}

impl State {
    fn device(&mut self, client: RelayClientId, generation: u64) -> Option<&mut Device> {
        self.devices.get_mut(&client).filter(|device| device.generation == generation)
    }
}

struct Inner {
    room: Arc<dyn RoomHosting>,
    router: Arc<Router>,
    kernel: Kernel,
    clock: Arc<dyn Clock>,
    dispatcher: Dispatcher,
    options: GatewayOptions,
    state: Mutex<State>,
    next_generation: AtomicU64,
    tasks: Handle,
}

fn hex(client: RelayClientId) -> String {
    client.iter().map(|b| format!("{b:02x}")).collect()
}

/// What became of a frame stamped on the lane.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Sent {
    Queued,
    /// The link is behind: the phone is seeded anew once there is room.
    Behind,
    /// It can never be delivered (too large, no connection).
    Dropped,
}

/// Rows travel in frames of at most this much row text, so a page of large
/// rows stays under the relay's limit for one message.
const ROWS_FRAME_BYTES: usize = 4 * 1024 * 1024;

/// Splits a page into runs that each fit one frame. A row larger than a
/// frame is a run of its own.
fn row_batches<'a, 'r>(rows: &'a [&'r RawValue]) -> impl Iterator<Item = &'a [&'r RawValue]> {
    let mut rest = rows;
    std::iter::from_fn(move || {
        if rest.is_empty() {
            return None;
        }
        let mut size = 0;
        let mut count = 0;
        while count < rest.len() && (count == 0 || size + rest[count].get().len() <= ROWS_FRAME_BYTES) {
            size += rest[count].get().len();
            count += 1;
        }
        let (batch, tail) = rest.split_at(count);
        rest = tail;
        Some(batch)
    })
}

/// The `id` of a transcript row, when it is a number.
fn row_id(row: &RawValue) -> Option<i64> {
    #[derive(Deserialize)]
    struct Id {
        id: Option<serde_json::Value>,
    }
    serde_json::from_str::<Id>(row.get()).ok()?.id?.as_i64()
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        // Changed on the lane only, one step at a time: valid after a panic.
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Runs `step` on the ordered lane with the sessions in hand. `None` once
    /// the app is shutting down.
    async fn on_lane<R: Send + 'static>(
        self: &Arc<Self>,
        step: impl FnOnce(&Arc<Inner>, &mut State) -> R + Send + 'static,
    ) -> Option<R> {
        let inner = self.clone();
        self.kernel.ordered.run(move || step(&inner, &mut inner.state())).await.ok()
    }

    // ---- sending (lane) -----------------------------------------------------

    /// Queues a seq-stamped frame for one phone. Never waits.
    fn send(self: &Arc<Self>, client: RelayClientId, device: &mut Device, frame: &Frame) -> Sent {
        if device.lagged {
            return Sent::Behind;
        }
        match self.room.try_send(client, frame.payload(device.deflate())) {
            Ok(()) => Sent::Queued,
            Err(RelayError::Behind) => {
                self.fell_behind(client, device);
                Sent::Behind
            }
            Err(RelayError::TooLarge { size, .. }) => {
                tracing::warn!(client = %device.hex, size, "a frame for the phone is larger than the relay carries; dropped");
                Sent::Dropped
            }
            // No connection: the relay drops the phone with it, and it joins again.
            Err(RelayError::Offline | RelayError::Closed) => Sent::Dropped,
        }
    }

    fn fell_behind(self: &Arc<Self>, client: RelayClientId, device: &mut Device) {
        device.lagged = true;
        if !device.recovering {
            device.recovering = true;
            tracing::info!(client = %device.hex, "the relay link is behind; the phone gets a fresh snapshot once there is room");
            self.tasks.spawn(self.clone().recover(client, device.generation));
        }
    }

    /// Waits until the link has room again, then seeds the phone anew.
    async fn recover(self: Arc<Self>, client: RelayClientId, generation: u64) {
        loop {
            // A keepalive the phone drops: queued in order, so it gets room only once the backlog went.
            let probe = frames::ka(self.clock.now_ms()).payload(false);
            if self.room.send(client, probe).await.is_err() {
                self.on_lane(move |_, state| {
                    if let Some(device) = state.device(client, generation) {
                        device.recovering = false;
                    }
                })
                .await;
                return;
            }
            self.clone().send_snapshot(client, generation, true, true).await;
            let caught_up = self
                .on_lane(move |inner, state| match state.device(client, generation) {
                    Some(device) if device.lagged => false,
                    Some(device) => {
                        device.recovering = false;
                        inner.pull_rows(client, device);
                        true
                    }
                    None => true,
                })
                .await;
            if caught_up != Some(false) {
                return;
            }
        }
    }

    // ---- the room (lane) ----------------------------------------------------

    fn join(self: &Arc<Self>, state: &mut State, client: RelayClientId) {
        let generation = self.next_generation.fetch_add(1, Ordering::SeqCst);
        let (input, keystrokes) = mpsc::channel(self.options.queued_keystrokes.max(1));
        let device = Device {
            generation,
            hex: hex(client),
            caps: HashSet::new(),
            focus: None,
            pty_subs: HashSet::new(),
            // Seeded at once instead of waiting a round trip for its hello.
            boot_snapshot: true,
            hello_seen: false,
            rows_worker: None,
            rows_cursor: None,
            pulling: false,
            pull_again: false,
            last_activity: self.clock.now_ms(),
            lagged: false,
            recovering: false,
            controls: Arc::new(Semaphore::new(self.options.controls_at_once.max(1))),
            input,
        };
        tracing::info!(client = %device.hex, "remote device live");
        state.devices.insert(client, device);
        self.tasks.spawn(self.clone().type_keystrokes(client, generation, keystrokes));
        self.tasks.spawn(self.clone().send_snapshot(client, generation, true, false));
    }

    fn on_hello(self: &Arc<Self>, client: RelayClientId, device: &mut Device, hello: HelloFrame) {
        device.caps = hello.caps.unwrap_or_default().into_iter().collect();
        // The first hello asks for what the snapshot sent on join already holds.
        let answered = device.boot_snapshot && !device.hello_seen;
        device.hello_seen = true;
        if !answered {
            self.tasks.spawn(self.clone().send_snapshot(client, device.generation, false, false));
        }
    }

    /// A new focus. With cap `rows`, follow the open worker's transcript: a
    /// worker newly on screen first gets the text already streamed for its
    /// live blocks, sent at once — every later delta goes out after it, so the
    /// phone replaces what its buffers hold and appends from there.
    fn on_focus(self: &Arc<Self>, seq: i64, client: RelayClientId, device: &mut Device, focus: FocusFrame) {
        let was_active = device.focus.as_ref().is_some_and(|f| f.active);
        let (active, after_id) = (focus.active, focus.after_id.flatten());
        let worker = if active { focus.worker.clone().flatten() } else { None };
        device.focus = Some(focus);
        if !device.has("rows") {
            return;
        }
        if worker != device.rows_worker || (active && !was_active) {
            device.rows_worker.clone_from(&worker);
            device.rows_cursor = None;
            if let Some(worker) = &worker {
                let live = self.kernel.live_text.blocks_for(worker);
                if !live.is_empty() {
                    let _ = self.send(client, device, &frames::rows(seq, worker, &[], Some(&live)));
                }
            }
        }
        if worker.is_some() && after_id.is_some() {
            device.rows_cursor = after_id;
        }
        self.pull_rows(client, device);
    }

    /// Single flight: changes that land during a read fold into one more read.
    fn pull_rows(self: &Arc<Self>, client: RelayClientId, device: &mut Device) {
        if device.pulling {
            device.pull_again = true;
            return;
        }
        device.pulling = true;
        self.tasks.spawn(self.clone().push_rows(client, device.generation));
    }

    async fn push_rows(self: Arc<Self>, client: RelayClientId, generation: u64) {
        loop {
            let target = self
                .on_lane(move |_, state| {
                    let device = state.device(client, generation)?;
                    device.pull_again = false;
                    match (&device.rows_worker, device.rows_cursor) {
                        (Some(worker), Some(cursor)) => Some((worker.clone(), cursor)),
                        // No worker open, or the phone has not named its newest row yet: nothing to push.
                        _ => {
                            device.pulling = false;
                            None
                        }
                    }
                })
                .await
                .flatten();
            let Some((worker, cursor)) = target else { return };
            let path = format!(
                "/workers/{}/events?afterId={cursor}&limit={ROWS_PAGE}",
                dispatch::encode_uri_component(&worker)
            );
            let page = dispatch::list(&self.router, &path).await;
            let more = self
                .on_lane(move |inner, state| {
                    let seq = state.seq;
                    let Some(device) = state.device(client, generation) else { return false };
                    // The focus moved on while this read ran: its rows belong to nobody now.
                    if device.rows_worker.as_deref() != Some(worker.as_str()) || device.rows_cursor != Some(cursor) {
                        return true;
                    }
                    let rows: Vec<&RawValue> = serde_json::from_str(page.get()).unwrap_or_default();
                    let mut newest = cursor;
                    let mut behind = false;
                    for batch in row_batches(&rows) {
                        // Rows count as sent only once queued: a phone behind gets them after its snapshot.
                        if inner.send(client, device, &frames::rows(seq, &worker, batch, None)) == Sent::Behind {
                            behind = true;
                            break;
                        }
                        newest = batch.iter().filter_map(|row| row_id(row)).fold(newest, i64::max);
                    }
                    device.rows_cursor = Some(newest);
                    if behind {
                        device.pull_again = false;
                    } else if rows.len() >= ROWS_PAGE {
                        device.pull_again = true;
                    }
                    if device.pull_again {
                        return true;
                    }
                    device.pulling = false;
                    false
                })
                .await;
            if more != Some(true) {
                return;
            }
        }
    }

    // ---- snapshots ------------------------------------------------------------

    /// The terminal list and the ui configuration, for the snapshot sent on join.
    async fn boot_extras(&self) -> BootExtras {
        #[derive(Deserialize)]
        struct Sessions<'a> {
            #[serde(borrow, default)]
            sessions: Option<&'a RawValue>,
        }
        let (ptys, ui_config) = tokio::join!(
            dispatch::call(&self.router, Method::Get, "/pty", Bytes::new()),
            dispatch::call(&self.router, Method::Get, "/api/ui-config", Bytes::new()),
        );
        let ptys = ptys.ok().filter(|answer| answer.status == 200).and_then(|answer| {
            let sessions = serde_json::from_slice::<Sessions<'_>>(&answer.body).ok()?.sessions?;
            sessions.get().starts_with('[').then(|| sessions.to_owned())
        });
        let ui_config = ui_config
            .ok()
            .filter(|answer| answer.status == 200)
            .and_then(|answer| frames::raw(&answer.body).map(RawValue::to_owned));
        BootExtras { ptys, ui_config }
    }

    /// The full state, read from the list routes. `boot`: with the terminals
    /// and the ui configuration. `recovery`: for a phone marked behind, which
    /// this snapshot brings back.
    async fn send_snapshot(self: Arc<Self>, client: RelayClientId, generation: u64, boot: bool, recovery: bool) {
        let extras = if boot { self.boot_extras().await } else { BootExtras::default() };
        let extras = Arc::new(extras);
        for attempt in 1..=SNAPSHOT_READ_ATTEMPTS {
            let Some(patch_seq) = self.on_lane(|_, state| state.patch_seq).await else { return };
            let (workers, pending) =
                tokio::join!(dispatch::list(&self.router, "/workers"), dispatch::list(&self.router, "/pending"));
            let extras = extras.clone();
            let sent = self
                .on_lane(move |inner, state| {
                    if state.patch_seq != patch_seq && attempt < SNAPSHOT_READ_ATTEMPTS {
                        return false;
                    }
                    // From here on one instant: seq, epoch and live text belong together.
                    let live = inner.kernel.live_text.snapshot();
                    let frame = frames::snapshot(state.seq, &state.epoch, &workers, &pending, &live, &extras);
                    if let Some(device) = state.device(client, generation) {
                        if recovery {
                            match inner.room.try_send(client, frame.payload(device.deflate())) {
                                Ok(()) => device.lagged = false,
                                Err(error) => tracing::debug!(%error, "the recovery snapshot did not fit yet"),
                            }
                        } else {
                            let _ = inner.send(client, device, &frame);
                        }
                        tracing::debug!(client = %device.hex, boot, "remote snapshot sent");
                    }
                    true
                })
                .await;
            if sent != Some(false) {
                return;
            }
        }
    }

    // ---- controls -------------------------------------------------------------

    async fn answer(self: &Arc<Self>, client: RelayClientId, generation: u64, frame: ControlFrame) {
        let device = hex(client);
        let reply = self.dispatcher.handle(&device, &frame).await;
        tracing::debug!(method = ?frame.method, path = %frame.path, "remote control");
        // The session may be gone by now; its answer goes nowhere.
        let Some(deflate) = self.state().device(client, generation).map(|d| d.deflate()) else { return };
        // An answer waits for room: the phone's requests slow down, nothing is dropped.
        if let Err(RelayError::TooLarge { .. }) = self.room.send(client, reply.payload(deflate)).await {
            let refusal = frames::error("FRAME_TOO_LARGE", "reply exceeds relay envelope limit", &frame.correlation_id);
            let _ = self.room.send(client, refusal.payload(false)).await;
        }
    }

    /// One phone's keystrokes, written one after the other.
    async fn type_keystrokes(
        self: Arc<Self>,
        client: RelayClientId,
        generation: u64,
        mut keystrokes: mpsc::Receiver<ControlFrame>,
    ) {
        while let Some(frame) = keystrokes.recv().await {
            self.answer(client, generation, frame).await;
        }
    }

    // ---- the bus (lane) -------------------------------------------------------

    /// Fans one bus event out to the phones that want it.
    fn on_event(self: &Arc<Self>, event: &Event) {
        let mut state = self.state();
        if state.devices.is_empty() {
            return;
        }
        let topic = event.topic.as_str();
        // The dashboard's own row patches: a phone gets its rows as `patch` frames.
        if topic == "state:patch" {
            return;
        }
        let keys = PayloadKeys::of(&event.payload);
        if topic == "worker:change"
            && let Some(changed) = keys.worker()
        {
            let following: Vec<RelayClientId> = state
                .devices
                .iter()
                .filter(|(_, device)| device.rows_worker.as_deref() == Some(changed))
                .map(|(client, _)| *client)
                .collect();
            for client in following {
                if let Some(device) = state.devices.get_mut(&client) {
                    self.pull_rows(client, device);
                }
            }
        }
        // Raw terminal output goes only to the phones showing that terminal.
        let pty = topic == "pty:data";
        let targets: Vec<RelayClientId> = state
            .devices
            .iter()
            .filter(|(_, device)| if pty { device.shows_pty(&keys) } else { device.wants(topic, &keys) })
            .map(|(client, _)| *client)
            .collect();
        if targets.is_empty() {
            return;
        }
        // A frame some phones do not get carries the current seq without
        // taking a new one, so those phones do not read a gap.
        let scoped = pty || targets.len() < state.devices.len();
        if !scoped {
            state.seq += 1;
        }
        let frame = frames::event(state.seq, topic, self.clock.now_ms(), frames::raw(&event.payload));
        for client in targets {
            if let Some(device) = state.devices.get_mut(&client) {
                let _ = self.send(client, device, &frame);
            }
        }
    }

    /// One `patch` frame per changed row, to every phone.
    fn push_patches(self: &Arc<Self>, state: &mut State, changes: &[RowChange]) {
        if state.devices.is_empty() {
            return;
        }
        for change in changes {
            let Some(data) = frames::raw(&change.data) else { continue };
            state.seq += 1;
            state.patch_seq = state.seq;
            let frame = frames::patch(state.seq, change.resource.as_str(), change.op.as_str(), data);
            for (client, device) in &mut state.devices {
                let _ = self.send(*client, device, &frame);
            }
        }
    }

    // ---- the reader -----------------------------------------------------------

    /// One inbound frame of a phone. Decoding and waiting happen here, off the lane.
    async fn on_data(self: &Arc<Self>, client: RelayClientId, payload: &Bytes) {
        let known = {
            let mut state = self.state();
            let now = self.clock.now_ms();
            state.devices.get_mut(&client).map(|device| {
                device.last_activity = now;
                (device.generation, device.controls.clone(), device.input.clone())
            })
        };
        let Some((generation, controls, input)) = known else { return };
        let Some(frame) = decode_client_frame(payload) else {
            tracing::debug!("remote frame rejected (bad shape)");
            return;
        };
        match frame {
            ClientFrame::Ka(_) => {}
            ClientFrame::Hello(hello) => {
                self.on_lane(move |inner, state| {
                    if let Some(device) = state.device(client, generation) {
                        inner.on_hello(client, device, hello);
                    }
                })
                .await;
            }
            ClientFrame::Sub(sub) => {
                self.on_lane(move |_, state| {
                    if let Some(device) = state.device(client, generation) {
                        device.pty_subs = sub.pty.into_iter().collect();
                    }
                })
                .await;
            }
            ClientFrame::Focus(focus) => {
                self.on_lane(move |inner, state| {
                    let seq = state.seq;
                    if let Some(device) = state.device(client, generation) {
                        inner.on_focus(seq, client, device, focus);
                    }
                })
                .await;
            }
            ClientFrame::Control(control) if dispatch::is_pty_input(&control) => {
                // A full queue stops the room being read: the phone's typing waits, in order.
                let _ = input.send(control).await;
            }
            ClientFrame::Control(control) => {
                let Ok(permit) = controls.acquire_owned().await else { return };
                let inner = self.clone();
                self.tasks.spawn(async move {
                    inner.answer(client, generation, control).await;
                    drop(permit);
                });
            }
        }
    }

    async fn read_room(self: Arc<Self>) {
        while let Some(event) = self.room.next().await {
            match event {
                RoomEvent::Joined(client) => {
                    self.on_lane(move |inner, state| inner.join(state, client)).await;
                }
                RoomEvent::Left(client) => {
                    self.on_lane(move |_, state| state.devices.shift_remove(&client)).await;
                }
                // A fresh relay connection: the relay closed every phone that
                // joined through the previous one. They join again and resync.
                RoomEvent::Registered => {
                    self.on_lane(|_, state| state.devices.clear()).await;
                }
                RoomEvent::Offline => {}
                RoomEvent::Data { client, payload } => self.on_data(client, &payload).await,
                RoomEvent::Refused { code, message } => tracing::warn!(%code, %message, "relay error"),
            }
        }
    }

    /// Forgets phones that went silent without the relay saying so.
    async fn sweep(self: Arc<Self>) {
        let ttl = i64::try_from(self.options.idle_ttl.as_millis()).unwrap_or(i64::MAX);
        let mut tick = tokio::time::interval(self.options.sweep_interval);
        tick.tick().await;
        loop {
            tick.tick().await;
            let now = self.clock.now_ms();
            let swept = self
                .on_lane(move |_, state| {
                    state.devices.retain(|_, device| {
                        let keep = now - device.last_activity <= ttl;
                        if !keep {
                            tracing::info!(client = %device.hex, "stale device session pruned (idle)");
                        }
                        keep
                    });
                })
                .await;
            if swept.is_none() {
                return;
            }
        }
    }
}

/// A `data` payload as the frame the phone meant, or `None` when it is not
/// one: not JSON, an unknown kind, a field of the wrong shape.
pub(crate) fn decode_client_frame(payload: &[u8]) -> Option<ClientFrame> {
    let value: serde_json::Value = serde_json::from_slice(payload).ok()?;
    eos_contracts::parse(&value).ok()
}

struct Patches(Arc<Inner>);

impl PatchSink for Patches {
    fn active(&self) -> bool {
        !self.0.state().devices.is_empty()
    }

    fn push(&self, changes: Vec<RowChange>) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            self.0.on_lane(move |inner, state| inner.push_patches(state, &changes)).await;
        })
    }
}

/// What the gateway is built from.
pub(crate) struct GatewayParts {
    pub(crate) room: Arc<dyn RoomHosting>,
    pub(crate) router: Arc<Router>,
    pub(crate) kernel: Kernel,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) ids: Arc<dyn Ids>,
    pub(crate) store: Arc<dyn RemoteStore>,
    pub(crate) options: GatewayOptions,
}

/// The armed gateway. Dropping it gives the room up and ends every session.
pub(crate) struct Gateway {
    inner: Arc<Inner>,
    tasks: Vec<JoinHandle<()>>,
    _events: Subscription,
    _patcher: StatePatcher,
}

impl Gateway {
    /// Starts serving the room. Call inside the async runtime.
    pub(crate) fn start(parts: GatewayParts) -> Self {
        let GatewayParts { room, router, kernel, clock, ids, store, options } = parts;
        let state =
            State { seq: 0, patch_seq: 0, epoch: ids.token(eos_core::Alphabet::Hex, 16), devices: IndexMap::new() };
        let inner = Arc::new(Inner {
            room,
            router: router.clone(),
            kernel: kernel.clone(),
            clock: clock.clone(),
            dispatcher: Dispatcher { router: router.clone(), store, clock },
            options,
            state: Mutex::new(state),
            next_generation: AtomicU64::new(1),
            tasks: Handle::current(),
        });
        let fan_out = inner.clone();
        let events = kernel.bus.on(Filter::All, move |event| fan_out.on_event(event));
        let patch_options = PatchOptions { debounce: options.patch_debounce, ..PatchOptions::full_rows(PHONE) };
        let patcher = StatePatcher::start(&kernel.bus, router, patch_options, Arc::new(Patches(inner.clone())));
        let tasks = vec![tokio::spawn(inner.clone().read_room()), tokio::spawn(inner.clone().sweep())];
        Self { inner, tasks, _events: events, _patcher: patcher }
    }

    /// Phones with a session right now.
    pub(crate) fn devices(&self) -> usize {
        self.inner.state().devices.len()
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
        self.inner.room.close();
        self.inner.state().devices.clear();
    }
}
