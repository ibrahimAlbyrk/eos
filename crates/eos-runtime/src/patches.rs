//! Row patches: the bus's worker and pending change topics carry only ids, so a
//! client that keeps a list would have to read the whole list again on every
//! one. A [`StatePatcher`] folds a burst of changes into row changes instead:
//! it waits out the burst, reads the list route once, and hands its
//! [`PatchSink`] one upsert or remove per changed row.
//!
//! The row is exactly what the list route serves — the JSON a client's first
//! read parses — so a patch and a listed row are interchangeable. One patcher
//! serves one kind of client: the phone's reads `/workers` and sends `patch`
//! frames, the dashboard's reads the brief rows and publishes `state:patch`.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use bytes::Bytes;
use eos_contracts::stream::topics;
use eos_core::workers::ListedWorkers;
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

#[derive(Clone)]
pub struct PatchOptions {
    /// The list routes the rows are read from.
    pub workers: String,
    pub pending: String,
    /// The `workers` route's rows by id: when set, a burst reads only its
    /// workers' rows instead of the whole list. It must serve exactly what
    /// that route lists.
    pub worker_rows: Option<Arc<dyn ListedWorkers>>,
    /// Who the reads are made as.
    pub caller: Caller,
    /// How long a burst is collected before the lists are read (today: 150 ms).
    pub debounce: Duration,
}

impl PatchOptions {
    /// The full rows of `/workers` and `/pending`, read as `caller`.
    pub fn full_rows(caller: Caller) -> Self {
        Self {
            workers: "/workers".into(),
            pending: "/pending".into(),
            worker_rows: None,
            caller,
            debounce: Duration::from_millis(150),
        }
    }
}

impl std::fmt::Debug for PatchOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PatchOptions")
            .field("workers", &self.workers)
            .field("pending", &self.pending)
            .field("worker_rows", &self.worker_rows.is_some())
            .field("caller", &self.caller)
            .field("debounce", &self.debounce)
            .finish()
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
        let Some(id) = id_of(&event.payload, key) else { return };
        let mut dirty = self.dirty();
        let ids = match resource {
            RowResource::Workers => &mut dirty.workers,
            RowResource::Pending => &mut dirty.pending,
        };
        if !ids.contains(&id) {
            ids.push(id);
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
                changes.extend(self.read_workers(&workers).await);
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

    async fn read_workers(&self, ids: &[String]) -> Vec<RowChange> {
        let Some(source) = &self.options.worker_rows else {
            return self.read(RowResource::Workers, &self.options.workers, ids).await;
        };
        // A failed read is an empty list, as the route's error answer reads; so is a route that
        // would not have answered (its feature did not start, the caller is refused).
        let admitted = self.router.admits(Method::Get, &self.options.workers, &self.options.caller);
        let mut rows = if admitted { source.rows(ids).await.unwrap_or_default() } else { HashMap::new() };
        changes(RowResource::Workers, ids, |id| rows.remove(id).map(Bytes::from))
    }

    async fn read(&self, resource: RowResource, list: &str, ids: &[String]) -> Vec<RowChange> {
        let request = Request::new(Method::Get, list, self.options.caller.clone());
        let body = self.router.handle(request).await.body.collect().await.unwrap_or_default();
        // Anything but a list of rows reads as an empty list, as today.
        let rows: Vec<&RawValue> = serde_json::from_slice(&body).unwrap_or_default();
        let by_id: HashMap<String, &RawValue> = rows.into_iter().filter_map(|row| Some((row_id(row)?, row))).collect();
        changes(resource, ids, |id| by_id.get(id).map(|row| Bytes::copy_from_slice(row.get().as_bytes())))
    }
}

/// One change per id: an upsert with the row found for it, else a remove.
fn changes(resource: RowResource, ids: &[String], mut row: impl FnMut(&str) -> Option<Bytes>) -> Vec<RowChange> {
    ids.iter()
        .map(|id| match row(id) {
            Some(data) => RowChange { resource, op: RowOp::Upsert, data },
            None => {
                let data = serde_json::to_vec(&serde_json::json!({ "id": id })).unwrap_or_default();
                RowChange { resource, op: RowOp::Remove, data: data.into() }
            }
        })
        .collect()
}

