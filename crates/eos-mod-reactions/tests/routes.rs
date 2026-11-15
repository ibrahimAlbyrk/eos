//! `/workers/:id/reactions` over the real store, the session service and a
//! scripted runtime, on the wire fixtures' rows: `w-CHAT` is a focused chat at
//! rest with a full transcript, `w-KID1` a worker of an orchestrator.

use std::sync::Arc;

use eos_mod_reactions::ReactionsModule;
use eos_runtime::access::Caller;
use eos_runtime::http::{Method, Request};
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_sessions::{NoHooks, SessionDeps, Sessions};
use eos_testkit::{
    FakeClock, FakeConfig, FakeModelCatalog, FakePrompts, FakeRecents, FakeSleeper, FakeWorktrees, ScriptedRuntime,
    SeqIds, TempStore, Turn,
};
use serde_json::{Value, json};

struct Bench {
    runtime: Runtime,
    agents: ScriptedRuntime,
    temp: TempStore,
    sleeper: Arc<FakeSleeper>,
}

impl Bench {
    fn new() -> Self {
        let temp = TempStore::seeded("/sandbox");
        let agents = ScriptedRuntime::new();
        let sleeper = Arc::new(FakeSleeper::default());
        let sessions = Sessions::new(SessionDeps {
            store: temp.port(),
            runtime: agents.port(),
            clock: Arc::new(FakeClock::new()),
            ids: Arc::new(SeqIds::new()),
            config: Arc::new(FakeConfig::default()),
            models: Arc::new(FakeModelCatalog::default()),
            prompts: Arc::new(FakePrompts::default()),
            worktrees: Arc::new(FakeWorktrees::default()),
            recents: Arc::new(FakeRecents::default()),
            hooks: Arc::new(NoHooks),
            sleeper: sleeper.clone(),
        });
        let module = Arc::new(ReactionsModule::new(sessions));
        let runtime = Runtime::build(Kernel::new(KernelOptions::default()), vec![module], Arc::new(AllPluginsOn))
            .expect("composes");
        assert_eq!(runtime.router.undeclared(), Vec::<String>::new());
        Self { runtime, agents, temp, sleeper }
    }

