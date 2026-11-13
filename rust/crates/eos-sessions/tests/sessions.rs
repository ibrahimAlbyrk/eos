//! The session use-cases end to end over the real store and a scripted
//! runtime: what is written, in which order, and what is announced.
//! (`core/src/__tests__/SpawnWorker.*.test.ts`, `DispatchMessage.test.ts`,
//! `DrainQueuedMessages.test.ts`, `ProcessAgentSignal.test.ts`,
//! `ResumeWorker.test.ts`, `RecallPendingTurn.test.ts`, `SetWorkerModel.test.ts`.)

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use eos_contracts::{PermissionMode, WorkerState};
use eos_core::Error;
use eos_core::agent::AgentRuntime;
use eos_core::store::{EventOrder, EventQuery, Store};
use eos_domain::Worker;
use eos_domain::envelope::Envelope;
use eos_sessions::{CommandAnswer, Dispatched, MessageInput, SessionDeps, SessionHooks, Sessions, SpawnRequest};
use eos_testkit::agent::Call;
use eos_testkit::{
    FakeClock, FakeConfig, FakeModelCatalog, FakePrompts, FakeRecents, FakeSleeper, FakeWorktrees, ScriptedRuntime,
    SeqIds, TempStore, Turn,
};
use serde_json::Value;

#[derive(Default)]
struct Hooks {
    idle: AtomicUsize,
    deltas: AtomicUsize,
    held: std::sync::Mutex<Vec<String>>,
    removed: std::sync::Mutex<Vec<String>>,
    missing_folders: std::sync::Mutex<Vec<String>>,
    /// The service, so a hook can stand for a turn that ends at that very moment.
    sessions: std::sync::OnceLock<Sessions>,
    /// How many more idle edges arrive while a queue is being drained.
    edges_mid_drain: std::sync::Mutex<usize>,
    drains: AtomicUsize,
}

impl SessionHooks for Hooks {
    fn delta(&self, _worker_id: &str, _delta: &eos_contracts::DeltaEvent) {
        self.deltas.fetch_add(1, Ordering::SeqCst);
    }

    fn holds_worker(&self, worker_id: &str) -> bool {
        // Asked once per drain, while the drain has the worker.
        self.drains.fetch_add(1, Ordering::SeqCst);
        let arrives = {
            let mut left = self.edges_mid_drain.lock().expect("edges");
            let arrives = *left > 0;
            *left = left.saturating_sub(1);
            arrives
        };
        if let (true, Some(sessions)) = (arrives, self.sessions.get()) {
            // A turn ends right now: its idle edge finds the worker taken and must not wait for it.
            let mut edge = eos_core::agent::WorkerSessions::settled(sessions, worker_id);
            let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
            assert!(edge.as_mut().poll(&mut cx).is_ready(), "an idle edge never waits behind a drain");
        }
        self.held.lock().expect("held").iter().any(|w| w == worker_id)
    }

    fn idle(&self, _worker_id: &str) {
        self.idle.fetch_add(1, Ordering::SeqCst);
    }

    fn removed(&self, worker: &Worker) {
        self.removed.lock().expect("removed").push(worker.id.clone());
    }

    fn folder_exists(&self, path: &str) -> bool {
        !self.missing_folders.lock().expect("folders").iter().any(|p| p == path)
    }
}

struct Bench {
    sessions: Sessions,
    agents: ScriptedRuntime,
    temp: TempStore,
    hooks: Arc<Hooks>,
    prompts: Arc<FakePrompts>,
    worktrees: Arc<FakeWorktrees>,
    recents: Arc<FakeRecents>,
    sleeper: Arc<FakeSleeper>,
    clock: Arc<FakeClock>,
}

impl Bench {
    fn new() -> Self {
        let temp = TempStore::new();
        let agents = ScriptedRuntime::new();
        let hooks = Arc::new(Hooks::default());
        let prompts = Arc::new(FakePrompts::default());
        let worktrees = Arc::new(FakeWorktrees::default());
        let recents = Arc::new(FakeRecents::default());
        let sleeper = Arc::new(FakeSleeper::default());
        let clock = Arc::new(FakeClock::new());
        let sessions = Sessions::new(SessionDeps {
            store: temp.port(),
            runtime: agents.port(),
            clock: clock.clone(),
            ids: Arc::new(SeqIds::new()),
            config: Arc::new(FakeConfig::new(serde_json::json!({"loop": {"enabled": true}}))),
            models: Arc::new(FakeModelCatalog::default()),
            prompts: prompts.clone(),
            worktrees: worktrees.clone(),
            recents: recents.clone(),
            hooks: hooks.clone(),
            sleeper: sleeper.clone(),
        });
        let _ = hooks.sessions.set(sessions.clone());
        Self { sessions, agents, temp, hooks, prompts, worktrees, recents, sleeper, clock }
    }

    fn store(&self) -> Arc<dyn Store> {
        self.temp.port()
    }

    async fn chat(&self, prompt: &str) -> String {
        let request = SpawnRequest {
            prompt: prompt.into(),
            cwd: Some("/sandbox/alpha".into()),
            role: Some("focused".into()),
            ..SpawnRequest::default()
        };
        let id = self.sessions.spawn(request).await.expect("spawns").id;
        self.agents.settled().await;
        id
    }

    async fn worker(&self, id: &str) -> Option<Worker> {
        let id = id.to_owned();
        self.store().read(move |tx| tx.workers().find(&id)).await.expect("reads")
    }

    /// The worker's log: `(type, payload)` oldest first.
    async fn rows(&self, id: &str) -> Vec<(String, Value)> {
        let query = EventQuery {
            worker_id: id.into(),
            since: 0,
            limit: 5000,
            order: EventOrder::Asc,
            before_id: None,
            after_id: None,
        };
        let rows = self.store().read(move |tx| tx.events().list(&query)).await.expect("reads");
        rows.into_iter()
            .map(|r| (r.kind, r.payload.and_then(|p| serde_json::from_str(&p).ok()).unwrap_or(Value::Null)))
            .collect()
    }

    /// Each row as `type` or, for a state change, `state:<to>:<reason>`, an
    /// agent event as `agent:<type>[:<phase>]`.
    async fn tags(&self, id: &str) -> Vec<String> {
        let s = |v: &Value, key: &str| v[key].as_str().unwrap_or_default().to_owned();
        self.rows(id)
            .await
            .iter()
            .map(|(kind, p)| match kind.as_str() {
                "state" => format!("state:{}:{}", s(p, "state"), s(p, "reason")),
                "agent_event" if p["phase"].is_string() => format!("agent:{}:{}", s(p, "type"), s(p, "phase")),
                "agent_event" if p["type"].is_string() => format!("agent:{}", s(p, "type")),
                // A usage row keeps the usage and its cost, not the event's envelope.
                "agent_event" => "agent:usage".to_owned(),
                other => other.to_owned(),
            })
            .collect()
    }

    fn message(&self, id: &str, text: &str) -> MessageInput {
        MessageInput {
            worker_id: id.into(),
            text: text.into(),
            origin: Some("dashboard".into()),
            ..MessageInput::default()
        }
    }

    /// A dashboard send, as the composer makes it.
    fn composed(&self, id: &str, text: &str, client: &str) -> MessageInput {
        MessageInput { queue_when_busy: true, client_msg_id: Some(client.into()), ..self.message(id, text) }
    }

    /// A chat at rest whose session is being brought back, held until released.
    async fn coming_back(&self, id: &str) -> eos_testkit::agent::Release {
        self.agents.crash(id).await;
        let start = self.agents.hold_next_start();
        self.sessions.wake(id).await.expect("wakes");
        until(|| async { self.worker(id).await.is_some_and(|w| w.state == WorkerState::Spawning) }).await;
        start
    }

