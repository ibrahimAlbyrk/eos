//! `POST /workers/:id/btw` over the real store, the session service and a
//! scripted runtime (`core/src/__tests__/AskSideQuestion.test.ts`).

use std::sync::Arc;

use eos_core::agent::AgentCapabilities;
use eos_mod_btw::BtwModule;
use eos_runtime::access::Caller;
use eos_runtime::http::{Method, Request};
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_sessions::{NoHooks, SessionDeps, Sessions};
use eos_testkit::agent::{Call, claude_capabilities};
use eos_testkit::{
    FakeClock, FakeConfig, FakeModelCatalog, FakePrompts, FakeRecents, FakeWorktrees, ScriptedRuntime, SeqIds,
    TempStore,
};
use serde_json::{Value, json};

struct Bench {
    runtime: Runtime,
    agents: ScriptedRuntime,
    temp: TempStore,
}

impl Bench {
    /// On the wire fixtures' rows: `w-CHAT` is a chat at rest that can be
    /// continued, `w-BARE` a finished one.
    fn new(capabilities: AgentCapabilities) -> Self {
        let temp = TempStore::seeded("/sandbox");
        let agents = ScriptedRuntime::with_capabilities(capabilities);
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
            sleeper: Arc::new(eos_testkit::FakeSleeper::default()),
        });
        let module = Arc::new(BtwModule::new(temp.port(), Arc::new(sessions)));
        let runtime = Runtime::build(Kernel::new(KernelOptions::default()), vec![module], Arc::new(AllPluginsOn))
            .expect("composes");
        assert_eq!(runtime.router.undeclared(), Vec::<String>::new());
        Self { runtime, agents, temp }
    }

    async fn ask(&self, caller: Caller, worker: &str, body: Value) -> (u16, Value) {
        let req = Request::new(Method::Post, &format!("/workers/{worker}/btw"), caller)
            .body(serde_json::to_vec(&body).expect("json"));
        let response = self.runtime.router.handle(req).await;
        let status = response.status;
        let bytes = response.body.collect().await.expect("a body");
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    fn asked(&self) -> Vec<String> {
        let calls = self.agents.calls();
        calls
            .into_iter()
            .filter_map(|c| match c {
                Call::AskSide { question, .. } => Some(question),
                _ => None,
            })
            .collect()
    }

    fn rows(&self, worker: &'static str) -> usize {
        let count = self.temp.store.read_blocking(move |tx| {
            tx.events().list(&eos_core::store::EventQuery {
                worker_id: worker.into(),
                since: 0,
                limit: 5000,
                order: eos_core::store::EventOrder::Asc,
                before_id: None,
                after_id: None,
            })
        });
        count.expect("reads").len()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_chat_at_rest_is_revived_and_answers_the_trimmed_question_leaving_no_trace() {
    let bench = Bench::new(claude_capabilities());
    let (status, body) = bench.ask(Caller::DASHBOARD, "w-CHAT", json!({"question": "  why?  "})).await;
    assert_eq!((status, body), (200, json!({"answer": "side answer to: why?"})));
    assert_eq!(bench.asked(), ["why?"]);
    assert_eq!(bench.agents.started().len(), 1, "its session was brought back, as a message would");
    assert!(bench.agents.sent("w-CHAT").is_empty(), "no turn was started");

    // A live chat is asked as it is; the question itself writes nothing.
    let (rows, announced) = (bench.rows("w-CHAT"), bench.temp.announced.list().len());
    let (status, _) = bench.ask(Caller::DASHBOARD, "w-CHAT", json!({"question": "and now?"})).await;
    assert_eq!(status, 200);
    assert_eq!(bench.agents.started().len(), 1);
    assert_eq!((bench.rows("w-CHAT"), bench.temp.announced.list().len()), (rows, announced));
}

#[tokio::test(flavor = "multi_thread")]
async fn only_the_users_dashboard_asks_and_a_question_must_say_something() {
    let bench = Bench::new(claude_capabilities());
    let (status, body) = bench.ask(Caller::UNTRUSTED, "w-CHAT", json!({"question": "what changed?"})).await;
    assert_eq!((status, body), (403, json!({"error": "ui token required"})));
    let (status, _) = bench.ask(Caller::DASHBOARD, "w-CHAT", json!({})).await;
    assert_eq!(status, 400);
    let (status, _) = bench.ask(Caller::DASHBOARD, "w-CHAT", json!({"question": "   "})).await;
    assert_eq!(status, 400);
    let (status, body) = bench.ask(Caller::DASHBOARD, "w-nope0000", json!({"question": "what changed?"})).await;
    assert_eq!((status, body), (404, json!({"error": "worker not found: w-nope0000"})));
    assert!(bench.agents.started().is_empty() && bench.asked().is_empty(), "nothing was revived");
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_an_archived_chat_one_that_cannot_answer_and_one_that_stays_down() {
    let bench = Bench::new(claude_capabilities());
    bench.temp.exec("UPDATE workers SET archived_at = 5 WHERE id = 'w-CHAT'");
    let (status, body) = bench.ask(Caller::DASHBOARD, "w-CHAT", json!({"question": "q"})).await;
    assert_eq!((status, body), (409, json!({"error": "worker is archived — restore first"})));
    // No recorded session to continue: it stays down.
    bench.temp.exec("UPDATE workers SET session_id = NULL WHERE id = 'w-BARE'");
    let (status, body) = bench.ask(Caller::DASHBOARD, "w-BARE", json!({"question": "q"})).await;
    assert_eq!((status, body), (409, json!({"error": "the agent isn't running"})));
    assert!(bench.agents.started().is_empty());

    let mut mute = claude_capabilities();
    mute.side_question = None;
    let bench = Bench::new(mute);
    let (status, body) = bench.ask(Caller::DASHBOARD, "w-CHAT", json!({"question": "q"})).await;
    assert_eq!((status, body), (409, json!({"error": "this agent can't answer side questions"})));
    assert!(bench.agents.started().is_empty(), "not revived for a question it cannot take");
}
