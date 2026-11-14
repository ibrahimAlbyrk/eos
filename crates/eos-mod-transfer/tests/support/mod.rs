//! Two computers in one process: each has its own disk (a temporary folder),
//! its own database and its own router. "Here" reaches "there" through the
//! `Machines` port, which hands each request to the other router as a paired
//! computer's dashboard would arrive — so the peer endpoint, the routes and
//! the disk endpoint are all the real ones; only the link is left out.

#![allow(dead_code, clippy::unwrap_used)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use eos_contracts::{HostView, TransferRecord, TransferStatus};
use eos_core::git::ProjectKeys;
use eos_core::net::machines::{Machines, PeerCallError, PeerRequest, PeerResponse};
use eos_core::net::transfer::TransferEndpoint;
use eos_core::{BoxFuture, Clock, Sleeper};
use eos_mod_transfer::{TransferModule, TransferService, TransferServiceDeps};
use eos_runtime::access::Caller;
use eos_runtime::bus::{Filter, Subscription};
use eos_runtime::http::{Method, Request};
use eos_runtime::module::Module;
use eos_runtime::router::{AllPluginsOn, Router};
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_testkit::{SeqIds, TempStore};
use eos_transfer_fs::{FsTransferEndpoint, FsTransferEndpointDeps};
use serde_json::json;
use tokio::sync::Notify;

pub(crate) const HOST: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
pub(crate) const OTHER: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

pub(crate) fn s(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Folder → project key, as a test sets it.
#[derive(Default)]
pub(crate) struct Keys(pub(crate) Mutex<HashMap<String, String>>);

impl ProjectKeys for Keys {
    fn to_key<'a>(&'a self, path: &'a str) -> BoxFuture<'a, String> {
        let key = self.0.lock().unwrap().get(path).cloned().unwrap_or_else(|| format!("path:{path}"));
        Box::pin(std::future::ready(key))
    }
    fn to_path<'a>(&'a self, _key: &'a str, hint: &'a str) -> BoxFuture<'a, String> {
        Box::pin(std::future::ready(hint.to_owned()))
    }
    fn find_path<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Option<String>> {
        let found = self.0.lock().unwrap().iter().find(|(_, k)| *k == key).map(|(path, _)| path.clone());
        Box::pin(std::future::ready(found))
    }
}

/// A disk endpoint over `home`, with a Trash that just removes.
pub(crate) fn disk(home: &Path, keys: &Arc<Keys>, clock: &Arc<dyn Clock>) -> Arc<FsTransferEndpoint> {
    Arc::new(FsTransferEndpoint::new(FsTransferEndpointDeps {
        home: home.to_owned(),
        forbidden: vec![home.join(".eos")],
        trash: Arc::new(|path| {
            if path.is_dir() { std::fs::remove_dir_all(path) } else { std::fs::remove_file(path) }
                .map_err(|e| e.to_string())
        }),
        projects: keys.clone(),
        clock: clock.clone(),
    }))
}

pub(crate) fn host(id: &str, name: &str, state: &str) -> HostView {
    serde_json::from_value(json!({
        "id": id, "name": name, "alias": null, "platform": "darwin", "addrs": [], "pairedAt": 0,
        "lastConnectedAt": 0, "deviceId": &id[..8], "hasRelay": false,
        "link": { "state": state, "route": "direct", "rttMs": 3, "since": 0, "attempt": 0, "error": null },
        "info": null,
    }))
    .unwrap()
}

/// The paired computers of "here", and the links to them.
pub(crate) struct Links {
    pub(crate) hosts: Mutex<Vec<HostView>>,
    pub(crate) routers: Mutex<HashMap<String, Arc<Router>>>,
    /// Each paired computer's home folder, as its `/api/host` says it.
    pub(crate) homes: Mutex<HashMap<String, String>>,
    /// The link is down: every call fails as dropped.
    pub(crate) down: AtomicBool,
    /// Reads wait here until released.
    pub(crate) hold_reads: AtomicBool,
    pub(crate) release: Notify,
    pub(crate) calls: AtomicUsize,
}

