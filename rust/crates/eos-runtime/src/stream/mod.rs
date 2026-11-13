//! The resumable event stream over the bus.
//!
//! Every event gets `id: <epoch>-<seq>` and the recent ones stay in a bounded
//! ring. A client that reconnects with its last id gets exactly what it
//! missed, then live events; when the ring no longer covers the gap — or the
//! app restarted (new epoch) — it gets one `resync` and refetches its state.
//! This is what lets a controlling computer ride out a dropped link without
//! losing a terminal byte.
//!
//! Frames are today's, byte for byte: `retry: 2000`, `:connected`, then
//! `hello` (or the replay, or `resync`), `change` events, `:ka` keepalives.

mod client;
mod filter;
pub mod routes;

use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use bytes::Bytes;

use crate::bus::{Bus, Event, Filter, Scope, Subscription};
use crate::http::{Body, BodyStream};
use client::{Client, ClientStream};
use eos_core::Ids;
pub use filter::StreamFocus;
use filter::{Focus, Wants};

/// Rewrites a payload for display before it is framed (today: strips the
/// sender-tag wrappers, so no stream shows one). `None` leaves it as it is.
/// The rule itself is `eos-domain`'s; the app plugs it in here.
pub trait DisplayFilter: Send + Sync + 'static {
    fn filter(&self, topic: &str, payload: &Bytes) -> Option<Bytes>;
}

#[derive(Clone)]
pub struct StreamOptions {
    /// How often an idle stream gets a `:ka` comment (today: 25 s).
    pub keepalive: Duration,
    /// What the stream offers beyond plain change events, told in
    /// `hello` / `resync` (`state:patch`).
    pub caps: Vec<String>,
    pub ring_max_events: usize,
    pub ring_max_bytes: usize,
    /// How far behind a client may fall before it is ended to reconnect and
    /// replay: this many frames, or this many bytes, waiting to be read.
    pub client_max_frames: usize,
    pub client_max_bytes: usize,
    /// How many streams may be open at once; one more is refused (a page
    /// stuck in a reconnect loop must not grow the hub without bound).
    pub max_clients: usize,
    pub display_filter: Option<Arc<dyn DisplayFilter>>,
}

impl Default for StreamOptions {
    fn default() -> Self {
        Self {
            keepalive: Duration::from_secs(25),
            caps: Vec::new(),
            ring_max_events: 5000,
            ring_max_bytes: 8 * 1024 * 1024,
            client_max_frames: 1024,
            client_max_bytes: 1024 * 1024,
            max_clients: 512,
            display_filter: None,
        }
    }
}

impl std::fmt::Debug for StreamOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StreamOptions")
            .field("keepalive", &self.keepalive)
            .field("caps", &self.caps)
            .field("ring_max_events", &self.ring_max_events)
            .field("ring_max_bytes", &self.ring_max_bytes)
            .finish_non_exhaustive()
    }
}

/// The hub already holds as many streams as it allows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("too many open streams (limit {0})")]
pub struct TooManyStreams(pub usize);

/// How one stream attaches.
#[derive(Debug, Clone, Default)]
pub struct AttachOptions {
    /// The last event id the client received (`<epoch>-<seq>`).
    pub since: Option<String>,
    /// Only these topics (`worker:change`) or families (`worker:*`). Absent or empty: all.
    pub topics: Option<Vec<String>>,
    /// The dashboard tab the stream belongs to.
    pub client_id: Option<String>,
    /// What that tab has on screen. Absent: every scoped event too.
    pub focus: Option<StreamFocus>,
}

/// Focus of tabs whose stream is gone — a reconnect re-sends it; this only
/// bounds what a late focus update can leave behind.
const MAX_FOCUSED_TABS: usize = 256;

struct RingEntry {
    seq: u64,
    topic: crate::bus::TopicName,
    scope: Option<Scope>,
    frame: Bytes,
}

#[derive(Default)]
struct State {
    seq: u64,
    ring: VecDeque<RingEntry>,
    ring_bytes: usize,
    clients: Vec<Arc<Client>>,
    next_client: u64,
    focus: HashMap<Arc<str>, Focus>,
    focus_stamp: u64,
    closed: bool,
}

type GoneHook = Arc<dyn Fn(&str) + Send + Sync>;

struct Hub {
    epoch: Box<str>,
    /// `"caps":[…]` is the same in every hello and resync.
    caps_json: Box<str>,
    options: StreamOptions,
    state: Mutex<State>,
    gone_hooks: Mutex<Vec<GoneHook>>,
}

/// The stream. Cheap to clone.
#[derive(Clone)]
pub struct StreamHub {
    hub: Arc<Hub>,
    _subscription: Arc<Subscription>,
}

impl std::fmt::Debug for StreamHub {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StreamHub")
            .field("epoch", &self.hub.epoch)
            .field("clients", &self.size())
            .finish_non_exhaustive()
    }
}

