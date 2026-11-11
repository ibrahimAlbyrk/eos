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
use eos_sessions::{Dispatched, MessageInput, SessionDeps, SessionHooks, Sessions, SpawnRequest};
use eos_testkit::agent::Call;
use eos_testkit::{
    FakeClock, FakeConfig, FakeModelCatalog, FakePrompts, FakeRecents, FakeWorktrees, ScriptedRuntime, SeqIds,
    TempStore, Turn,
};
use serde_json::Value;

#[derive(Default)]
struct Hooks {
    idle: AtomicUsize,
    deltas: AtomicUsize,
    held: std::sync::Mutex<Vec<String>>,
    removed: std::sync::Mutex<Vec<String>>,
    missing_folders: std::sync::Mutex<Vec<String>>,
}

impl SessionHooks for Hooks {
    fn delta(&self, _worker_id: &str, _delta: &eos_contracts::DeltaEvent) {
        self.deltas.fetch_add(1, Ordering::SeqCst);
    }

    fn holds_worker(&self, worker_id: &str) -> bool {
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
}

impl Bench {
    fn new() -> Self {
        let temp = TempStore::new();
        let agents = ScriptedRuntime::new();
        let hooks = Arc::new(Hooks::default());
        let prompts = Arc::new(FakePrompts::default());
        let worktrees = Arc::new(FakeWorktrees::default());
        let recents = Arc::new(FakeRecents::default());
        let sessions = Sessions::new(SessionDeps {
            store: temp.port(),
            runtime: agents.port(),
            clock: Arc::new(FakeClock::new()),
            ids: Arc::new(SeqIds::new()),
            config: Arc::new(FakeConfig::default()),
            models: Arc::new(FakeModelCatalog::default()),
            prompts: prompts.clone(),
            worktrees: worktrees.clone(),
            recents: recents.clone(),
            hooks: hooks.clone(),
        });
        Self { sessions, agents, temp, hooks, prompts, worktrees, recents }
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