impl Links {
    pub(crate) fn new(hosts: Vec<HostView>) -> Arc<Self> {
        Arc::new(Self {
            hosts: Mutex::new(hosts),
            routers: Mutex::default(),
            homes: Mutex::default(),
            down: AtomicBool::new(false),
            hold_reads: AtomicBool::new(false),
            release: Notify::new(),
            calls: AtomicUsize::new(0),
        })
    }
}

impl Machines for Links {
    fn local_name(&self) -> String {
        "MacBook Pro".to_owned()
    }

    fn list(&self) -> Vec<HostView> {
        self.hosts.lock().unwrap().clone()
    }

    fn get(&self, id: &str) -> Option<HostView> {
        self.hosts.lock().unwrap().iter().find(|host| host.id.0 == id).cloned()
    }

    fn call<'a>(
        &'a self,
        host_id: &'a str,
        request: PeerRequest,
    ) -> BoxFuture<'a, Result<PeerResponse, PeerCallError>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.down.load(Ordering::SeqCst) {
                return Err(PeerCallError::Dropped);
            }
            let router = self.routers.lock().unwrap().get(host_id).cloned().ok_or(PeerCallError::NotPaired)?;
            // The host feature's route, which the transfer feature only calls.
            if request.target == "/api/host" {
                let home = self.homes.lock().unwrap().get(host_id).cloned().unwrap_or_default();
                let info = json!({
                    "id": host_id, "deviceId": &host_id[..8], "name": "Office", "platform": "darwin",
                    "home": home, "apiStamp": "test", "servesUi": false,
                });
                return Ok(PeerResponse { status: 200, body: info.to_string().into() });
            }
            if request.target.starts_with("/transfer/read") && self.hold_reads.load(Ordering::SeqCst) {
                self.release.notified().await;
            }
            // As the other computer's gateway hands it over: this computer's dashboard.
            let caller = Caller::Peer { device: "a".repeat(64).into(), human: true };
            let mut incoming = Request::new(Method::parse(request.method).unwrap(), &request.target, caller);
            if let Some(content_type) = request.content_type {
                incoming = incoming.header("content-type", content_type);
            }
            let response = router.handle(incoming.body(request.body)).await;
            let body = response.body.collect().await.map_err(|_| PeerCallError::Dropped)?;
            Ok(PeerResponse { status: response.status, body })
        })
    }
}

/// Nothing is paired.
pub(crate) fn alone() -> Arc<Links> {
    Links::new(Vec::new())
}

/// Waiting is over at once.
pub(crate) struct NoWait;

impl Sleeper for NoWait {
    fn sleep(&self, _ms: i64) -> BoxFuture<'static, ()> {
        Box::pin(tokio::task::yield_now())
    }
}

/// The system's time, or one that jumps `step` at every look.
pub(crate) struct TestClock {
    step: i64,
    now: AtomicI64,
}

impl TestClock {
    pub(crate) fn real() -> Arc<dyn Clock> {
        Arc::new(eos_core::SystemClock)
    }

    pub(crate) fn stepping(step: i64) -> Arc<dyn Clock> {
        Arc::new(Self { step, now: AtomicI64::new(0) })
    }
}

impl Clock for TestClock {
    fn now_ms(&self) -> i64 {
        self.now.fetch_add(self.step, Ordering::SeqCst) + self.step
    }
}

/// One computer: its folder, database, kernel and transfer feature.
pub(crate) struct Computer {
    pub(crate) home: PathBuf,
    pub(crate) keys: Arc<Keys>,
    pub(crate) store: TempStore,
    pub(crate) kernel: Kernel,
    pub(crate) module: Arc<TransferModule>,
    pub(crate) service: Arc<TransferService>,
    pub(crate) runtime: Runtime,
    pub(crate) banners: Arc<Mutex<Vec<serde_json::Value>>>,
    pub(crate) rang: Arc<Notify>,
    _heard: Vec<Subscription>,
}