impl StreamHub {
    /// Starts relaying every bus event. The epoch names this run of the app.
    pub fn new(bus: &Bus, ids: &dyn Ids, options: StreamOptions) -> Self {
        let hub = Arc::new(Hub {
            epoch: ids.stream_epoch().into(),
            caps_json: serde_json::to_string(&options.caps).unwrap_or_else(|_| "[]".into()).into(),
            options,
            state: Mutex::default(),
            gone_hooks: Mutex::default(),
        });
        let relay = hub.clone();
        let subscription = bus.on(Filter::All, move |ev| relay.broadcast(ev));
        Self { hub, _subscription: Arc::new(subscription) }
    }

    /// The id of the newest event (`<epoch>-<seq>`).
    pub fn current_id(&self) -> String {
        format!("{}-{}", self.hub.epoch, self.hub.state().seq)
    }

    /// The data of the `hello` a stream opened now would get: the newest
    /// event's position and the stream's capabilities. State read after this
    /// misses nothing that a stream opened with `since=<epoch>-<seq>` replays.
    pub fn hello(&self) -> String {
        self.hub.greeting_data(self.hub.state().seq)
    }

    /// Connected streams.
    pub fn size(&self) -> usize {
        self.hub.state().clients.len()
    }

    /// Opens one stream. The body yields the preamble, then the replay (or
    /// `hello`, or `resync`), then live events; it must be created inside the
    /// async runtime (it owns the keepalive timer). Replay and registration
    /// happen under one lock, so no event falls between them.
    pub fn attach(&self, options: AttachOptions) -> Result<Body, TooManyStreams> {
        let hub = &self.hub;
        let tab: Option<Arc<str>> = options.client_id.as_deref().filter(|id| !id.is_empty()).map(Arc::from);
        let wants = Wants::new(options.topics.as_deref());
        let mut state = hub.state();
        if state.clients.len() >= hub.options.max_clients {
            return Err(TooManyStreams(hub.options.max_clients));
        }
        if let (Some(tab), Some(focus)) = (&tab, &options.focus) {
            state.set_focus(tab.clone(), focus);
        }
        let mut owed = vec![Bytes::from_static(b"retry: 2000\n\n"), Bytes::from_static(b":connected\n\n")];
        match options.since.as_deref().filter(|s| !s.is_empty()) {
            Some(since) => hub.catch_up(&state, since, &wants, tab.as_deref(), &mut owed),
            None => owed.push(hub.greeting("hello", state.seq)),
        }
        state.next_client += 1;
        let client = Arc::new(Client::new(state.next_client, wants, tab, owed));
        if state.closed {
            client.end();
        } else {
            state.clients.push(client.clone());
        }
        drop(state);
        Ok(Body::Stream(BodyStream::new(ClientStream::new(hub, client, hub.options.keepalive))))
    }

    /// A tab's new on-screen set; applies to its streams from the next event on.
    pub fn set_focus(&self, client_id: &str, focus: &StreamFocus) {
        self.hub.state().set_focus(client_id.into(), focus);
    }

    /// Calls `hook` with the tab id each time one of a tab's streams goes away
    /// (tab closed, reloaded, crashed): the place to release what the tab was
    /// watching, even if it never said goodbye.
    pub fn on_client_gone(&self, hook: impl Fn(&str) + Send + Sync + 'static) {
        self.hub.gone_hooks.lock().unwrap_or_else(|p| p.into_inner()).push(Arc::new(hook));
    }

    /// Ends every stream (after what each has queued) and refuses new events.
    pub fn close(&self) {
        let mut state = self.hub.state();
        state.closed = true;
        for client in state.clients.drain(..) {
            client.end();
        }
    }

    #[cfg(test)]
    fn focused_tabs(&self) -> usize {
        self.hub.state().focus.len()
    }

    #[cfg(test)]
    fn ring_len(&self) -> (usize, usize) {
        let state = self.hub.state();
        (state.ring.len(), state.ring_bytes)
    }
}

impl State {
    fn set_focus(&mut self, tab: Arc<str>, focus: &StreamFocus) {
        self.focus_stamp += 1;
        self.focus.insert(tab, Focus::new(focus, self.focus_stamp));
        while self.focus.len() > MAX_FOCUSED_TABS {
            let Some(oldest) = self.focus.iter().min_by_key(|(_, f)| f.stamp).map(|(tab, _)| tab.clone()) else {
                break;
            };
            self.focus.remove(&oldest);
        }
    }

    fn delivers(&self, wants: &Wants, tab: Option<&str>, topic: &str, scope: Option<&Scope>) -> bool {
        if !wants.topic(topic) {
            return false;
        }
        match (scope, tab.and_then(|t| self.focus.get(t))) {
            (Some(scope), Some(focus)) => focus.shows(scope),
            // An unscoped event, or a tab that declared nothing: everything.
            _ => true,
        }
    }
}

impl Hub {
    // Every mutation leaves the state valid, so a poisoned lock is safe to use.
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn greeting(&self, event: &str, seq: u64) -> Bytes {
        format!("id: {}-{seq}\nevent: {event}\ndata: {}\n\n", self.epoch, self.greeting_data(seq)).into()
    }