    /// Sends `input` from a task of its own, and returns once it waits for the session.
    async fn send_waiting(&self, input: MessageInput) -> tokio::task::JoinHandle<Result<Dispatched, Error>> {
        let waiting = self.sleeper.pending().len();
        let sessions = self.sessions.clone();
        let sent = tokio::spawn(async move { sessions.dispatch(input).await });
        until(|| async { self.sleeper.pending().len() > waiting }).await;
        sent
    }
}

/// Resolves once `done` holds; a test that waits for longer has failed.
async fn until<F: std::future::Future<Output = bool>>(done: impl Fn() -> F) {
    for _ in 0..5_000 {
        if done().await {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    }
    panic!("waited too long");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_chat_starts_runs_its_first_turn_and_settles_idle() {
    let bench = Bench::new();
    bench.agents.script(Turn::reply("hello back"));
    let id = bench.chat("hello").await;
    assert_eq!(id, "w-00000001");

    assert_eq!(
        bench.tags(&id).await,
        [
            "spawn",
            "agent:session:started",
            "agent:session:ready",
            "agent:turn:started",
            "state:WORKING:agent:turn_started",
            "agent:message",
            "agent:usage",
            "agent:turn:ended",
            "state:IDLE:agent:turn_ended"
        ]
    );
    let rows = bench.rows(&id).await;
    assert_eq!(rows[0].1, serde_json::json!({"pid": null}));
    assert_eq!(rows[5].1["blocks"][0]["msgId"], "1.1", "the answer gets the id a reply points at");
    let usage = &rows[6].1;
    assert_eq!((usage["inputTokens"].as_i64(), usage["outputTokens"].as_i64()), (Some(10), Some(5)));
    assert!(usage["deltaCost"].as_f64().expect("a cost") > 0.0, "{usage}");

    let worker = bench.worker(&id).await.expect("the row");
    assert_eq!(worker.state, WorkerState::Idle);
    assert_eq!(worker.session_id.as_deref(), Some(id.as_str()), "what a resume needs");
    assert_eq!((worker.usage.tokens_in, worker.usage.tokens_out), (10, 5));
    assert!((worker.usage.cost_usd - usage["deltaCost"].as_f64().expect("a cost")).abs() < 1e-12);
    assert_eq!(worker.backend_kind.as_deref(), Some("claude"));
    assert_eq!((worker.agent_role.as_deref(), worker.effort.as_deref()), (Some("focused"), Some("xhigh")));

    // The session got the boot prompt with the worker's first message id, and Eos's system prompt.
    let started = &bench.agents.started()[0];
    assert_eq!(started.prompt.as_deref(), Some("<msg id=\"1\"/>\nhello"));
    assert_eq!(started.system_prompt.as_deref(), Some("PROMPT FOR w-00000001"));
    assert_eq!((started.cwd.as_str(), started.is_focused()), ("/sandbox/alpha", true));
    assert_eq!(bench.prompts.0.lock().expect("facts")[0].cwd.as_deref(), Some("/sandbox/alpha"));
    assert_eq!(bench.recents.0.lock().expect("recents").as_slice(), ["/sandbox/alpha"]);
    assert_eq!(bench.hooks.idle.load(Ordering::SeqCst), 1, "the idle edge ran once the queue was empty");

    // Announced in commit order.
    let topics = bench.temp.announced.topics();
    assert_eq!(topics[0], "worker:spawn");
    assert!(topics.contains(&"usage:recorded"));
    let last = bench.temp.announced.list().pop().expect("an event");
    assert_eq!(last.0, "worker:change");
    assert!(last.1.ends_with("\"from\":\"WORKING\",\"state\":\"IDLE\"}"), "{}", last.1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_message_is_delivered_once_and_recorded_before_the_agent_answers() {
    let bench = Bench::new();
    let id = bench.chat("").await;
    assert_eq!(bench.tags(&id).await, ["spawn", "agent:session:started", "agent:session:ready"]);

    let message = MessageInput { client_msg_id: Some("c-1".into()), ..bench.message(&id, "fix the bug") };
    assert_eq!(bench.sessions.dispatch(message.clone()).await, Ok(Dispatched::Sent));
    bench.agents.settled().await;
    assert_eq!(bench.sessions.dispatch(message).await, Ok(Dispatched::Deduped), "the same client id again");
    assert_eq!(bench.agents.sent(&id), ["<msg id=\"1\"/>\nfix the bug"]);

    let tags = bench.tags(&id).await;
    assert_eq!(
        tags[3..],
        [
            "user_message",
            "state:WORKING:user_message",
            "agent:turn:started",
            "agent:message",
            "agent:usage",
            "agent:turn:ended",
            "state:IDLE:agent:turn_ended"
        ]
    );
    assert_eq!(
        bench.rows(&id).await[3].1,
        serde_json::json!({"text": "fix the bug", "msgId": "1", "clientMsgIds": ["c-1"]})
    );

    // A slash command stays the first thing the agent reads and takes no id.
    bench.sessions.dispatch(bench.message(&id, "/review now")).await.expect("sends");
    bench.agents.settled().await;
    assert_eq!(bench.agents.sent(&id)[1], "/review now");

    // Another agent's message is wrapped in its sender's tag.
    let from_parent = MessageInput {
        envelope: Some(Envelope::OrchestratorMessage { from_parent: "o-1".into(), parent_name: Some("Lead".into()) }),
        ..bench.message(&id, "status?")
    };
    bench.sessions.dispatch(from_parent).await.expect("sends");
    bench.agents.settled().await;
    assert_eq!(
        bench.agents.sent(&id)[2],
        "<agent_message from=\"Lead\" from-id=\"o-1\" id=\"2\">\nstatus?\n</agent_message>"
    );
    let rows = bench.rows(&id).await;
    let directive = rows.iter().find(|(kind, _)| kind == "orchestrator_message").expect("the row");
    assert_eq!(
        directive.1,
        serde_json::json!({"text": "status?", "msgId": "2", "fromParent": "o-1", "parentName": "Lead"})
    );

    let missing = bench.sessions.dispatch(bench.message("w-nope", "hi")).await;
    assert_eq!(missing, Err(Error::not_found("worker", "w-nope")));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn messages_for_a_busy_worker_wait_and_go_out_one_per_turn() {
    let bench = Bench::new();
    let id = bench.chat("").await;
    let gate = bench.agents.script_held(Turn::reply("first done"));
    bench.sessions.dispatch(bench.message(&id, "one")).await.expect("sends");
    bench.agents.running(1).await;

    let queued = |text: &str, client: &str| MessageInput {
        queue_when_busy: true,
        client_msg_id: Some(client.into()),
        ..bench.message(&id, text)
    };
    let second = bench.sessions.dispatch(queued("two", "c-2")).await.expect("queues");
    assert!(matches!(second, Dispatched::Queued { .. }), "{second:?}");
    assert_eq!(bench.sessions.dispatch(queued("two", "c-2")).await, Ok(Dispatched::Deduped));
    assert!(matches!(bench.sessions.dispatch(queued("three", "c-3")).await, Ok(Dispatched::Queued { .. })));
    assert_eq!(bench.agents.sent(&id).len(), 1, "nothing interleaves with the running turn");
    assert_eq!(bench.hooks.idle.load(Ordering::SeqCst), 0, "no idle edge yet");

    gate.release();
    bench.agents.settled().await;
    assert_eq!(bench.agents.sent(&id).len(), 3);
    assert!(bench.agents.sent(&id)[1].ends_with("two") && bench.agents.sent(&id)[2].ends_with("three"));
    let (store, worker) = (bench.store(), id.clone());
    let pending = store.read(move |tx| tx.message_queue().list_pending(&worker)).await;
    assert!(pending.expect("reads").is_empty());
    let rows = bench.rows(&id).await;
    let users: Vec<&Value> = rows.iter().filter(|(kind, _)| kind == "user_message").map(|(_, p)| p).collect();
    assert_eq!(users[1]["clientMsgIds"], serde_json::json!(["c-2"]));
    assert_eq!(bench.hooks.idle.load(Ordering::SeqCst), 1, "the idle edge runs once the queue is empty, not between");
    assert_eq!(bench.worker(&id).await.expect("the row").state, WorkerState::Idle);

    // A worker a feature holds queues even what does not ask to.
    bench.hooks.held.lock().expect("held").push(id.clone());
    let gate = bench.agents.script_held(Turn::reply("busy"));
    bench
        .sessions
        .dispatch(MessageInput { origin: Some("queue-drain".into()), ..bench.message(&id, "go") })
        .await
        .expect("sends");
    bench.agents.running(1).await;
    assert!(matches!(bench.sessions.dispatch(bench.message(&id, "held")).await, Ok(Dispatched::Queued { .. })));
    gate.release();
    bench.agents.settled().await;
    assert_eq!(bench.agents.sent(&id).len(), 4, "a held worker keeps its queue");
    bench.hooks.held.lock().expect("held").clear();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_interrupt_before_any_answer_takes_the_prompt_back() {
    let bench = Bench::new();
    let id = bench.chat("").await;
    // A turn that has produced nothing yet.
    let _gate = bench.agents.script_held(Turn::of(Vec::new()));
    let message = MessageInput { client_msg_id: Some("c-9".into()), ..bench.message(&id, "wait, no") };
    bench.sessions.dispatch(message.clone()).await.expect("sends");
    bench.agents.running(1).await;
    bench
        .sessions
        .dispatch(MessageInput { queue_when_busy: true, ..bench.message(&id, "later") })
        .await
        .expect("queues");

    let recalled = bench.sessions.interrupt(&id).await.expect("interrupts").expect("the prompt comes back");
    assert_eq!((recalled.text.as_str(), recalled.client_msg_id.as_deref()), ("wait, no", Some("c-9")));
    bench.agents.settled().await;
    let rows = bench.rows(&id).await;
    let note = rows.iter().find(|(kind, _)| kind == "message_recalled").expect("the row");
    assert_eq!(note.1["text"], "wait, no");
    assert_eq!(note.1["clientMsgId"], "c-9");
    assert!(bench.agents.calls().contains(&Call::Recall(id.clone())), "the agent never reads it");
    assert_eq!(bench.worker(&id).await.expect("the row").state, WorkerState::Idle);
    assert_eq!(bench.agents.sent(&id).len(), 1, "what the user had queued is dropped with the interrupt");
    assert!(bench.temp.announced.topics().contains(&"message:recalled"));
    // The same message may be sent again.
    bench.agents.script(Turn::reply("ok"));
    assert_eq!(bench.sessions.dispatch(message).await, Ok(Dispatched::Sent));
    bench.agents.settled().await;

    // After an answer an interrupt is a plain interrupt.
    let _gate = bench.agents.script_held(Turn::reply("partial"));
    bench.sessions.dispatch(bench.message(&id, "again")).await.expect("sends");
    bench.agents.running(1).await;
    while bench.rows(&id).await.iter().filter(|(_, p)| p["type"] == "message").count() < 2 {
        tokio::task::yield_now().await;
    }
    assert_eq!(bench.sessions.interrupt(&id).await, Ok(None));
    bench.agents.settled().await;
    let tags = bench.tags(&id).await;
    assert!(tags.contains(&"state:IDLE:interrupt".to_owned()), "{tags:?}");
    assert_eq!(
        tags.last().map(String::as_str),
        Some("agent:turn:aborted"),
        "already idle: the turn's end moves nothing"
    );
    assert_eq!(bench.worker(&id).await.expect("the row").state, WorkerState::Idle);

    bench.sessions.kill(&id).await.expect("removes");
    assert_eq!(bench.sessions.interrupt(&id).await, Err(Error::not_found("worker", &id)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_that_dies_parks_its_worker_and_resume_brings_it_back() {
    let bench = Bench::new();
    bench.agents.script(Turn::reply("hi"));
    let id = bench.chat("hello").await;

    bench.agents.crash(&id).await;
    let worker = bench.worker(&id).await.expect("the row");
    assert_eq!(worker.state, WorkerState::Suspended, "its conversation can be continued");
    let tags = bench.tags(&id).await;
    assert_eq!(tags[tags.len() - 2..], ["state:SUSPENDED:session_exit", "exit"]);
    assert_eq!(bench.rows(&id).await.pop().expect("a row").1, serde_json::json!({"code": 1}));
    assert_eq!(bench.sessions.tracked_turns(), 0, "nothing is remembered about a session that ended");

    let unreachable = bench.sessions.dispatch(bench.message(&id, "anyone?")).await;
    assert_eq!(unreachable, Err(Error::Unreachable("worker".into())));
    assert_eq!(bench.worker(&id).await.expect("the row").state, WorkerState::Suspended);
    let rows = bench.rows(&id).await;
    let failed = rows.iter().rev().find(|(kind, _)| kind == "lifecycle").map(|(_, p)| p.clone());
    assert_eq!(
        failed,
        Some(serde_json::json!({"phase": "delivery_failed", "text": "anyone?"})),
        "the chat says the message it shows never arrived"
    );

    bench.sessions.resume(&id).await.expect("resumes");
    assert_eq!(bench.worker(&id).await.expect("the row").state, WorkerState::Idle);
    let resumed = bench.agents.started().pop().expect("a start");
    assert_eq!((resumed.resume.as_deref(), resumed.prompt.as_deref()), (Some(id.as_str()), None));
    let rows = bench.rows(&id).await;
    let spawn = rows.iter().rev().find(|(kind, _)| kind == "spawn").expect("the row");
    assert_eq!(spawn.1, serde_json::json!({"resumed": true, "sessionId": id, "pid": null}));
    let tags = bench.tags(&id).await;
    assert!(tags.contains(&"state:SPAWNING:resume".to_owned()) && tags.contains(&"state:IDLE:resume_ready".to_owned()));

    let again = bench.sessions.resume(&id).await;
    assert_eq!(again, Err(Error::Conflict("worker is not resumable (state IDLE)".into())));

    // A suspend on purpose keeps SUSPENDED through the session's exit; a folder that is gone refuses the resume.
    bench.sessions.suspend(&id, "idle suspend").await.expect("suspends");
    assert_eq!(bench.worker(&id).await.expect("the row").state, WorkerState::Suspended);
    bench.hooks.missing_folders.lock().expect("folders").push("/sandbox/alpha".into());
    let gone = bench.sessions.resume(&id).await;
    assert_eq!(gone, Err(Error::Conflict("workspace directory no longer exists".into())));
    bench.hooks.missing_folders.lock().expect("folders").clear();
    bench.agents.fail_next_start(Error::Rule("no credential".into()));
    assert_eq!(bench.sessions.resume(&id).await, Err(Error::Rule("no credential".into())));
    assert_eq!(
        bench.worker(&id).await.expect("the row").state,
        WorkerState::Suspended,
        "a failed resume parks it again"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_message_queued_before_the_session_ended_goes_out_once_the_worker_is_resumed() {
    let bench = Bench::new();
    let id = bench.chat("").await;
    let _gate = bench.agents.script_held(Turn::reply("never"));
    bench.sessions.dispatch(bench.message(&id, "a long job")).await.expect("sends");
    bench.agents.running(1).await;
    let queued =
        MessageInput { queue_when_busy: true, client_msg_id: Some("c-then".into()), ..bench.message(&id, "then this") };
    assert!(matches!(bench.sessions.dispatch(queued).await, Ok(Dispatched::Queued { .. })));
    // The app quits (or the session dies) with the message still queued.
    bench.agents.crash(&id).await;
    assert_eq!(bench.worker(&id).await.expect("the row").state, WorkerState::Suspended);

    bench.sessions.resume(&id).await.expect("resumes");
    bench.agents.settled().await;
    let sent = bench.agents.sent(&id);
    assert_eq!(sent.iter().filter(|s| s.ends_with("then this")).count(), 1, "the resume is an idle edge: {sent:?}");
    let (store, worker) = (bench.store(), id.clone());
    let pending = store.read(move |tx| tx.message_queue().list_pending(&worker)).await.expect("reads");
    assert!(pending.is_empty(), "nothing is left in the queue");
}

// One thread: a send counts as waiting once its task has taken its place in line.
#[tokio::test]
async fn messages_sent_while_a_chat_comes_back_wait_for_it_and_go_out_once_in_order() {
    let bench = Bench::new();
    let id = bench.chat("").await;
    let start = bench.coming_back(&id).await;

    let first = bench.send_waiting(bench.composed(&id, "first", "c-1")).await;
    let repeated = bench.send_waiting(bench.composed(&id, "first", "c-1")).await;
    let second = bench.send_waiting(bench.composed(&id, "second", "c-2")).await;
    assert!(bench.agents.sent(&id).is_empty(), "nothing reaches a session that is not up");
    assert_eq!(bench.worker(&id).await.expect("the row").state, WorkerState::Spawning);

    let turn = bench.agents.script_held(Turn::reply("on it"));
    start.release();
    assert_eq!(first.await.expect("joins"), Ok(Dispatched::Sent));
    assert_eq!(repeated.await.expect("joins"), Ok(Dispatched::Deduped), "a repeated send is taken once");
    let queued = second.await.expect("joins");
    assert!(matches!(queued, Ok(Dispatched::Queued { .. })), "it waits for the first one's turn: {queued:?}");
    turn.release();
    bench.agents.settled().await;

    let sent = bench.agents.sent(&id);
    assert_eq!(sent.len(), 2, "{sent:?}");
    assert!(sent[0].ends_with("first") && sent[1].ends_with("second"), "{sent:?}");
    let rows = bench.rows(&id).await;
    let said: Vec<&str> =
        rows.iter().filter(|(kind, _)| kind == "user_message").filter_map(|(_, p)| p["text"].as_str()).collect();
    assert_eq!(said, ["first", "second"]);
    assert!(!bench.tags(&id).await.iter().any(|t| t.ends_with(":delivery_failed")));
    assert_eq!(bench.worker(&id).await.expect("the row").state, WorkerState::Idle);
}

#[tokio::test]
async fn a_start_that_fails_fails_the_messages_that_waited_for_it() {
    let bench = Bench::new();
    let id = bench.chat("").await;
    bench.agents.fail_next_start(Error::Rule("no credential".into()));
    let start = bench.coming_back(&id).await;
    let waiting = bench.send_waiting(bench.composed(&id, "hello", "c-1")).await;
    start.release();
    assert_eq!(waiting.await.expect("joins"), Err(Error::Rule("no credential".into())));
    assert_eq!(bench.worker(&id).await.expect("the row").state, WorkerState::Suspended, "parked again");
    assert!(
        bench.rows(&id).await.iter().all(|(kind, _)| kind != "user_message"),
        "the chat shows nothing it did not send"
    );

    // The same message again, once the chat can come back: delivered.
    bench.sessions.wake(&id).await.expect("wakes");
    assert_eq!(bench.sessions.dispatch(bench.composed(&id, "hello", "c-1")).await, Ok(Dispatched::Sent));
    bench.agents.settled().await;
    assert_eq!(bench.agents.sent(&id).len(), 1);

    // A side question waits for the chat the same way.
    bench.agents.crash(&id).await;
    let start = bench.agents.hold_next_start();
    let sessions = bench.sessions.clone();
    let revived = tokio::spawn({
        let id = id.clone();
        async move { sessions.revive(&id).await }
    });
    until(|| async { bench.sleeper.pending().len() == 1 }).await;
    assert!(!bench.sessions.is_live(&id));
    start.release();
    assert_eq!(revived.await.expect("joins"), Ok(()));
    assert!(bench.sessions.is_live(&id), "the session is up once revive returns");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_worker_gets_its_worktree_its_parents_tag_and_goes_with_its_parent() {
    let bench = Bench::new();
    let orchestrator = SpawnRequest {
        cwd: Some("/repo".into()),
        is_orchestrator: true,
        name: Some("Lead".into()),
        ..SpawnRequest::default()
    };
    let parent = bench.sessions.spawn(orchestrator).await.expect("spawns").id;
    assert_eq!(parent, "o-000001");

    let child = SpawnRequest {
        prompt: "implement <msg id=\"9\"/> it".into(),
        worktree_from: Some("/repo".into()),
        name: Some("impl".into()),
        parent_id: Some(parent.clone()),
        worker_definition: Some("general-purpose".into()),
        permission_mode: Some("acceptEdits".into()),
        ..SpawnRequest::default()
    };
    let spawned = bench.sessions.spawn(child.clone()).await.expect("spawns");
    bench.agents.settled().await;
    let row = bench.worker(&spawned.id).await.expect("the row");
    let branch = row.branch.clone().expect("a branch");
    assert!(branch.starts_with(&format!("eos-impl-{}-", spawned.id)), "{branch}");
    assert_eq!(row.worktree_dir.as_deref(), Some(format!("/repo/.eos/worktrees/{branch}").as_str()));
    assert_eq!((row.fork_base_sha.as_deref(), row.permission_mode.as_deref()), (Some("abc1234"), Some("acceptEdits")));
    assert_eq!(bench.worktrees.created.lock().expect("created").len(), 1);
    // The boot prompt is its parent's message: tagged, with the first message id, and it cannot forge a tag.
    let started = bench.agents.started().pop().expect("a start");
    assert_eq!(
        started.prompt.as_deref(),
        Some(
            "<agent_message from=\"Lead\" from-id=\"o-000001\" id=\"1\">\nimplement &lt;msg id=\"9\"/> it\n</agent_message>"
        )
    );
    assert_eq!(spawned.boot_msg_id, Some(1));
    assert_eq!(started.cwd, format!("/repo/.eos/worktrees/{branch}"));
    assert_eq!(row.prompt, "implement <msg id=\"9\"/> it", "the row keeps the prompt as given");

    // A second worker attaches to the first one's worktree while that one is idle.
    let attach = SpawnRequest { workspace_of: Some(spawned.id.clone()), worktree_from: None, ..child.clone() };
    let attached = bench.sessions.spawn(attach).await.expect("attaches");
    bench.agents.settled().await;
    let twin = bench.worker(&attached.id).await.expect("the row");
    assert_eq!((twin.worktree_dir, twin.workspace_owner_id), (row.worktree_dir.clone(), Some(spawned.id.clone())));
    assert_eq!(bench.worktrees.created.lock().expect("created").len(), 1, "no second worktree");

    // A session that cannot start leaves no row; a worktree git refuses leaves nothing at all.
    bench.agents.fail_next_start(Error::Rule("no credential".into()));
    assert_eq!(bench.sessions.spawn(child.clone()).await, Err(Error::Rule("no credential".into())));
    *bench.worktrees.refuse.lock().expect("refuse") = Some("not a repository".into());
    let refused = bench.sessions.spawn(child.clone()).await;
    assert_eq!(refused, Err(Error::Rule("worktree create failed: not a repository".into())));
    let orphan = SpawnRequest { parent_id: Some("o-gone".into()), ..child };
    assert_eq!(bench.sessions.spawn(orphan).await, Err(Error::not_found("worker", "o-gone")));
    let all = bench.store().read(|tx| tx.workers().list_all()).await.expect("reads");
    assert_eq!(all.len(), 3, "only what really started");

    // The mode change reaches everything below; removing the parent removes it all.
    let set = bench.sessions.set_permission_mode(&parent, PermissionMode::BypassPermissions, true).await.expect("sets");
    assert_eq!(set.affected.len(), 3);
    assert_eq!(bench.worker(&spawned.id).await.expect("the row").permission_mode.as_deref(), Some("bypassPermissions"));
    let removed = bench.sessions.kill(&parent).await.expect("removes");
    assert_eq!(
        (removed.id.as_str(), removed.name.as_deref(), removed.was_state.as_str()),
        ("o-000001", Some("Lead"), "SPAWNING")
    );
    assert!(bench.store().read(|tx| tx.workers().list_all()).await.expect("reads").is_empty());
    assert!(bench.rows(&spawned.id).await.is_empty(), "its log goes with it");
    assert_eq!(bench.agents.live(), 0);
    assert_eq!(bench.agents.forgotten().len(), 3, "recorded conversations are deleted");
    assert_eq!(bench.hooks.removed.lock().expect("removed").len(), 3);
    assert_eq!(bench.temp.announced.topics().iter().filter(|t| **t == "worker:removed").count(), 3);
    let queued = bench.store().read(|tx| tx.worktree_removals().list()).await.expect("reads");
    assert!(queued.iter().any(|r| r.worker_id == spawned.id && r.branch == branch), "{queued:?}");
    assert_eq!(bench.sessions.tracked_turns(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_model_change_is_checked_saved_and_applied_to_the_live_session() {
    let bench = Bench::new();
    let id = bench.chat("").await;
    let refused = bench.sessions.set_model(&id, "gpt-5", None).await;
    assert_eq!(refused, Err(Error::Validation("model \"gpt-5\" is not valid for provider Claude".into())));

    let set = bench.sessions.set_model(&id, "sonnet", Some("high")).await.expect("sets");
    assert_eq!((set.model.as_str(), set.effort.as_deref(), set.runtime_applied), ("sonnet", Some("high"), true));
    let worker = bench.worker(&id).await.expect("the row");
    assert_eq!((worker.model.as_deref(), worker.effort.as_deref()), (Some("sonnet"), Some("high")));
    let note = bench.rows(&id).await.pop().expect("a row");
    assert_eq!(note.0, "lifecycle");
    assert_eq!(
        note.1,
        serde_json::json!({"kind": "model_set", "model": "sonnet", "effort": "high", "runtimeApplied": true})
    );
    assert!(bench.agents.calls().iter().any(|c| matches!(c, Call::SetModel { model, .. } if model == "sonnet")));

    // A worker whose session is over keeps the choice for its next start.
    bench.sessions.suspend(&id, "idle suspend").await.expect("suspends");
    let later = bench.sessions.set_model(&id, "claude-opus-5-5", None).await.expect("sets");
    assert!(!later.runtime_applied);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_thousand_workers_come_and_go_and_nothing_is_left() {
    let bench = Bench::new();
    for round in 0..10 {
        let mut ids = Vec::new();
        for _ in 0..100 {
            bench.agents.script(Turn::reply("done"));
            let request = SpawnRequest { prompt: "go".into(), cwd: Some("/sandbox".into()), ..SpawnRequest::default() };
            ids.push(bench.sessions.spawn(request).await.expect("spawns").id);
        }
        bench.agents.settled().await;
        assert_eq!(bench.agents.live(), 100, "round {round}");
        for id in &ids {
            bench.sessions.kill(id).await.expect("removes");
        }
        assert_eq!(bench.agents.live(), 0);
        assert_eq!(bench.sessions.tracked_turns(), 0, "per-worker memory is freed with the worker");
    }
    assert!(bench.store().read(|tx| tx.workers().list_all()).await.expect("reads").is_empty());
    let left = bench.store().read(|tx| tx.events().prune_all(0)).await;
    assert!(left.is_err() || left == Ok(0), "no rows of removed workers stay behind");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_removed_chats_views_and_definitions_go_in_the_same_write() {
    let bench = Bench::new();
    let id = bench.chat("hi").await;
    bench.agents.settled().await;
    bench.temp.exec(&format!(
        "INSERT INTO genui_views (id, worker_id, kind, title, data, created_at) \
         VALUES ('v_kept', '{id}', 'view', 't', '{{}}', 1); \
         INSERT INTO worker_definitions (owner, name, json, created_at, updated_at) \
         VALUES ('{id}', 'helper', '{{}}', 1, 1);"
    ));
    let rows = |id: &str| {
        let views = bench.temp.count(&format!("SELECT count(*) FROM genui_views WHERE worker_id = '{id}'"));
        let definitions = bench.temp.count(&format!("SELECT count(*) FROM worker_definitions WHERE owner = '{id}'"));
        (views, definitions)
    };
    assert_eq!(rows(&id), (1, 1), "the rows are there before");
    bench.sessions.kill(&id).await.expect("removes");
    // Counted at once: nothing waits on an event for these rows to go.
    assert_eq!(rows(&id), (0, 0), "the chat's views and the definitions it made went with it");
}

/// A command a feature owns: it takes any arguments and says what it got.
struct Compact(std::sync::Mutex<Vec<String>>);

impl eos_sessions::SlashCommand for Compact {
    fn name(&self) -> &'static str {
        "compact"
    }

    fn description(&self) -> &'static str {
        "Summarize the conversation"
    }

    fn accepts(&self, _args: &str, capabilities: &eos_core::agent::AgentCapabilities) -> bool {
        capabilities.context_compaction == Some(true)
    }

    fn execute<'a>(
        &'a self,
        cx: eos_sessions::SlashContext<'a>,
    ) -> eos_core::BoxFuture<'a, Result<CommandAnswer, Error>> {
        self.0.lock().expect("focus").push(cx.args.to_owned());
        // The command chooses its own status: accepted while it works, a conflict when it cannot.
        let answer = match cx.args {
            "now?" => CommandAnswer::new(409, serde_json::json!({"ok": false, "error": "already compacting"})),
            _ => CommandAnswer::new(202, serde_json::json!({"ok": true, "compacting": true})),
        };
        Box::pin(std::future::ready(Ok(answer)))
    }
}

// core/src/__tests__/DispatchMessage.replies.test.ts, DispatchMessage.viewAction.test.ts, slash-command.test.ts
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replies_clicks_and_eos_commands_go_through_dispatch() {
    let bench = Bench::new();
    bench.agents.script(Turn::reply("the plan is ready"));
    let id = bench.chat("make a plan").await;
    let rows = bench.rows(&id).await;
    let answer = rows.iter().position(|(_, p)| p["type"] == "message").expect("the answer") as i64 + 1;

    // A reply to the agent's own message quotes it; the chat row keeps what it replied to.
    let reply = MessageInput { reply_to: Some(answer), ..bench.message(&id, "go ahead") };
    bench.sessions.dispatch(reply).await.expect("sends");
    bench.agents.settled().await;
    assert_eq!(
        bench.agents.sent(&id)[0],
        "<msg id=\"2\"/>\n<reply_to id=\"1.1\">the plan is ready</reply_to>\ngo ahead"
    );
    let rows = bench.rows(&id).await;
    let said = rows.iter().rfind(|(kind, _)| kind == "user_message").expect("the row");
    assert_eq!(
        said.1["replyTo"],
        serde_json::json!({"rowId": answer, "msgId": "1.1", "role": "assistant", "excerpt": "the plan is ready"})
    );
    let user_row = rows.iter().position(|(kind, _)| kind == "user_message").expect("the row") as i64 + 1;
    // The user's own earlier message is still in the agent's context: named by its id, not quoted.
    bench
        .sessions
        .dispatch(MessageInput { reply_to: Some(user_row), ..bench.message(&id, "as I said") })
        .await
        .expect("sends");
    bench.agents.settled().await;
    assert_eq!(bench.agents.sent(&id)[1], "<msg id=\"3\"/>\n<reply_to id=\"2\"/>\nas I said");
    let gone = bench.sessions.dispatch(MessageInput { reply_to: Some(9999), ..bench.message(&id, "to what?") }).await;
    assert_eq!(gone, Err(Error::not_found("message", "9999")));

    // A click in a visual answer: the agent reads the label and the payload, the chat shows the label.
    let click =
        serde_json::from_value(serde_json::json!({"viewId": "v_abcdefghijkl", "actionId": "book", "label": "Book it"}))
            .expect("a view action");
    bench.sessions.dispatch(MessageInput { view_action: Some(click), ..bench.message(&id, "") }).await.expect("sends");
    bench.agents.settled().await;
    assert_eq!(
        bench.agents.sent(&id)[2],
        "<msg id=\"4\"/>\n[view action] Book it\n{\"viewId\":\"v_abcdefghijkl\",\"actionId\":\"book\"}"
    );
    let rows = bench.rows(&id).await;
    let chip = rows.iter().rfind(|(kind, _)| kind == "user_message").expect("the row");
    assert_eq!(chip.1["text"], "Book it");
    assert_eq!(chip.1["action"], serde_json::json!({"viewId": "v_abcdefghijkl", "label": "Book it"}));

    // `/clear` is Eos's own: it never reaches the agent, the chat folds, a reply after it quotes in full.
    let before = bench.agents.sent(&id).len();
    let cleared = bench.sessions.dispatch(bench.message(&id, "/clear")).await.expect("runs");
    assert_eq!(cleared, Dispatched::Command(CommandAnswer::ok(serde_json::json!({"ok": true, "cleared": true}))));
    assert_eq!(bench.agents.sent(&id).len(), before);
    assert!(bench.agents.calls().contains(&Call::ClearContext(id.clone())));
    assert_eq!(
        bench.rows(&id).await.pop().expect("a row"),
        ("conversation_cleared".to_owned(), serde_json::json!({"via": "slash-command"}))
    );
    bench
        .sessions
        .dispatch(MessageInput { reply_to: Some(user_row), ..bench.message(&id, "about this") })
        .await
        .expect("sends");
    bench.agents.settled().await;
    assert!(
        bench.agents.sent(&id)[before].contains("<reply_to id=\"2\">go ahead</reply_to>"),
        "out of context now, so quoted: {}",
        bench.agents.sent(&id)[before]
    );

    // A feature's command is caught before dispatch; with arguments `/clear` is the agent's to read.
    let compact = Arc::new(Compact(std::sync::Mutex::new(Vec::new())));
    let command: Arc<dyn eos_sessions::SlashCommand> = compact.clone();
    bench.sessions.register_command(&command);
    let ran = bench.sessions.dispatch(bench.message(&id, "/compact keep the plan")).await.expect("runs");
    assert_eq!(ran, Dispatched::Command(CommandAnswer::new(202, serde_json::json!({"ok": true, "compacting": true}))));
    let refused = bench.sessions.dispatch(bench.message(&id, "/compact now?")).await.expect("answers");
    assert!(matches!(&refused, Dispatched::Command(answer) if answer.status == 409), "{refused:?}");
    assert_eq!(compact.0.lock().expect("focus").as_slice(), ["keep the plan", "now?"]);
    assert_eq!(bench.sessions.commands().iter().map(|c| c.name()).collect::<Vec<_>>(), ["clear", "compact"]);
    let sent = bench.agents.sent(&id).len();
    assert_eq!(bench.sessions.dispatch(bench.message(&id, "/clear everything")).await, Ok(Dispatched::Sent));
    bench.agents.settled().await;
    assert_eq!(bench.agents.sent(&id)[sent], "/clear everything");

    // What a feature holds of the service to speak for the user.
    let as_user: Arc<dyn eos_core::agent::UserMessages> = Arc::new(bench.sessions.clone());
    let message =
        eos_core::agent::UserMessage { text: "from a view".into(), display_text: Some("Clicked".into()), action: None };
    as_user.send(&id, message).await.expect("sends");
    bench.agents.settled().await;
    assert!(bench.agents.sent(&id).last().expect("a message").ends_with("from a view"));
}

// core/src/__tests__/PruneOrphanWorktrees.test.ts, ReapWorktreeRemovals.test.ts
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_worktrees_eos_made_and_nobody_uses_are_deleted() {
    use eos_core::git::WorktreeEntry;
    use eos_sessions::cleanup::{prune_orphan_worktrees, reap_worktree_removals};

    let bench = Bench::new();
    let worker = SpawnRequest {
        prompt: "go".into(),
        worktree_from: Some("/repo".into()),
        name: Some("impl".into()),
        ..SpawnRequest::default()
    };
    let kept = bench.sessions.spawn(worker.clone()).await.expect("spawns").id;
    bench.agents.settled().await;
    let branch = bench.worker(&kept).await.expect("the row").branch.expect("a branch");
    let entry = |path: &str, branch: Option<&str>, locked: bool, is_main: bool| WorktreeEntry {
        path: path.into(),
        branch: branch.map(str::to_owned),
        locked,
        is_main,
    };
    *bench.worktrees.listed.lock().expect("listed") = vec![
        entry("/repo", Some("main"), false, true),
        entry(&format!("/repo/.eos/worktrees/{branch}"), Some(&branch), false, false),
        entry("/repo/.eos/worktrees/eos-old-w-gone-abc", Some("eos-old-w-gone-abc"), false, false),
        entry("/repo/.eos/worktrees/eos-locked", Some("eos-locked"), true, false),
        entry("/repo/.eos/worktrees/feature", Some("feature"), false, false),
        entry("/elsewhere/eos-mine", Some("eos-mine"), false, false),
        entry("/repo/.eos/worktrees/detached", None, false, false),
    ];
    let pruned = prune_orphan_worktrees(bench.store().as_ref(), bench.worktrees.as_ref()).await.expect("prunes");
    assert_eq!(pruned, [std::path::PathBuf::from("/repo/.eos/worktrees/eos-old-w-gone-abc")]);
    let removed = bench.worktrees.removed.lock().expect("removed").clone();
    assert_eq!(removed.len(), 1, "a chat that exists keeps its worktree; a user's own worktrees are never touched");
    assert_eq!(removed[0].branch, "eos-old-w-gone-abc");

    // A worktree worker with no branch on its row: its worktree cannot be told from an orphan, so nothing goes.
    bench.temp.exec(&format!("UPDATE workers SET branch = NULL WHERE id = '{kept}'"));
    assert!(prune_orphan_worktrees(bench.store().as_ref(), bench.worktrees.as_ref()).await.expect("prunes").is_empty());
    bench.temp.exec(&format!("UPDATE workers SET branch = '{branch}' WHERE id = '{kept}'"));

    // A removed worker's worktree goes after its grace period, unless another worker still works in it.
    let twin = SpawnRequest { workspace_of: Some(kept.clone()), worktree_from: None, ..worker };
    let twin = bench.sessions.spawn(twin).await.expect("attaches").id;
    bench.agents.settled().await;
    bench.sessions.kill(&kept).await.expect("removes");
    let now = FakeClock::START_MS;
    let tries = eos_testkit::FakeTries::default();
    assert_eq!(
        reap_worktree_removals(bench.store().as_ref(), bench.worktrees.as_ref(), &tries, now).await,
        Ok(0),
        "inside the grace period"
    );
    assert!(tries.cleaned.lock().expect("cleaned").is_empty());
    assert_eq!(
        reap_worktree_removals(bench.store().as_ref(), bench.worktrees.as_ref(), &tries, now + 10_000).await,
        Ok(0),
        "its twin still works there"
    );
    // The removed worker's Try snapshot is settled even when its worktree stays.
    assert_eq!(*tries.cleaned.lock().expect("cleaned"), [(std::path::PathBuf::from("/repo"), kept.clone())]);
    assert!(
        bench.store().read(|tx| tx.worktree_removals().list()).await.expect("reads").is_empty(),
        "the entry leaves the queue"
    );
    bench.sessions.kill(&twin).await.expect("removes");
    assert_eq!(
        reap_worktree_removals(bench.store().as_ref(), bench.worktrees.as_ref(), &tries, now + 10_000).await,
        Ok(1)
    );
    assert_eq!(bench.worktrees.removed.lock().expect("removed").last().expect("a removal").branch, branch);
}

impl Bench {
    /// An orchestrator and `names` collaborating workers under it, all idle.
    async fn team(&self, names: &[&str]) -> (String, Vec<String>) {
        let boss = SpawnRequest {
            prompt: "lead".into(),
            cwd: Some("/repo".into()),
            is_orchestrator: true,
            ..SpawnRequest::default()
        };
        self.agents.script(Turn::reply("on it"));
        let boss = self.sessions.spawn(boss).await.expect("spawns").id;
        self.agents.settled().await;
        let mut workers = Vec::new();
        for name in names {
            self.agents.script(Turn::reply("ready"));
            workers.push(self.member(&boss, name).await);
            self.agents.settled().await;
        }
        (boss, workers)
    }

    async fn member(&self, boss: &str, name: &str) -> String {
        let worker = SpawnRequest {
            prompt: "your part".into(),
            cwd: Some("/repo".into()),
            parent_id: Some(boss.to_owned()),
            name: Some(name.to_owned()),
            collaborate: true,
            ..SpawnRequest::default()
        };
        self.sessions.spawn(worker).await.expect("spawns").id
    }
}

// core/src/__tests__/ArchiveWorker.test.ts, RestoreWorker.test.ts, PurgeWorker.test.ts, PurgeExpiredArchives.test.ts
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_archived_chat_is_hidden_and_stopped_and_only_a_purge_deletes_it() {
    use eos_domain::config::ArchiveRetention;

    let bench = Bench::new();
    let (boss, kids) = bench.team(&["a"]).await;
    let kid = &kids[0];
    let done = bench.sessions.archive(&boss).await.expect("archives");
    assert_eq!((done.archived.as_slice(), done.was_state.as_str()), ([kid.clone(), boss.clone()].as_slice(), "IDLE"));
    assert_eq!(bench.agents.live(), 0, "their sessions are stopped");
    let row = bench.worker(&boss).await.expect("the row stays");
    assert!(row.is_archived() && row.state == WorkerState::Done);
    assert!(bench.hooks.removed.lock().expect("removed").is_empty(), "nothing of it is deleted");
    assert_eq!(bench.sessions.archive(&boss).await, Err(Error::Conflict(format!("worker {boss} is already archived"))));
    assert_eq!(bench.sessions.purge("w-nope").await, Err(Error::not_found("worker", "w-nope")));

    let inside = bench.sessions.restore(kid).await.expect_err("only the top of an archived subtree is restored");
    assert!(inside.to_string().contains("restore the topmost archived ancestor"), "{inside}");
    let back = bench.sessions.restore(&boss).await.expect("restores");
    assert_eq!(back.restored, [kid.clone(), boss.clone()]);
    assert!(!bench.worker(kid).await.expect("the row").is_archived());
    let not_archived = bench.sessions.purge(&boss).await.expect_err("only an archived chat is purged");
    assert!(not_archived.to_string().ends_with("only archived workers can be purged"), "{not_archived}");
    assert_eq!(bench.sessions.owned_by(&boss, kid).await, Ok(()));
    assert!(matches!(bench.sessions.owned_by(kid, &boss).await, Err(Error::PermissionDenied(_))));

    // Retention: an archived chat goes once it was kept long enough, with everything below it.
    bench.sessions.archive(&boss).await.expect("archives");
    assert!(bench.sessions.purge_expired_archives(ArchiveRetention::Off).await.expect("sweeps").is_empty());
    assert!(bench.sessions.purge_expired_archives(ArchiveRetention::Daily).await.expect("sweeps").is_empty());
    bench.clock.advance(24 * 60 * 60 * 1000);
    let purged = bench.sessions.purge_expired_archives(ArchiveRetention::Daily).await.expect("sweeps");
    assert_eq!(purged, std::slice::from_ref(&boss), "the subtree is purged through its root");
    assert!(bench.worker(&boss).await.is_none() && bench.worker(kid).await.is_none());
    assert_eq!(bench.hooks.removed.lock().expect("removed").len(), 2);

    let chat = bench.chat("").await;
    bench.sessions.archive(&chat).await.expect("archives");
    assert_eq!(bench.sessions.purge_all_archived().await.expect("purges"), [chat]);
}

// manager/routes/__tests__/report*.test.ts, core/src/__tests__/report-signal.test.ts
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_report_is_a_turn_of_the_parent_unless_the_workers_loop_holds_it() {
    use eos_sessions::loops::{AttachLoop, attach_loop};

    let bench = Bench::new();
    let (boss, kids) = bench.team(&["a"]).await;
    let kid = &kids[0];
    bench.agents.script(Turn::reply("noted"));
    let reported = bench.sessions.report(kid, "result: all green").await.expect("reports");
    assert!(reported.delivered && !reported.held);
    bench.agents.settled().await;
    let heard = bench.agents.sent(&boss).pop().expect("the parent's turn");
    assert!(heard.starts_with("<agent_message ") && heard.contains("result: all green"), "{heard}");
    assert!(bench.temp.announced.topics().contains(&"worker:report"));
    assert_eq!(bench.sessions.report(&boss, "hi").await, Err(Error::Validation("worker has no parent".into())));
    assert_eq!(bench.sessions.report("w-nope", "hi").await, Err(Error::not_found("worker", "w-nope")));

    // A looped worker's final report waits for its goal check; a question for the user goes through.
    let goal = serde_json::from_value(serde_json::json!({"summary": "s", "criteria": [{"id": "c1", "text": "t"}]}));
    let attach = AttachLoop {
        caller_id: boss.clone(),
        target: Some(kid.clone()),
        goal: goal.expect("a goal"),
        strategy: None,
        limit: None,
    };
    let ids = SeqIds::new();
    bench.store().write(move |tx, _| attach_loop(tx, &ids, 1, &attach).map(|_| ())).await.expect("arms");
    let held = bench.sessions.report(kid, "Result: done").await.expect("reports");
    assert!(held.held && !held.delivered);
    let wanted = kid.clone();
    let armed = bench.store().read(move |tx| tx.loops().find_active_by_worker(&wanted)).await.expect("reads");
    assert_eq!(armed.as_ref().and_then(|l| l.held_report.as_deref()), Some("Result: done"));
    bench.agents.script(Turn::reply("which one?"));
    let question = bench.sessions.report(kid, "needs input: which db?").await.expect("reports");
    assert!(question.delivered && !question.held);
    let wanted = kid.clone();
    let armed = bench.store().read(move |tx| tx.loops().find_active_by_worker(&wanted)).await.expect("reads");
    assert!(armed.as_ref().is_some_and(|l| l.awaiting_input));
    bench.sessions.resume_loop_on_input(kid).await.expect("resumes");
    let wanted = kid.clone();
    let armed = bench.store().read(move |tx| tx.loops().find_active_by_worker(&wanted)).await.expect("reads");
    assert!(armed.is_some_and(|l| !l.awaiting_input), "the loop goes on once someone wrote to the worker");
}

// manager/services/__tests__/PendingPeerRequestService.test.ts, core/src/__tests__/Peers.test.ts,
// manager/__tests__/peer-pump.test.ts
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn workers_of_one_orchestrator_consult_each_other_one_question_a_turn() {
    use eos_contracts::PeerRef;
    use eos_sessions::{PeerAnswer, PeerAsk};

    let bench = Bench::new();
    let (boss, kids) = bench.team(&["api", "ui"]).await;
    let (api, ui) = (&kids[0], &kids[1]);
    let by_name = |name: &str| PeerRef { id: None, name: Some(name.to_owned()) };
    let peers = bench.sessions.peers_of(ui).await.expect("lists");
    assert_eq!(peers.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), [api.as_str()]);
    assert!(bench.sessions.peers_of(&boss).await.expect("lists").is_empty(), "an orchestrator has no peers");

    let declined = |ask: PeerAsk| match ask {
        PeerAsk::Declined { reason } => reason,
        PeerAsk::Registered { .. } => panic!("should have been declined"),
    };
    let registered = |ask: PeerAsk| match ask {
        PeerAsk::Registered { request_id } => request_id,
        PeerAsk::Declined { reason } => panic!("declined: {reason}"),
    };
    let own = bench.sessions.ask_peer(ui, by_name("ui"), "?").await.expect("asks");
    assert_eq!(declined(own), "a worker cannot consult itself");
    let outsider = bench.sessions.ask_peer(&boss, by_name("api"), "?").await.expect("asks");
    assert_eq!(declined(outsider), "you are not in a collaboration group");

    // The question starts a turn of the peer; its answer reaches the asker.
    let gate = bench.agents.script_held(Turn::reply("let me look"));
    let request = registered(bench.sessions.ask_peer(ui, by_name("api"), "which port?").await.expect("asks"));
    bench.agents.running(1).await;
    let delivered = bench.agents.sent(api).pop().expect("the peer's turn");
    assert!(delivered.starts_with("<agent_message ") && delivered.contains("which port?"), "{delivered}");
    assert!(delivered.contains("call respond_to_peer"), "{delivered}");
    assert!(bench.tags(ui).await.contains(&"peer_consult".to_owned()));
    assert_eq!(bench.sessions.peer_request(&request), PeerAnswer::Pending);
    let circle = bench.sessions.ask_peer(api, by_name("ui"), "and yours?").await.expect("asks");
    assert!(declined(circle).contains("circular wait"));
    let waiting = {
        let (sessions, request) = (bench.sessions.clone(), request.clone());
        tokio::spawn(async move { sessions.peer_answer(&request).await })
    };
    let answered = bench.sessions.respond_to_peer(api, "8080").await.expect("answers").expect("someone asked");
    assert_eq!((answered.to_worker.as_str(), answered.to_name.as_deref()), (ui.as_str(), Some("ui")));
    assert_eq!(waiting.await.expect("waits"), PeerAnswer::Answered("8080".into()));
    assert_eq!(bench.sessions.respond_to_peer(api, "again").await, Ok(None), "one answer per question");
    gate.release();
    bench.agents.settled().await;

    // A peer that ends its turn without answering declines by doing so.
    bench.agents.script(Turn::reply("I'd rather not"));
    let ignored = registered(bench.sessions.ask_peer(ui, by_name("api"), "and now?").await.expect("asks"));
    bench.agents.settled().await;
    assert_eq!(
        bench.sessions.peer_request(&ignored),
        PeerAnswer::Declined("peer ended its turn without responding".into())
    );

    // A peer named before it exists is waited for, and asked once it has started.
    let early = registered(bench.sessions.ask_peer(ui, by_name("db"), "schema?").await.expect("asks"));
    assert_eq!(bench.sessions.peer_request(&early), PeerAnswer::Pending);
    bench.agents.script(Turn::reply("ready"));
    let gate = bench.agents.script_held(Turn::reply("looking"));
    let db = bench.member(&boss, "db").await;
    // Its own first turn ends, then the question that waited for it starts the next.
    while !bench.agents.sent(&db).iter().any(|m| m.contains("schema?")) {
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    // A peer that goes away says so to whoever waits on it.
    bench.sessions.kill(&db).await.expect("removes");
    assert_eq!(bench.sessions.peer_request(&early), PeerAnswer::Gone);
    gate.release();

    // Nobody by that name ever joins: the wait ends by itself.
    let never = registered(bench.sessions.ask_peer(ui, by_name("ghost"), "?").await.expect("asks"));
    let waiting = {
        let (sessions, never) = (bench.sessions.clone(), never.clone());
        tokio::spawn(async move { sessions.peer_answer(&never).await })
    };
    while bench.sleeper.pending().is_empty() {
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    bench.clock.advance(10 * 60 * 1000);
    assert!(bench.sleeper.wake(), "the asker waits no longer than the peer may take to join");
    match waiting.await.expect("waits") {
        PeerAnswer::Declined(reason) => assert!(reason.starts_with("no peer matching your request joined"), "{reason}"),
        other => panic!("{other:?}"),
    }
    // What was settled is forgotten after a while; nothing of a removed worker stays.
    bench.clock.advance(10 * 60 * 1000);
    assert_eq!(bench.sessions.peer_request(&never), PeerAnswer::Gone);
    bench.sessions.kill(&boss).await.expect("removes");
    assert_eq!(bench.sessions.tracked_peer_requests(), 0);
}

// A turn that ends while the queue of the turn before it is still being drained.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_idle_edge_that_arrives_during_a_drain_is_settled_afterwards() {
    use eos_core::agent::WorkerSessions;

    let bench = Bench::new();
    bench.agents.script(Turn::reply("done"));
    let id = bench.chat("go").await;
    let (edges, drains) = (bench.hooks.idle.load(Ordering::SeqCst), bench.hooks.drains.load(Ordering::SeqCst));

    // Three edges arrive while one drain has the worker: it looks once more, and the
    // idle edge runs once, after the last look.
    *bench.hooks.edges_mid_drain.lock().expect("edges") = 1;
    WorkerSessions::settled(&bench.sessions, &id).await;
    assert_eq!(bench.hooks.drains.load(Ordering::SeqCst), drains + 2, "the queue is looked at again");
    assert_eq!(bench.hooks.idle.load(Ordering::SeqCst), edges + 1, "one idle edge, not none and not two");

    // Each further edge is one more look: none is dropped however they pile up.
    *bench.hooks.edges_mid_drain.lock().expect("edges") = 3;
    WorkerSessions::settled(&bench.sessions, &id).await;
    assert_eq!(bench.hooks.drains.load(Ordering::SeqCst), drains + 6);
    assert_eq!(bench.hooks.idle.load(Ordering::SeqCst), edges + 2);

    // What the missed edge would have left behind: a message queued for the worker goes out.
    let gate = bench.agents.script_held(Turn::reply("busy"));
    bench.sessions.dispatch(bench.message(&id, "first")).await.expect("sends");
    bench.agents.running(1).await;
    let later = MessageInput { queue_when_busy: true, ..bench.message(&id, "second") };
    assert!(matches!(bench.sessions.dispatch(later).await, Ok(Dispatched::Queued { .. })));
    bench.agents.script(Turn::reply("and done"));
    *bench.hooks.edges_mid_drain.lock().expect("edges") = 1;
    gate.release();
    bench.agents.settled().await;
    assert!(bench.agents.sent(&id).iter().any(|m| m.ends_with("second")), "{:?}", bench.agents.sent(&id));
    let queued = id.clone();
    let left = bench.store().read(move |tx| tx.message_queue().list_pending(&queued)).await.expect("reads");
    assert!(left.is_empty(), "nothing stays queued behind a lost edge");
}

#[tokio::test(flavor = "multi_thread")]
async fn top_level_agents_in_a_turn_are_the_ones_without_a_parent_that_work() {
    use eos_core::net::updates::TopLevelAgents;
    let bench = Bench::new();
    assert_eq!(bench.sessions.working().await, 0);
    bench.temp.exec(
        "INSERT INTO workers (id, state, prompt, started_at, tool_calls, scratch, parent_id) VALUES
           ('w-A', 'WORKING', 'go', 1, 0, 0, NULL),
           ('w-B', 'WORKING', 'go', 1, 0, 0, NULL),
           ('w-IDLE', 'IDLE', 'go', 1, 0, 0, NULL),
           ('w-KID', 'WORKING', 'go', 1, 0, 0, 'w-A'),
           ('w-DONE', 'DONE', 'go', 1, 0, 0, NULL)",
    );
    assert_eq!(bench.sessions.working().await, 2, "a subagent's work and a resting chat do not count");
}