impl Computer {
    pub(crate) async fn new(home: &Path, links: &Arc<Links>, clock: Arc<dyn Clock>) -> Self {
        Self::over(home, links, clock, None).await
    }

    /// With `local` standing in for this computer's disk.
    pub(crate) async fn over(
        home: &Path,
        links: &Arc<Links>,
        clock: Arc<dyn Clock>,
        local: Option<Arc<dyn TransferEndpoint>>,
    ) -> Self {
        std::fs::create_dir_all(home).unwrap();
        let home = std::fs::canonicalize(home).unwrap();
        let keys = Arc::new(Keys::default());
        // The seeded rows put the focused chat `w-CHAT` in `<home>/alpha`.
        let store = TempStore::seeded(&s(&home));
        let ids = Arc::new(SeqIds::new());
        let kernel = Kernel::new(KernelOptions { clock: clock.clone(), ids: ids.clone(), ..KernelOptions::default() });
        let local = local.unwrap_or_else(|| disk(&home, &keys, &clock));
        let module = Arc::new(TransferModule::new(
            TransferServiceDeps {
                store: store.port(),
                local,
                machines: links.clone(),
                bus: kernel.bus.clone(),
                clock,
                ids,
                sleeper: Arc::new(NoWait),
            },
            kernel.jobs.clone(),
        ));
        let rang = Arc::new(Notify::new());
        let banners = Arc::new(Mutex::new(Vec::new()));
        let heard = vec![
            kernel.bus.on(Filter::All, {
                let rang = rang.clone();
                move |_| rang.notify_waiters()
            }),
            kernel.bus.on("notification:fire", {
                let banners = banners.clone();
                move |event| banners.lock().unwrap().push(event.payload_as().unwrap())
            }),
        ];
        let runtime = Runtime::build(kernel.clone(), vec![module.clone()], Arc::new(AllPluginsOn)).unwrap();
        module.start().await.unwrap();
        let service = module.service();
        Self { home, keys, store, kernel, module, service, runtime, banners, rang, _heard: heard }
    }

    pub(crate) fn router(&self) -> Arc<Router> {
        self.runtime.router.clone()
    }

    /// Waits until the transfer is at `status`, looking again at every
    /// announcement. Panics after ten seconds.
    pub(crate) async fn until(&self, id: &str, status: TransferStatus) -> TransferRecord {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let heard = self.rang.notified();
            tokio::pin!(heard);
            heard.as_mut().enable();
            let t = self.service.get(id).await.unwrap();
            if t.status == status {
                return t;
            }
            if tokio::time::timeout_at(deadline, heard).await.is_err() {
                panic!("stuck at {:?} ({:?}), wanted {status:?}", t.status, t.error);
            }
        }
    }

    pub(crate) fn banner_titles(&self) -> Vec<String> {
        self.banners.lock().unwrap().iter().map(|b| b["title"].as_str().unwrap_or_default().to_owned()).collect()
    }
}

/// "Here" (with `there` paired as "Office") and "there".
pub(crate) struct Pair {
    pub(crate) _tmp: tempfile::TempDir,
    pub(crate) links: Arc<Links>,
    pub(crate) here: Computer,
    pub(crate) there: Computer,
}

pub(crate) async fn pair() -> Pair {
    pair_with(vec![host(HOST, "Office", "live")], TestClock::real()).await
}

pub(crate) async fn pair_with(hosts: Vec<HostView>, clock: Arc<dyn Clock>) -> Pair {
    let tmp = tempfile::tempdir().unwrap();
    let links = Links::new(hosts);
    let there = Computer::new(&tmp.path().join("there"), &alone(), TestClock::real()).await;
    links.routers.lock().unwrap().insert(HOST.to_owned(), there.router());
    links.homes.lock().unwrap().insert(HOST.to_owned(), s(&there.home));
    let here = Computer::new(&tmp.path().join("here"), &links, clock).await;
    std::fs::create_dir_all(there.home.join("neon/builds")).unwrap();
    Pair { _tmp: tmp, links, here, there }
}
