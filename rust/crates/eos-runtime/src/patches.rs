//! Row patches (`manager/remote/patcher.ts`): the bus's worker and pending
//! change topics carry only ids, so a client that keeps a list would have to
//! read the whole list again on every one. A [`StatePatcher`] folds a burst
//! of changes into row changes instead: it waits out the burst, reads the
//! list route once, and hands its [`PatchSink`] one upsert or remove per
//! changed row.
//!
//! The row is exactly what the list route serves — the JSON a client's first
//! read parses — so a patch and a listed row are interchangeable. One patcher
//! serves one kind of client: the phone's reads `/workers` and sends `patch`
//! frames, the dashboard's reads the brief rows and publishes `state:patch`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use bytes::Bytes;
use eos_contracts::stream::topics;
use serde::Deserialize;
use serde_json::value::RawValue;
use tokio::runtime::Handle;

use crate::access::Caller;
use crate::bus::{Bus, Event, Subscription};
use crate::http::{Method, Request};
use crate::router::{BoxFuture, Router};

/// A row can change without a `worker:change`: its cost (`usage:recorded`).
pub const WORKER_TOPICS: &[&str] =
    &[topics::WORKER_SPAWN, topics::WORKER_CHANGE, topics::WORKER_EXIT, topics::WORKER_REMOVED, topics::USAGE_RECORDED];
pub const PENDING_TOPICS: &[&str] = &[topics::PENDING_CREATED, topics::PENDING_RESOLVED, "pending:ttl_expired"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowResource {
    Workers,
    Pending,
}

impl RowResource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Workers => "workers",
            Self::Pending => "pending",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowOp {
    Upsert,
    Remove,
}

impl RowOp {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Upsert => "upsert",
            Self::Remove => "remove",
        }
    }
}

/// One changed row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowChange {
    pub resource: RowResource,
    pub op: RowOp,
    /// The row's JSON as the list route wrote it, or `{"id":…}` for a remove.
    pub data: Bytes,
}

/// Where row changes go.
pub trait PatchSink: Send + Sync + 'static {
    /// Whether anyone is there to push to. When not, a burst is dropped unread.
    fn active(&self) -> bool;
    /// One burst's changes: workers first, each list in the order its rows changed.
    fn push(&self, changes: Vec<RowChange>) -> BoxFuture<'_, ()>;
}

#[derive(Debug, Clone)]
pub struct PatchOptions {
    /// The list routes the rows are read from.
    pub workers: String,
    pub pending: String,
    /// Who the reads are made as.
    pub caller: Caller,
    /// How long a burst is collected before the lists are read (today: 150 ms).
    pub debounce: Duration,
}

impl PatchOptions {
    /// The full rows of `/workers` and `/pending`, read as `caller`.
    pub fn full_rows(caller: Caller) -> Self {
        Self { workers: "/workers".into(), pending: "/pending".into(), caller, debounce: Duration::from_millis(150) }
    }
}

#[derive(Default)]
struct Dirty {
    // In the order the ids were first marked; an id is listed once.
    workers: Vec<String>,
    pending: Vec<String>,
    /// A read is due once the burst is over.
    armed: bool,
    flushing: bool,
}

struct Shared {
    router: Arc<Router>,
    options: PatchOptions,
    sink: Arc<dyn PatchSink>,
    dirty: Mutex<Dirty>,
    tasks: Handle,
}

impl Shared {
    fn dirty(&self) -> MutexGuard<'_, Dirty> {
        // Two id lists and two flags: valid after any panic.
        self.dirty.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn mark(self: &Arc<Self>, resource: RowResource, event: &Event, key: &str) {
        let Ok(serde_json::Value::Object(payload)) = event.payload_as::<serde_json::Value>() else { return };
        let Some(id) = payload.get(key).and_then(|v| v.as_str()).filter(|id| !id.is_empty()) else { return };
        let mut dirty = self.dirty();
        let ids = match resource {
            RowResource::Workers => &mut dirty.workers,
            RowResource::Pending => &mut dirty.pending,
        };
        if !ids.iter().any(|known| known == id) {
            ids.push(id.to_owned());
        }
        self.arm(&mut dirty);
    }

    fn arm(self: &Arc<Self>, dirty: &mut Dirty) {
        if dirty.armed {
            return;
        }
        dirty.armed = true;
        let shared = self.clone();
        self.tasks.spawn(async move {
            tokio::time::sleep(shared.options.debounce).await;
            shared.dirty().armed = false;
            shared.flush().await;
        });
    }