    async fn call(&self, caller: Caller, method: Method, path: &str, body: Option<Value>) -> (u16, Value) {
        let mut req = Request::new(method, path, caller);
        if let Some(body) = body {
            req = req.body(serde_json::to_vec(&body).expect("json"));
        }
        let response = self.runtime.router.handle(req).await;
        let status = response.status;
        let bytes = response.body.collect().await.expect("a body");
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    async fn put(&self, worker: &str, row: i64, emoji: &str) -> (u16, Value) {
        let path = format!("/workers/{worker}/reactions/{row}");
        self.call(Caller::DASHBOARD, Method::Put, &path, Some(json!({"emoji": emoji}))).await
    }

    async fn list(&self, worker: &str, query: &str) -> (u16, Value) {
        self.call(Caller::DASHBOARD, Method::Get, &format!("/workers/{worker}/reactions{query}"), None).await
    }

    /// The row of a worker's first or last message of a kind.
    fn row(&self, worker: &str, kind: &str, last: bool) -> i64 {
        let order = if last { "DESC" } else { "ASC" };
        let text = if kind == "agent_event" { "AND payload LIKE '%\"type\":\"text\"%'" } else { "" };
        self.temp.count(&format!(
            "SELECT id FROM events WHERE worker_id = '{worker}' AND type = '{kind}' {text} ORDER BY id {order} LIMIT 1"
        ))
    }

    fn announced(&self) -> Vec<Value> {
        let all = self.temp.announced.list();
        all.into_iter()
            .filter(|(topic, _)| *topic == "reactions:change")
            .map(|(_, payload)| serde_json::from_str(&payload).expect("json"))
            .collect()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_user_reacts_changes_their_mind_and_takes_it_back() {
    let bench = Bench::new();
    let (typed, said) = (bench.row("w-CHAT", "user_message", false), bench.row("w-CHAT", "agent_event", false));

    let (status, set) = bench.put("w-CHAT", typed, "📌").await;
    assert_eq!(status, 200);
    let at = set["at"].clone();
    assert_eq!(set, json!({"rowId": typed, "actor": "user", "emoji": "📌", "at": at, "seen": false}));
    let (_, again) = bench.put("w-CHAT", typed, "✅").await;
    assert_eq!(again["emoji"], "✅", "one emoji a message: the later replaces the earlier");
    let (status, _) = bench.put("w-CHAT", said, "❤️").await;
    assert_eq!(status, 200);

    let (status, all) = bench.list("w-CHAT", "").await;
    assert_eq!(status, 200);
    let brief = |list: &Value| -> Vec<(i64, String)> {
        let rows = list["reactions"].as_array().expect("a list");
        rows.iter()
            .map(|r| (r["rowId"].as_i64().expect("a row"), r["emoji"].as_str().expect("emoji").to_owned()))
            .collect()
    };
    let mut expected = vec![(typed, "✅".to_owned()), (said, "❤️".to_owned())];
    expected.sort();
    assert_eq!(brief(&all), expected, "by row");
    let (_, window) = bench.list("w-CHAT", &format!("?fromId={said}&toId={said}")).await;
    assert_eq!(brief(&window), [(said, "❤️".to_owned())], "only the rows a client holds");

    let path = format!("/workers/w-CHAT/reactions/{typed}");
    assert_eq!(bench.call(Caller::DASHBOARD, Method::Delete, &path, None).await, (200, json!({"removed": true})));
    assert_eq!(bench.call(Caller::DASHBOARD, Method::Delete, &path, None).await, (200, json!({"removed": false})));
    assert_eq!(brief(&bench.list("w-CHAT", "").await.1), [(said, "❤️".to_owned())]);

    let frames = bench.announced();
    let told: Vec<(i64, &Value)> = frames.iter().map(|f| (f["rowId"].as_i64().expect("a row"), &f["emoji"])).collect();
    assert_eq!(
        told,
        [(typed, &json!("📌")), (typed, &json!("✅")), (said, &json!("❤️")), (typed, &Value::Null)],
        "each change once, a removal as null"
    );
    assert!(frames.iter().all(|f| f["workerId"] == "w-CHAT" && f["actor"] == "user" && f["seen"] == false));
    assert!(bench.agents.sent("w-CHAT").is_empty(), "none of them is on the agent's latest message");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_reaction_on_the_agents_last_words_says_when_it_wakes_the_agent() {
    let bench = Bench::new();
    // The agent's latest message of the seeded chat, with nothing of the user's after it.
    let last = bench.row("w-CHAT", "agent_event", true);
    bench.temp.exec(&format!("DELETE FROM events WHERE worker_id = 'w-CHAT' AND id > {last}"));
    let (status, set) = bench.put("w-CHAT", last, "👍").await;
    assert_eq!((status, &set["wakesInMs"]), (200, &json!(2000)), "{set}");

    bench.agents.script(Turn::reply("On it."));
    for _ in 0..5_000 {
        if bench.sleeper.pending().contains(&2000) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    }
    assert!(bench.sleeper.wake(), "the reaction's timer");
    for _ in 0..5_000 {
        if !bench.agents.sent("w-CHAT").is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    }
    let sent = bench.agents.sent("w-CHAT");
    assert_eq!(sent.len(), 1, "the chat at rest came back for it");
    assert!(sent[0].starts_with("<reaction emoji=\"👍\" on=\"yours\">"), "{}", sent[0]);
    bench.agents.settled().await;
    let seen = bench.announced().into_iter().any(|f| f["rowId"] == last && f["seen"] == true);
    assert!(seen, "the dashboard hears that the agent was told");
}

#[tokio::test(flavor = "multi_thread")]
async fn what_cannot_take_a_reaction_is_refused_in_words() {
    let bench = Bench::new();
    let typed = bench.row("w-CHAT", "user_message", false);
    let state = bench.row("w-CHAT", "state", false);
    assert_eq!(bench.put("w-CHAT", typed, "nice").await, (400, json!({"error": "a reaction is one emoji"})));
    assert_eq!(bench.put("w-CHAT", typed, "").await.0, 400);
    let no_body = bench.call(Caller::DASHBOARD, Method::Put, &format!("/workers/w-CHAT/reactions/{typed}"), None).await;
    assert_eq!(no_body.0, 400);
    assert_eq!(bench.put("w-CHAT", state, "👍").await, (409, json!({"error": "this message can't take a reaction"})));
    assert_eq!(bench.put("w-CHAT", 999_999, "👍").await, (404, json!({"error": "message not found: 999999"})));
    assert_eq!(bench.put("w-CHAT", 0, "👍").await.0, 404);
    assert_eq!(bench.put("w-nope0000", typed, "👍").await, (404, json!({"error": "worker not found: w-nope0000"})));
    // A message of another chat is not this chat's.
    let other = bench.row("o-ORCH", "user_message", false);
    assert_eq!(bench.put("w-CHAT", other, "👍").await.0, 404);
    // A worker answers to its orchestrator; an archived chat is restored first.
    let reported = bench.row("w-KID1", "agent_event", false);
    assert_eq!(bench.put("w-KID1", reported, "👍").await, (409, json!({"error": "this chat takes no reactions"})));
    let archived = bench.temp.count("SELECT id FROM events WHERE worker_id = 'w-ARCH' ORDER BY id LIMIT 1");
    assert_eq!(bench.put("w-ARCH", archived, "👍").await.0, 409);
    assert_eq!(bench.list("w-nope0000", "").await.0, 404);
    assert_eq!(bench.list("w-CHAT", "?fromId=abc").await.0, 400);

    // Only the user's own dashboard leaves a reaction; any page of the window may read them.
    let path = format!("/workers/w-CHAT/reactions/{typed}");
    let refused = bench.call(Caller::UNTRUSTED, Method::Put, &path, Some(json!({"emoji": "👍"}))).await;
    assert_eq!(refused, (403, json!({"error": "ui token required"})));
    assert_eq!(bench.call(Caller::UNTRUSTED, Method::Delete, &path, None).await.0, 403);
    assert_eq!(bench.call(Caller::UNTRUSTED, Method::Get, "/workers/w-CHAT/reactions", None).await.0, 200);
    assert!(bench.announced().is_empty() && bench.sleeper.pending().is_empty(), "nothing was written");
}
