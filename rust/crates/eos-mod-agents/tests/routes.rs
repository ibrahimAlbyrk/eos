//! The routes over the real store, with scripted agents: what a client
//! gets back, what is written and what is announced.

use std::sync::Arc;

use eos_core::agent::AgentRuntime;
use eos_core::store::{EventOrder, EventQuery, Store};
use eos_mod_agents::AgentsModule;
use eos_runtime::access::Caller;
use eos_runtime::http::{Method, Request};
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_sessions::{NoHooks, SessionDeps, Sessions};
use eos_store_files::worker_definitions::FsWorkerDefinitionFiles;
use eos_testkit::{
    FakeClock, FakeConfig, FakeModelCatalog, FakePrompts, FakeRecents, FakeWorktrees, ScriptedRuntime, SeqIds,
    TempStore, Turn,
};
use eos_workers::WorkerDefinitions;
use serde_json::{Value, json};

struct Bench {
    runtime: Runtime,
    agents: ScriptedRuntime,
    temp: TempStore,
}

impl Bench {
    fn new(temp: TempStore) -> Self {
        let agents = ScriptedRuntime::new();
        let clock = Arc::new(FakeClock::new());
        let ids = Arc::new(SeqIds::new());
        let sessions = Sessions::new(SessionDeps {
            store: temp.port(),
            runtime: agents.port(),
            clock: clock.clone(),
            ids: ids.clone(),
            config: Arc::new(FakeConfig::default()),
            models: Arc::new(FakeModelCatalog::default()),
            prompts: Arc::new(FakePrompts::default()),
            worktrees: Arc::new(FakeWorktrees::default()),
            recents: Arc::new(FakeRecents::default()),
            hooks: Arc::new(NoHooks),
        });
        let files = Arc::new(FsWorkerDefinitionFiles::new(temp.home.path().join("workers")));
        let definitions = Arc::new(WorkerDefinitions::new(files, temp.port(), clock));
        let module = Arc::new(AgentsModule::new(sessions, temp.port(), ids, definitions));
        let runtime = Runtime::build(Kernel::new(KernelOptions::default()), vec![module], Arc::new(AllPluginsOn))
            .expect("composes");
        Self { runtime, agents, temp }
    }