/// The payload's `key` when the payload is an object and that is a string other than "".
fn id_of(payload: &[u8], key: &str) -> Option<String> {
    let fields: HashMap<Cow<'_, str>, &RawValue> = serde_json::from_slice(payload).ok()?;
    let id: String = serde_json::from_str(fields.get(key)?.get()).ok()?;
    Some(id).filter(|id| !id.is_empty())
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
        failed: Arc<crate::module::FailedModules>,
    }

    /// Rows by id from the same list the route serves; `None`: the read fails.
    struct ById {
        workers: Arc<Mutex<serde_json::Value>>,
        fails: AtomicBool,
    }

    impl ListedWorkers for ById {
        fn rows<'a>(&'a self, ids: &'a [String]) -> BoxFuture<'a, Result<HashMap<String, Vec<u8>>, eos_core::Error>> {
            let rows = self.workers.lock().expect("lock").clone();
            let fails = self.fails.load(Ordering::SeqCst);
            Box::pin(async move {
                if fails {
                    return Err(eos_core::Error::Storage("the database is busy".into()));
                }
                Ok(rows
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|row| Some((row["id"].as_str()?.to_owned(), serde_json::to_vec(row).ok()?)))
                    .filter(|(id, _)| ids.contains(id))
                    .collect())
            })
        }
    }

    fn harness() -> Harness {
        harness_with(None)
    }

    fn harness_with(by_id: Option<Arc<ById>>) -> Harness {
        let bus = Bus::new(Ordered::new(), Arc::new(SystemClock), BusOptions { delta_window: None });
        let workers = Arc::new(Mutex::new(json!([])));
        let reads = Arc::new(AtomicUsize::new(0));
        let (list, count) = (workers.clone(), reads.clone());
        let failed = Arc::new(crate::module::FailedModules::default());
        let router = Router::builder()
            .failed(failed.clone())
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
        let worker_rows = by_id.map(|by_id| by_id as Arc<dyn ListedWorkers>);
        let options = PatchOptions {
            debounce: Duration::from_millis(5),
            worker_rows,
            ..PatchOptions::full_rows(Caller::Internal)
        };
        let patcher = StatePatcher::start(&bus, Arc::new(router), options, sink.clone());
        Harness { bus, sink, pushed, workers, reads, _patcher: patcher, failed }
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
    async fn rows_by_id_patch_as_the_list_does_without_reading_it() {
        let rows = json!([{ "id": "w1", "state": "IDLE", "cost": 0.5, "prompt": "é \" 😀" }, { "id": "w2" }]);
        let burst = |h: &Harness| {
            publish(&h.bus, "worker:change", json!({ "workerId": "w1" }));
            publish(&h.bus, "worker:removed", json!({ "workerId": "gone" }));
            publish(&h.bus, "usage:recorded", json!({ "workerId": "w2" }));
        };
        let mut listed = harness();
        *listed.workers.lock().expect("lock") = rows.clone();
        burst(&listed);
        let from_list = next(&mut listed).await;

        let by_id = Arc::new(ById { workers: Arc::new(Mutex::new(rows)), fails: AtomicBool::new(false) });
        let mut h = harness_with(Some(by_id.clone()));
        burst(&h);
        assert_eq!(next(&mut h).await, from_list, "the same changes, the same bytes");
        assert_eq!(h.reads.load(Ordering::SeqCst), 0, "the list route is not read");

        // A read that fails reads as an empty list, as the route's error answer did.
        by_id.fails.store(true, Ordering::SeqCst);
        publish(&h.bus, "worker:change", json!({ "workerId": "w1" }));
        assert_eq!(next(&mut h).await, [change(RowResource::Workers, RowOp::Remove, json!({ "id": "w1" }))]);

        // So does a list whose feature did not start (it answers 503), as the route read did.
        by_id.fails.store(false, Ordering::SeqCst);
        publish(&h.bus, "worker:change", json!({ "workerId": "w1" }));
        assert_eq!(next(&mut h).await[0].op, RowOp::Upsert);
        h.failed.fail("kernel", "a broken database");
        publish(&h.bus, "worker:change", json!({ "workerId": "w1" }));
        assert_eq!(next(&mut h).await, [change(RowResource::Workers, RowOp::Remove, json!({ "id": "w1" }))]);
    }

    #[test]
    fn an_id_is_a_non_empty_string_of_an_object() {
        assert_eq!(id_of(br#"{"workerId":"w-1","rowId":3,"x":{"y":[1]}}"#, "workerId").as_deref(), Some("w-1"));
        assert_eq!(id_of(br#"{"workerId":"w-\u0031"}"#, "workerId").as_deref(), Some("w-1"));
        assert_eq!(id_of(br#"{"workerId":"a","workerId":"b"}"#, "workerId").as_deref(), Some("b"), "the last wins");
        for payload in [&br#"{"workerId":""}"#[..], br#"{"workerId":7}"#, br#"{"id":"p"}"#, br#"["w"]"#, b"", b"{"] {
            assert_eq!(id_of(payload, "workerId"), None, "{}", String::from_utf8_lossy(payload));
        }
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
