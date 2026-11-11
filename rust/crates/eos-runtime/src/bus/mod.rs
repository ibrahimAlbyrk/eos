//! The event bus.
//!
//! What it guarantees (the same things the TypeScript bus gave, which rested
//! on Node's single thread, stated here because nothing is implicit any more):
//!
//! 1. **One order.** Events are delivered one at a time on the ordered lane.
//!    Every subscriber sees the same sequence, and the stream's frame ids
//!    follow it.
//! 2. **A caller's order is kept.** Events published from one thread are
//!    delivered in the order that thread published them. So a writer that
//!    commits and then publishes (the database writer thread, a lane job)
//!    announces its changes in commit order.
//! 3. **State before its event.** A publish made after a state change is
//!    delivered after that change is visible. A transition that must not be
//!    overtaken by another transition's event runs as one lane job
//!    (`Ordered::run`): change, then publish.
//! 4. **Synchronous on the lane.** A publish made on the lane (inside a lane
//!    job) has reached every handler when it returns, as `bus.publish` did in
//!    Node. From any other thread a publish only queues; `flush` waits for it.
//! 5. **Run to completion.** A handler that publishes does not interrupt the
//!    event being delivered: its event goes out right after, to everyone.
//! 6. **Handlers are isolated.** A handler that panics is logged and skipped;
//!    the others still run.
//!
//! Payloads are serialized once, by the publisher, and shared as `Bytes`.

mod announce;
mod coalesce;
mod queue;
mod topic;

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use bytes::Bytes;
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::error::panic_message;
use crate::ordered::Ordered;
pub use announce::Announce;
use coalesce::{Coalescer, Window};
use eos_core::Clock;
pub use queue::{EventReceiver, RecvError};
pub use topic::{Filter, Scope, ScopeKind, Topic, TopicDecl, TopicName};

/// One published event. Cloning shares the payload.
#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    pub topic: TopicName,
    /// The payload as JSON; empty when the event carries none.
    pub payload: Bytes,
    pub scope: Option<Scope>,
    /// Wall-clock milliseconds at publish.
    pub ts: i64,
}

impl Event {
    pub fn payload_as<T: DeserializeOwned>(&self) -> Result<T, serde_json::Error> {
        serde_json::from_slice(&self.payload)
    }
}

type HandlerFn = Arc<dyn Fn(&Event) + Send + Sync>;

#[derive(Clone)]
struct Entry {
    id: u64,
    handler: HandlerFn,
}

#[derive(Default)]
struct Table {
    by_topic: HashMap<TopicName, Arc<[Entry]>>,
    all: Arc<[Entry]>,
    next_id: u64,
}

struct Delivery {
    pending: VecDeque<Event>,
    delivering: bool,
    coalescer: Option<Coalescer>,
}

/// Events a single delivery may queue behind itself. Reaching it means two
/// handlers publish at each other without end; the extra events are dropped
/// and the loop is logged.
const MAX_PENDING: usize = 65_536;

struct Inner {
    lane: Ordered,
    clock: Arc<dyn Clock>,
    table: Mutex<Table>,
    delivery: Mutex<Delivery>,
    delta_window: Option<Duration>,
}

#[derive(Debug, Clone, Copy)]
pub struct BusOptions {
    /// How long `agent:delta` text is held and merged (today: 50 ms). `None`
    /// delivers every delta as published.
    pub delta_window: Option<Duration>,
}

impl Default for BusOptions {
    fn default() -> Self {
        Self { delta_window: Some(Duration::from_millis(50)) }
    }
}

#[derive(Clone)]
pub struct Bus {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for Bus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Bus").field("subscribers", &self.subscriber_count()).finish_non_exhaustive()
    }
}

impl Bus {
    pub fn new(lane: Ordered, clock: Arc<dyn Clock>, options: BusOptions) -> Self {
        let delivery = Delivery {
            pending: VecDeque::new(),
            delivering: false,
            coalescer: options.delta_window.map(|_| Coalescer::default()),
        };
        Self {
            inner: Arc::new(Inner {
                lane,
                clock,
                table: Mutex::default(),
                delivery: Mutex::new(delivery),
                delta_window: options.delta_window,
            }),
        }
    }

    /// Publishes `payload` under `topic`. The payload is serialized here, once.
    pub fn publish<T: Serialize>(&self, topic: &Topic<T>, payload: &T) {
        match serde_json::to_vec(payload) {
            Ok(json) => self.publish_raw(topic.name(), topic.scope_of(payload), json.into()),
            Err(e) => {
                tracing::error!(topic = topic.name(), error = %e, "event payload could not be serialized; dropped")
            }
        }
    }

    /// Publishes JSON that is already serialized (a plugin's own events, a
    /// payload forwarded from elsewhere). An empty payload means "none".
    pub fn publish_raw(&self, topic: impl Into<TopicName>, scope: Option<Scope>, payload: Bytes) {
        let ev = Event { topic: topic.into(), payload, scope, ts: self.inner.clock.now_ms() };
        if self.inner.lane.is_current() {
            self.inner.accept(ev);
        } else {
            let inner = self.inner.clone();
            // A stopped lane means the app is shutting down: nobody is left to hear it.
            let _ = self.inner.lane.post(move || inner.accept(ev));
        }
    }