    /// Reads the lists once and pushes one change per dirty id: a row that is
    /// listed is an upsert with the whole row, one that is not is a remove.
    async fn flush(self: &Arc<Self>) {
        let (workers, pending) = {
            let mut dirty = self.dirty();
            if dirty.flushing {
                // The running flush arms again for what it missed.
                return;
            }
            dirty.flushing = true;
            (std::mem::take(&mut dirty.workers), std::mem::take(&mut dirty.pending))
        };
        if self.sink.active() {
            let mut changes = Vec::new();
            if !workers.is_empty() {
                changes.extend(self.read(RowResource::Workers, &self.options.workers, &workers).await);
            }
            if !pending.is_empty() {
                changes.extend(self.read(RowResource::Pending, &self.options.pending, &pending).await);
            }
            if !changes.is_empty() {
                self.sink.push(changes).await;
            }
        }
        let mut dirty = self.dirty();
        dirty.flushing = false;
        if !dirty.workers.is_empty() || !dirty.pending.is_empty() {
            self.arm(&mut dirty);
        }
    }

    async fn read(&self, resource: RowResource, list: &str, ids: &[String]) -> Vec<RowChange> {
        let request = Request::new(Method::Get, list, self.options.caller.clone());
        let body = self.router.handle(request).await.body.collect().await.unwrap_or_default();
        // Anything but a list of rows reads as an empty list, as today.
        let rows: Vec<&RawValue> = serde_json::from_slice(&body).unwrap_or_default();
        let by_id: HashMap<String, &RawValue> = rows.into_iter().filter_map(|row| Some((row_id(row)?, row))).collect();
        ids.iter()
            .map(|id| match by_id.get(id) {
                Some(row) => {
                    RowChange { resource, op: RowOp::Upsert, data: Bytes::copy_from_slice(row.get().as_bytes()) }
                }
                None => {
                    let data = serde_json::to_vec(&serde_json::json!({ "id": id })).unwrap_or_default();
                    RowChange { resource, op: RowOp::Remove, data: data.into() }
                }
            })
            .collect()
    }
}

/// The row's `id`, when it is a string.
fn row_id(row: &RawValue) -> Option<String> {
    #[derive(Deserialize)]
    struct Id {
        id: Option<serde_json::Value>,
    }
    match serde_json::from_str::<Id>(row.get()).ok()?.id? {
        serde_json::Value::String(id) => Some(id),
        _ => None,
    }
}

/// Runs for as long as it lives; dropping it stops it.
pub struct StatePatcher {
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for StatePatcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("StatePatcher")
    }
}

impl StatePatcher {
    /// Starts following the change topics. Call inside the async runtime.
    pub fn start(bus: &Bus, router: Arc<Router>, options: PatchOptions, sink: Arc<dyn PatchSink>) -> Self {
        let shared = Arc::new(Shared { router, options, sink, dirty: Mutex::default(), tasks: Handle::current() });
        let mut subscriptions = Vec::new();
        // A pending payload carries both `id` (its row) and `workerId` (who asked).
        let follow = [(RowResource::Workers, WORKER_TOPICS, "workerId"), (RowResource::Pending, PENDING_TOPICS, "id")];
        for (resource, list, key) in follow {
            for topic in list {
                let shared = shared.clone();
                subscriptions.push(bus.on(*topic, move |event| shared.mark(resource, event, key)));
            }
        }
        Self { _subscriptions: subscriptions }
    }
}

#[cfg(test)]
mod tests {
    //! `manager/remote/__tests__/patcher.test.ts`.

    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use serde_json::json;
    use tokio::sync::mpsc;

    use super::*;
    use crate::access::{Access, Tier};
    use crate::bus::BusOptions;
    use crate::http::Response;
    use crate::ordered::Ordered;
    use crate::router::RouteDef;
    use eos_core::SystemClock;

    struct Sink {
        active: AtomicBool,
        pushed: mpsc::UnboundedSender<Vec<RowChange>>,
    }