    fn greeting_data(&self, seq: u64) -> String {
        format!("{{\"epoch\":\"{}\",\"seq\":{seq},\"caps\":{}}}", self.epoch, self.caps_json)
    }

    /// Lane only (a bus handler): frames the event once, remembers it, hands
    /// it to every stream that wants it.
    fn broadcast(&self, ev: &Event) {
        let filtered = self.options.display_filter.as_ref().and_then(|f| f.filter(ev.topic.as_str(), &ev.payload));
        let Some(payload) = one_line(filtered.as_ref().unwrap_or(&ev.payload)) else {
            tracing::error!(topic = %ev.topic, "event payload is not JSON; not streamed");
            return;
        };
        let mut state = self.state();
        if state.closed {
            return;
        }
        state.seq += 1;
        let seq = state.seq;
        let mut frame = Vec::with_capacity(payload.len() + ev.topic.as_str().len() + 96);
        // Writing into a Vec cannot fail.
        let _ = write!(frame, "id: {}-{seq}\nevent: change\ndata: {{\"reason\":", self.epoch);
        let _ = serde_json::to_writer(&mut frame, ev.topic.as_str());
        let _ = write!(frame, ",\"ts\":{}", ev.ts);
        if !payload.is_empty() {
            frame.extend_from_slice(b",\"payload\":");
            frame.extend_from_slice(&payload);
        }
        frame.extend_from_slice(b"}\n\n");
        let frame = Bytes::from(frame);

        state.ring_bytes += frame.len();
        state.ring.push_back(RingEntry { seq, topic: ev.topic.clone(), scope: ev.scope.clone(), frame: frame.clone() });
        while state.ring.len() > self.options.ring_max_events
            || (state.ring_bytes > self.options.ring_max_bytes && state.ring.len() > 1)
        {
            if let Some(old) = state.ring.pop_front() {
                state.ring_bytes -= old.frame.len();
            }
        }

        let (max_frames, max_bytes) = (self.options.client_max_frames, self.options.client_max_bytes);
        let mut behind = false;
        for client in &state.clients {
            if state.delivers(&client.wants, client.tab.as_deref(), ev.topic.as_str(), ev.scope.as_ref())
                && !client.push(&frame, max_frames, max_bytes)
            {
                behind = true;
            }
        }
        if behind {
            // `push` ended them; they leave the list here so nothing more is
            // queued for a client that is on its way out.
            state.clients.retain(|c| !c.is_ended());
        }
    }

    fn catch_up(&self, state: &State, since: &str, wants: &Wants, tab: Option<&str>, owed: &mut Vec<Bytes>) {
        let last = parse_id(since).filter(|(epoch, _)| *epoch == self.epoch.as_ref()).map(|(_, seq)| seq);
        let oldest = state.ring.front().map_or(state.seq + 1, |e| e.seq);
        match last.filter(|&last| last <= state.seq && last + 1 >= oldest) {
            Some(last) => owed.extend(
                state
                    .ring
                    .iter()
                    .filter(|e| e.seq > last && state.delivers(wants, tab, e.topic.as_str(), e.scope.as_ref()))
                    .map(|e| e.frame.clone()),
            ),
            None => owed.push(self.greeting("resync", state.seq)),
        }
    }

    fn detach(&self, client: &Arc<Client>) {
        let tab_left = {
            let mut state = self.state();
            state.clients.retain(|c| c.id != client.id);
            if let Some(tab) = &client.tab
                && !state.clients.iter().any(|c| c.tab.as_ref() == Some(tab))
            {
                state.focus.remove(tab);
            }
            client.tab.clone()
        };
        if let Some(tab) = tab_left {
            let hooks = self.gone_hooks.lock().unwrap_or_else(|p| p.into_inner()).clone();
            for hook in hooks {
                hook(&tab);
            }
        }
    }
}

/// `<hex epoch>-<decimal seq>`. A sequence too large to hold is past any this
/// stream has issued, which reads as "not replayable" either way.
fn parse_id(id: &str) -> Option<(&str, u64)> {
    let (epoch, seq) = id.split_once('-')?;
    let hex = !epoch.is_empty() && epoch.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    let decimal = !seq.is_empty() && seq.bytes().all(|b| b.is_ascii_digit());
    (hex && decimal).then(|| (epoch, seq.parse().unwrap_or(u64::MAX)))
}

/// A frame's data must sit on one line. Payloads serialized by the bus do;
/// one that arrived pre-serialized with line breaks is re-written compactly.
fn one_line(payload: &Bytes) -> Option<Bytes> {
    if !payload.iter().any(|&b| b == b'\n' || b == b'\r') {
        return Some(payload.clone());
    }
    let value: serde_json::Value = serde_json::from_slice(payload).ok()?;
    serde_json::to_vec(&value).ok().map(Bytes::from)
}

#[cfg(test)]
mod tests;