    /// Runs `handler` on the lane for every matching event, in order: first
    /// the topic's own subscribers in the order they subscribed, then the
    /// subscribers to everything. Handlers must not block; one that needs to
    /// wait hands the event to a task (or uses [`Bus::subscribe`]).
    ///
    /// Dropping the returned subscription ends it; no delivery starts for it
    /// afterwards.
    pub fn on(&self, filter: impl Into<Filter>, handler: impl Fn(&Event) + Send + Sync + 'static) -> Subscription {
        let filter = filter.into();
        let mut table = self.inner.table();
        table.next_id += 1;
        let entry = Entry { id: table.next_id, handler: Arc::new(handler) };
        let id = entry.id;
        let list = match &filter {
            Filter::All => &mut table.all,
            Filter::Topic(name) => table.by_topic.entry(name.clone()).or_default(),
        };
        *list = list.iter().cloned().chain(std::iter::once(entry)).collect();
        Subscription { bus: Arc::downgrade(&self.inner), filter, id }
    }

    /// Events through a bounded queue of `capacity`, read with `recv().await`.
    /// See [`EventReceiver`] for what happens to a slow reader.
    pub fn subscribe(&self, filter: impl Into<Filter>, capacity: usize) -> EventReceiver {
        EventReceiver::new(self, filter.into(), capacity)
    }

    /// Resolves once everything published before this call has been delivered.
    pub fn flush(&self) -> impl Future<Output = ()> + Send + 'static {
        let done = self.inner.lane.run(|| ());
        async move {
            let _ = done.await;
        }
    }

    /// Live subscriptions, for leak checks.
    pub fn subscriber_count(&self) -> usize {
        let table = self.inner.table();
        table.all.len() + table.by_topic.values().map(|l| l.len()).sum::<usize>()
    }

    /// Topics that have a subscriber of their own, for leak checks.
    pub fn subscribed_topics(&self) -> usize {
        self.inner.table().by_topic.len()
    }

    /// The lane this bus delivers on: run a transition there to order it with
    /// its event.
    pub fn lane(&self) -> &Ordered {
        &self.inner.lane
    }

    pub(crate) fn clock(&self) -> &Arc<dyn Clock> {
        &self.inner.clock
    }
}

impl Inner {
    // Neither lock is held while a handler runs, and what they guard stays
    // valid at every step, so a poisoned lock is safe to keep using.
    fn table(&self) -> MutexGuard<'_, Table> {
        self.table.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn delivery(&self) -> MutexGuard<'_, Delivery> {
        self.delivery.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Lane only: takes one published event and delivers whatever is due.
    fn accept(self: &Arc<Self>, ev: Event) {
        let mut d = self.delivery();
        if d.pending.len() >= MAX_PENDING {
            tracing::error!(topic = %ev.topic, "handlers keep publishing at each other; event dropped");
            return;
        }
        let Delivery { pending, coalescer, .. } = &mut *d;
        match coalescer {
            Some(coalescer) => {
                if let Some(window) = coalescer.offer(ev, self.clock.now_ms(), pending) {
                    self.time_window(window);
                }
            }
            None => pending.push_back(ev),
        }
        self.drain(d);
    }

    fn time_window(self: &Arc<Self>, window: Window) {
        let Some(delay) = self.delta_window else { return };
        let inner = self.clone();
        self.lane.after(delay, move || {
            let mut d = inner.delivery();
            let Delivery { pending, coalescer, .. } = &mut *d;
            let keep = coalescer.as_mut().is_some_and(|c| c.window_closed(&window, inner.clock.now_ms(), pending));
            inner.drain(d);
            if keep {
                inner.time_window(window);
            }
        });
    }

    fn drain<'a>(&'a self, mut d: MutexGuard<'a, Delivery>) {
        if d.delivering {
            // Called from a handler: the delivery in progress sends it next.
            return;
        }
        d.delivering = true;
        while let Some(ev) = d.pending.pop_front() {
            drop(d);
            self.deliver(&ev);
            d = self.delivery();
        }
        d.delivering = false;
    }

    fn deliver(&self, ev: &Event) {
        let (own, all) = {
            let table = self.table();
            (table.by_topic.get(ev.topic.as_str()).cloned(), table.all.clone())
        };
        for entry in own.iter().flat_map(|l| l.iter()).chain(all.iter()) {
            if let Err(payload) = catch_unwind(AssertUnwindSafe(|| (entry.handler)(ev))) {
                tracing::error!(topic = %ev.topic, panic = %panic_message(payload.as_ref()), "a bus handler panicked");
            }
        }
    }

    fn remove(&self, filter: &Filter, id: u64) {
        let mut table = self.table();
        match filter {
            Filter::All => table.all = table.all.iter().filter(|e| e.id != id).cloned().collect(),
            Filter::Topic(name) => {
                let Some(list) = table.by_topic.get_mut(name.as_str()) else { return };
                *list = list.iter().filter(|e| e.id != id).cloned().collect();
                if list.is_empty() {
                    table.by_topic.remove(name.as_str());
                }
            }
        }
    }
}

/// A live subscription. Dropping it unsubscribes.
#[must_use = "dropping a subscription ends it"]
pub struct Subscription {
    bus: Weak<Inner>,
    filter: Filter,
    id: u64,
}

impl Subscription {
    /// Keeps the subscription for as long as the bus lives.
    pub fn forever(mut self) {
        self.bus = Weak::new();
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(bus) = self.bus.upgrade() {
            bus.remove(&self.filter, self.id);
        }
    }
}

impl std::fmt::Debug for Subscription {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Subscription").field("filter", &self.filter).field("id", &self.id).finish()
    }
}

#[cfg(test)]
mod tests;