    impl PatchSink for Sink {
        fn active(&self) -> bool {
            self.active.load(Ordering::SeqCst)
        }
        fn push(&self, changes: Vec<RowChange>) -> BoxFuture<'_, ()> {
            let _ = self.pushed.send(changes);
            Box::pin(std::future::ready(()))
        }
    }

    struct Harness {
        bus: Bus,
        sink: Arc<Sink>,
        pushed: mpsc::UnboundedReceiver<Vec<RowChange>>,
        workers: Arc<Mutex<serde_json::Value>>,
        reads: Arc<AtomicUsize>,
        _patcher: StatePatcher,
    }

    fn harness() -> Harness {
        let bus = Bus::new(Ordered::new(), Arc::new(SystemClock), BusOptions { delta_window: None });
        let workers = Arc::new(Mutex::new(json!([])));
        let reads = Arc::new(AtomicUsize::new(0));
        let (list, count) = (workers.clone(), reads.clone());
        let router = Router::builder()
            .route(
                RouteDef::get("/workers", move |_req: Request| {
                    count.fetch_add(1, Ordering::SeqCst);
                    let rows = list.lock().expect("lock").clone();
                    async move { Ok(Response::json(200, &rows)) }
                })
                .access(Access::open().phone(Tier::Read)),
            )
            .route(
                RouteDef::get("/pending", |_req: Request| async {
                    Ok(Response::json(200, &json!([{ "id": "p1", "tool": "Bash" }])))
                })
                .access(Access::open().phone(Tier::Read)),
            )
            .build()
            .expect("a router");
        let (tx, pushed) = mpsc::unbounded_channel();
        let sink = Arc::new(Sink { active: AtomicBool::new(true), pushed: tx });
        let options = PatchOptions { debounce: Duration::from_millis(5), ..PatchOptions::full_rows(Caller::Internal) };
        let patcher = StatePatcher::start(&bus, Arc::new(router), options, sink.clone());
        Harness { bus, sink, pushed, workers, reads, _patcher: patcher }
    }

    fn publish(bus: &Bus, topic: &'static str, payload: serde_json::Value) {
        bus.publish_raw(topic, None, payload.to_string().into());
    }

    fn change(resource: RowResource, op: RowOp, data: serde_json::Value) -> RowChange {
        RowChange { resource, op, data: data.to_string().into() }
    }

    async fn next(h: &mut Harness) -> Vec<RowChange> {
        tokio::time::timeout(Duration::from_secs(10), h.pushed.recv()).await.expect("a push in time").expect("open")
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_burst_of_changes_is_one_read_and_one_change_per_row() {
        let mut h = harness();
        *h.workers.lock().expect("lock") = json!([{ "id": "w1", "state": "IDLE", "cost": 0.5 }, { "id": "w2" }]);
        for _ in 0..3 {
            publish(&h.bus, "worker:change", json!({ "workerId": "w1" }));
        }
        publish(&h.bus, "worker:removed", json!({ "workerId": "gone" }));
        publish(&h.bus, "usage:recorded", json!({ "workerId": "w2" }));
        publish(&h.bus, "pending:created", json!({ "id": "p1", "workerId": "w1" }));
        publish(&h.bus, "pending:resolved", json!({ "id": "p0", "workerId": "w1" }));
        assert_eq!(
            next(&mut h).await,
            [
                change(RowResource::Workers, RowOp::Upsert, json!({ "id": "w1", "state": "IDLE", "cost": 0.5 })),
                change(RowResource::Workers, RowOp::Remove, json!({ "id": "gone" })),
                change(RowResource::Workers, RowOp::Upsert, json!({ "id": "w2" })),
                change(RowResource::Pending, RowOp::Upsert, json!({ "id": "p1", "tool": "Bash" })),
                change(RowResource::Pending, RowOp::Remove, json!({ "id": "p0" })),
            ]
        );
        assert_eq!(h.reads.load(Ordering::SeqCst), 1, "the worker list was read once for the burst");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_payload_without_an_id_marks_nothing_and_an_idle_sink_reads_nothing() {
        let mut h = harness();
        publish(&h.bus, "worker:change", json!({ "state": "IDLE" }));
        publish(&h.bus, "worker:change", json!({ "workerId": "" }));
        publish(&h.bus, "worker:change", json!({ "workerId": 7 }));

        h.sink.active.store(false, Ordering::SeqCst);
        publish(&h.bus, "worker:change", json!({ "workerId": "w1" }));
        h.bus.flush().await;
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert_eq!(h.reads.load(Ordering::SeqCst), 0, "nobody to push to: the burst is dropped unread");

        h.sink.active.store(true, Ordering::SeqCst);
        publish(&h.bus, "worker:change", json!({ "workerId": "w2" }));
        assert_eq!(next(&mut h).await, [change(RowResource::Workers, RowOp::Remove, json!({ "id": "w2" }))]);
        assert_eq!(h.reads.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn stops_when_dropped() {
        let h = harness();
        let Harness { bus, mut pushed, reads, _patcher: patcher, .. } = h;
        drop(patcher);
        publish(&bus, "worker:change", json!({ "workerId": "w1" }));
        bus.flush().await;
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert_eq!(reads.load(Ordering::SeqCst), 0);
        assert!(pushed.try_recv().is_err());
    }
}
