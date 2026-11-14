//! The routes over the seeded store: what the recorded scenario does not reach.

use std::sync::Arc;
use std::time::Duration;

use eos_contracts::stream::topics;
use eos_core::store::{Announcement, Announcer};
use eos_core::{RandomIds, SystemClock};
use eos_kit_sqlite::Db;
use eos_mod_policy::PolicyModule;
use eos_policy::{GatewayOptions, PolicyGateway};
use eos_runtime::access::Caller;
use eos_runtime::bus::Bus;
use eos_runtime::http::{Method, Request};
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_store_sqlite::{SqliteStore, StoreOptions};
use eos_testkit::{FakePolicyFile, TempHome, fixtures};
use serde_json::{Value, json};

/// Hands committed writes' events to the bus, as the app does.
struct BusAnnouncer(Bus);

impl Announcer for BusAnnouncer {
    fn announce(&self, events: Vec<Announcement>) {
        for event in events {
            self.0.publish_raw(event.topic, None, event.payload.into());
        }
    }
}

struct App {
    runtime: Runtime,
    gateway: Arc<PolicyGateway>,
    _home: TempHome,
}

/// The seeded rows under a policy that asks about the shell.
async fn app() -> App {
    let home = TempHome::new();
    let kernel = Kernel::new(KernelOptions::default());
    let (db, _) = Db::open(home.paths().state_db(), eos_kit_sqlite::Options::default(), 0).expect("a database");
    let store = Arc::new(SqliteStore::new(db, Arc::new(BusAnnouncer(kernel.bus.clone())), StoreOptions::default()));
    let seed = fixtures::seed_sql("/sandbox");
    store
        .db()
        .maintain(move |conn| conn.execute_batch(&seed).map_err(eos_kit_sqlite::Error::from))
        .expect("the seed rows");
    let gateway = Arc::new(PolicyGateway::new(GatewayOptions {
        store: store.clone(),
        clock: Arc::new(SystemClock),
        ids: Arc::new(RandomIds),
        file: Arc::new(FakePolicyFile::holding(
            json!({"default": "ask", "rules": [{"tool": "Bash", "action": "ask"}]}),
        )),
        default_ttl_ms: 0,
        plans_dir: None,
    }));
    let module = Arc::new(PolicyModule::new(gateway.clone(), store, kernel.bus.clone()));
    let runtime = Runtime::build(kernel, vec![module], Arc::new(AllPluginsOn)).expect("composes");
    runtime.lifecycle.start().await.expect("starts");
    App { runtime, gateway, _home: home }
}

async fn get(app: &App, target: &str) -> (u16, Value) {
    let res = app.runtime.router.handle(Request::new(Method::Get, target, Caller::DASHBOARD)).await;
    let body = res.body.collect().await.expect("a body");
    (res.status, serde_json::from_slice(&body).expect("json"))
}

fn decide(app: &App, worker: &str) -> tokio::task::JoinHandle<(u16, Value)> {
    let router = app.runtime.router.clone();
    let body = json!({"worker_id": worker, "tool_name": "Bash", "input": {"command": "ls"}}).to_string();
    tokio::spawn(async move {
        let res = router.handle(Request::new(Method::Post, "/policy/decide", Caller::UNTRUSTED).body(body)).await;
        let body = res.body.collect().await.expect("a body");
        (res.status, serde_json::from_slice(&body).expect("json"))
    })
}

async fn waiting(app: &App, n: usize) {
    let mut created = app.runtime.kernel.bus.subscribe(topics::PENDING_CREATED, 16);
    while app.gateway.waiting() < n {
        let _ = tokio::time::timeout(Duration::from_millis(50), created.recv()).await;
    }
    app.runtime.kernel.bus.flush().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_lists_the_asks_of_its_direct_children() {
    let app = app().await;
    let (kid, chat) = (decide(&app, "w-KID1"), decide(&app, "w-LONG"));
    waiting(&app, 2).await;

    let (status, all) = get(&app, "/pending").await;
    let workers = |rows: &Value| -> Vec<String> {
        rows.as_array().expect("rows").iter().map(|r| r["worker_id"].as_str().expect("an id").to_owned()).collect()
    };
    assert_eq!(status, 200);
    assert_eq!(workers(&all).len(), 3, "the seeded ask and the two new ones");

    let (status, of_orchestrator) = get(&app, "/pending?parentId=o-ORCH").await;
    assert_eq!((status, workers(&of_orchestrator)), (200, vec!["w-KID1".to_owned()]));
    assert_eq!(of_orchestrator[0]["input"], r#"{"command":"ls"}"#, "the input stays a JSON string");
    let (_, of_nobody) = get(&app, "/pending?parentId=w-nope").await;
    assert_eq!(of_nobody, json!([]));
    let (_, unfiltered) = get(&app, "/pending?parentId=").await;
    assert_eq!(workers(&unfiltered).len(), 3, "an empty parent is no filter");

    // A worker that exits releases its own call; the other keeps waiting.
    app.runtime.kernel.bus.publish_raw(topics::WORKER_EXIT, None, r#"{"workerId":"w-KID1","code":0}"#.into());
    let (status, answer) = tokio::time::timeout(Duration::from_secs(5), kid).await.expect("released").expect("joins");
    assert_eq!(status, 200);
    assert_eq!(answer, json!({"behavior": "deny", "message": "worker exited before permission was resolved"}));
    assert!(!chat.is_finished());
    chat.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn only_local_callers_decide_and_the_phone_reads_the_list() {
    let app = app().await;
    let router = &app.runtime.router;
    let peer = Caller::Peer { device: "abc".into(), human: true };
    let body = json!({"worker_id": "w-LONG", "tool_name": "Read", "input": {}}).to_string();
    let refused = router.handle(Request::new(Method::Post, "/policy/decide", peer).body(body.clone())).await;
    assert_eq!(refused.status, 403, "a paired computer never decides for this one");
    let phone = Caller::Phone { grant: eos_runtime::access::Tier::Read, mutate: false };
    let refused = router.handle(Request::new(Method::Post, "/policy/decide", phone.clone()).body(body)).await;
    assert_eq!(refused.status, 403);
    assert_eq!(router.handle(Request::new(Method::Get, "/pending", phone.clone())).await.status, 200);
    let answer = Request::new(Method::Post, "/pending/p-SEED1/decision", phone).body(r#"{"decision":"allow"}"#);
    assert_eq!(router.handle(answer).await.status, 403, "answering an ask needs the high tier");
}