    async fn call(&self, method: Method, target: &str, body: Option<Value>) -> (u16, Value) {
        let mut request = Request::new(method, target, Caller::DASHBOARD);
        if let Some(body) = body {
            request = request.header("content-type", "application/json").body(body.to_string());
        }
        let res = self.runtime.router.handle(request).await;
        let status = res.status;
        let bytes = res.body.collect().await.expect("a body");
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    async fn post(&self, target: &str, body: Value) -> (u16, Value) {
        self.call(Method::Post, target, Some(body)).await
    }

    async fn kinds(&self, worker: &str) -> Vec<String> {
        let store: Arc<dyn Store> = self.temp.port();
        let query = EventQuery {
            worker_id: worker.into(),
            since: 0,
            limit: 5000,
            order: EventOrder::Asc,
            before_id: None,
            after_id: None,
        };
        store.read(move |tx| tx.events().list(&query)).await.expect("reads").into_iter().map(|r| r.kind).collect()
    }

    async fn state(&self, worker: &str) -> Option<String> {
        let (store, id): (Arc<dyn Store>, String) = (self.temp.port(), worker.into());
        let row = store.read(move |tx| tx.workers().find(&id)).await.expect("reads");
        row.map(|w| eos_domain::worker::state_name(w.state).to_owned())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_chat_is_created_talked_to_interrupted_and_removed() {
    let bench = Bench::new(TempStore::new());
    bench.agents.script(Turn::reply("hello!"));
    let created = bench
        .post("/orchestrators", json!({"mode": "focused", "cwd": "/sandbox/alpha", "prompt": "  Say   hello to me  "}))
        .await;
    assert_eq!(created, (201, json!({"id": "w-00000001", "port": 0, "bootMsgId": 1, "name": "Say hello to me"})));
    bench.agents.settled().await;
    let kinds = bench.kinds("w-00000001").await;
    assert_eq!(kinds[..2], ["spawn", "user_message"], "the prompt is the chat's first message: {kinds:?}");
    assert_eq!(bench.state("w-00000001").await.as_deref(), Some("IDLE"));
    let started = &bench.agents.started()[0];
    assert!(started.is_focused() && started.model != "high", "a tier becomes its model: {}", started.model);

    // A message while idle is delivered; one for a busy chat waits when asked to.
    let gate = bench.agents.script_held(Turn::reply("working"));
    let sent = bench.post("/workers/w-00000001/message", json!({"text": "next", "clientMsgId": "c-1"})).await;
    assert_eq!(sent, (200, json!({"ok": true})));
    bench.agents.running(1).await;
    let again = bench.post("/workers/w-00000001/message", json!({"text": "next", "clientMsgId": "c-1"})).await;
    assert_eq!(again, (200, json!({"ok": true, "deduped": true})));
    let queued = bench.post("/workers/w-00000001/message", json!({"text": "later", "queueWhenBusy": true})).await;
    assert_eq!(queued.0, 202);
    let queue_id = queued.1["queueId"].as_i64().expect("a queue id");
    assert_eq!(queued.1, json!({"ok": true, "queued": true, "queueId": queue_id}));
    let unqueued = bench.call(Method::Delete, &format!("/workers/w-00000001/queue/{queue_id}"), None).await;
    assert_eq!(unqueued, (200, json!({"ok": true})));
    let gone = bench.call(Method::Delete, &format!("/workers/w-00000001/queue/{queue_id}"), None).await;
    assert_eq!(gone, (404, json!({"ok": false})));

    let interrupted = bench.post("/workers/w-00000001/interrupt", json!({})).await;
    assert_eq!(interrupted, (200, json!({"ok": true})));
    bench.agents.settled().await;
    assert_eq!(bench.state("w-00000001").await.as_deref(), Some("IDLE"));
    drop(gate);

    let targets = bench.call(Method::Get, "/workers/w-00000001/rewind-targets", None).await;
    assert_eq!(targets.0, 200);
    let first = targets.1["targets"][0]["uuid"].as_str().expect("a target").to_owned();
    let back = bench.post("/workers/w-00000001/rewind", json!({"uuid": first})).await;
    assert_eq!((back.0, back.1["ok"].as_bool(), back.1["index"].as_i64()), (200, Some(true), Some(0)));
    assert_eq!(bench.kinds("w-00000001").await.last().map(String::as_str), Some("conversation_rewound"));

    let removed = bench.call(Method::Delete, "/workers/w-00000001", None).await;
    assert_eq!(removed.0, 200);
    assert_eq!(removed.1["removed"], true);
    assert_eq!(removed.1["name"], "Say hello to me");
    assert_eq!(bench.state("w-00000001").await, None);
    assert_eq!(bench.agents.live(), 0);
    assert!(bench.temp.announced.topics().contains(&"worker:removed"));

    // What is not ported answers so, never a made-up success.
    let scratch = bench.post("/orchestrators", json!({"mode": "focused", "scratch": true})).await;
    assert_eq!(scratch.0, 501);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_chat_at_rest_is_continued_by_the_first_message_to_it() {
    // The seeded chats are at rest, as the app finds them at start-up.
    let bench = Bench::new(TempStore::seeded("/"));
    assert_eq!(bench.state("w-CHAT").await.as_deref(), Some("SUSPENDED"));
    bench.agents.script(Turn::reply("back again"));
    let sent = bench.post("/workers/w-CHAT/message", json!({"text": "are you there?"})).await;
    assert_eq!(sent, (200, json!({"ok": true})));
    bench.agents.settled().await;
    assert_eq!(bench.state("w-CHAT").await.as_deref(), Some("IDLE"));
    let resumed = bench.agents.started().pop().expect("a start");
    assert_eq!(
        resumed.resume.as_deref(),
        Some("11111111-1111-4111-8111-111111111111"),
        "the old conversation continues"
    );
    assert!(bench.agents.sent("w-CHAT")[0].ends_with("are you there?"));

    // A parent's directive: wrapped, queued while its worker is busy, answered with the worker's name.
    let directive = bench.post("/workers/w-KID2/message", json!({"text": "status?", "fromParent": "o-ORCH"})).await;
    assert_eq!(directive, (200, json!({"ok": true, "id": "w-KID2", "name": directive.1["name"].clone()})));
    bench.agents.settled().await;
    assert!(bench.agents.sent("w-KID2")[0].starts_with("<agent_message from="), "{:?}", bench.agents.sent("w-KID2"));
    let stranger = bench.post("/workers/w-CHAT/message", json!({"text": "hi", "fromParent": "o-ORCH"})).await;
    assert_eq!(stranger.0, 403);

    let resume = bench.post("/workers/o-ORCH/resume", json!({})).await;
    assert_eq!(resume, (200, json!({"id": "o-ORCH", "port": 0})));
    assert_eq!(bench.post("/workers/o-ORCH/resume", json!({})).await.0, 409, "it is running now");
    let no_session = bench.post("/workers/w-BARE/resume", json!({})).await;
    assert_eq!(no_session, (409, json!({"error": "worker has no recorded session to resume"})));
    let not_orchestrator = bench.post("/orchestrators/w-BARE/message", json!({"text": "hi"})).await;
    assert_eq!(not_orchestrator, (404, json!({"error": "orchestrator not found: w-BARE"})));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_worker_is_spawned_from_its_definition() {
    let bench = Bench::new(TempStore::seeded("/"));
    let unknown = bench.post("/workers", json!({"prompt": "go", "cwd": "/", "from": "no-such-type"})).await;
    assert_eq!(unknown, (400, json!({"error": "unknown worker definition: no-such-type"})));
    let empty = bench.post("/workers", json!({"cwd": "/"})).await;
    assert_eq!(empty, (400, json!({"error": "invalid request: : prompt or promptTemplate required"})));

    // The user's own definition: its model, its mode and its tool scope are the worker's.
    let dir = bench.temp.home.path().join("workers");
    std::fs::create_dir_all(&dir).expect("a folder");
    let definition = "---\nname: reader\ndescription: Reads.\nmodel: haiku\npermissionMode: acceptEdits\ntoolsDeny: [Bash]\n---\nOnly read.\n";
    std::fs::write(dir.join("reader.md"), definition).expect("a definition");
    bench.agents.script(Turn::reply("read it"));
    let spawned = bench
        .post(
            "/workers",
            json!({"prompt": "look around", "cwd": "/", "from": "reader", "parentId": "o-ORCH", "name": "scout"}),
        )
        .await;
    assert_eq!(spawned.0, 201, "{}", spawned.1);
    assert_eq!(spawned.1["isolation"], "cwd");
    let id = spawned.1["id"].as_str().expect("an id").to_owned();
    bench.agents.settled().await;
    let store: Arc<dyn Store> = bench.temp.port();
    let wanted = id.clone();
    let row = store.read(move |tx| tx.workers().find(&wanted)).await.expect("reads").expect("the row");
    assert_eq!(row.worker_definition.as_deref(), Some("reader"));
    assert_eq!(row.permission_mode.as_deref(), Some("acceptEdits"));
    assert_eq!(row.parent_id.as_deref(), Some("o-ORCH"));
    assert!(row.tool_scope.as_deref().is_some_and(|scope| scope.contains("Bash")), "{:?}", row.tool_scope);
    let started = bench.agents.started().pop().expect("a start");
    assert!(started.model.contains("haiku"), "{}", started.model);
    assert!(started.prompt.as_deref().is_some_and(|p| p.starts_with("<agent_message ")), "its parent's directive");
    assert!(
        !bench.kinds(&id).await.contains(&"user_message".to_owned()),
        "an agent's directive is not the user's message"
    );
}
