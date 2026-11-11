//! The engine end to end against a scripted model API: sessions start, run
//! turns, call tools through Eos's policy, stop, resume and continue old
//! chats. No real model is called and no real credential is read.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use eos_agent_mock_api::{MockApi, Reply};
use eos_core::Error;
use eos_core::accounts::{PlanFailure, PlanVerdict, SessionAccountSwitch, SessionCredential};
use eos_core::agent::{AgentRuntime, AgentSession, LaunchSpec, SessionError, TranscriptEntry};
use eos_engine::{Engine, EngineDeps, EngineOptions};
use eos_testkit::{EchoTool, FakeClock, FakeCredentials, FakePolicy, FakeToolSets, FakeUser, RecordingSink};
use serde_json::Value;

const TOOL: &str = "mcp__worker__whoami";

struct Bench {
    engine: Engine,
    mock: MockApi,
    sink: Arc<RecordingSink>,
    policy: Arc<FakePolicy>,
    credentials: Arc<FakeCredentials>,
    dir: tempfile::TempDir,
}

impl Bench {
    async fn new(replies: impl IntoIterator<Item = Reply>) -> Self {
        let mock = MockApi::start(replies).await.expect("the mock API");
        let dir = tempfile::tempdir().expect("a folder");
        for sub in ["home", "project"] {
            std::fs::create_dir_all(dir.path().join(sub)).expect("a folder");
        }
        let policy = Arc::new(FakePolicy::default());
        let credentials = Arc::new(FakeCredentials::with_key("k-first"));
        let options = EngineOptions {
            default_model: Some("mock-model".into()),
            base_url: Some(mock.base_url()),
            claude_home: Some(dir.path().join("home")),
            mcp: false,
            ..EngineOptions::new(dir.path().join("engine"))
        };
        let deps = EngineDeps {
            policy: policy.clone(),
            tools: Arc::new(FakeToolSets(vec![EchoTool::named(TOOL)])),
            credentials: credentials.clone(),
            questions: Arc::new(FakeUser::default()),
            clock: Arc::new(FakeClock::new()),
        };
        let engine = Engine::build(options, deps).await.expect("the engine");
        Self { engine, mock, sink: Arc::new(RecordingSink::default()), policy, credentials, dir }
    }

    fn project(&self) -> PathBuf {
        self.dir.path().join("project").canonicalize().expect("the project")
    }

    fn spec(&self, worker: &str) -> LaunchSpec {
        LaunchSpec::new(worker, self.project().to_string_lossy(), "mock-model")
    }

    async fn start(&self, spec: LaunchSpec) -> Arc<dyn AgentSession> {
        self.engine.start(spec, self.sink.clone()).await.expect("the session starts")
    }

    /// The worker's events once `turns` turns have ended (in any way).
    async fn after_turns(&self, worker: &str, turns: usize) -> Vec<Value> {
        let ended = |events: &[Value]| {
            events.iter().filter(|e| e["type"] == "turn" && e["phase"] != "started").count() >= turns
        };
        match tokio::time::timeout(Duration::from_secs(30), self.sink.until(worker, ended)).await {
            Ok(events) => events,
            Err(_) => panic!("turn {turns} did not end; so far: {:?}", tags(&self.sink.json(worker))),
        }
    }

    /// The text of every message of the `n`th request the model got.
    fn request_text(&self, n: usize) -> String {
        self.mock.requests()[n].json()["messages"].to_string()
    }
}

/// The API key a request went out on.
fn key_of(request: &eos_agent_mock_api::Recorded) -> Option<String> {
    request.headers.get("x-api-key").and_then(|v| v.to_str().ok()).map(str::to_owned)
}

fn tags(events: &[Value]) -> Vec<String> {
    let s = |e: &Value, key: &str| e[key].as_str().unwrap_or_default().to_owned();
    events
        .iter()
        .filter(|e| e["type"] != "delta" && e["type"] != "context")
        .map(|e| match e["type"].as_str() {
            Some(kind @ ("turn" | "session")) => format!("{kind}:{}", s(e, "phase")),
            Some("message") => format!("msg:{}:{}", s(e, "role"), s(&e["blocks"][0], "type")),
            other => other.unwrap_or_default().to_owned(),
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_streams_is_recorded_and_billed() {
    let bench = Bench::new([Reply::text("hello there")]).await;
    let spec =
        LaunchSpec { prompt: Some("say hi".into()), system_prompt: Some("EOS RULES".into()), ..bench.spec("w-1") };
    let session = bench.start(spec).await;
    let events = bench.after_turns("w-1", 1).await;

    assert_eq!(
        tags(&events),
        ["session:started", "session:ready", "turn:started", "msg:assistant:text", "usage", "turn:ended"]
    );
    assert_eq!(events[1]["sessionId"], "w-1", "the conversation is recorded under the worker's id");
    let deltas: Vec<&Value> = events.iter().filter(|e| e["type"] == "delta").collect();
    let message = events.iter().find(|e| e["type"] == "message").expect("the answer");
    assert_eq!(message["blocks"][0]["text"], "hello there");
    assert_eq!(deltas[0]["blockId"], message["blocks"][0]["blockId"], "live and recorded text share one id");
    assert_eq!(deltas[0]["phase"], "start");

    let request = bench.mock.requests()[0].json();
    assert!(request["system"].to_string().contains("EOS RULES"), "Eos's prompt follows the engine's own");
    let tools: Vec<&str> =
        request["tools"].as_array().expect("tools").iter().filter_map(|t| t["name"].as_str()).collect();
    assert!(tools.contains(&TOOL) && tools.contains(&"Bash"), "{tools:?}");
    assert!(!tools.contains(&"AskUserQuestion") && !tools.contains(&"Workflow"), "blocked for a worker: {tools:?}");
    assert!(!tools.contains(&"ToolSearch"), "a worker gets every tool in full");
    assert_eq!(key_of(&bench.mock.requests()[0]).as_deref(), Some("k-first"));
    assert_eq!(bench.credentials.launched.lock().expect("launched")[0].0, "w-1");

    assert!(session.is_alive());
    assert_eq!(session.live_subagents(), 0);
    let transcript = session.read_transcript().await.expect("reads").expect("a conversation");
    assert_eq!(transcript.entries.last(), Some(&TranscriptEntry::Assistant { text: "hello there".into() }));
    assert!(transcript.path.expect("a path").ends_with("engine/transcripts/w-1.jsonl"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tool_call_goes_through_the_policy_to_eos_and_back() {
    let bench = Bench::new([
        Reply::tool_use("t1", TOOL, r#"{"note":"hi"}"#),
        Reply::tool_use("t2", "Read", r#"{"file_path":"/nope"}"#),
        Reply::text("done"),
    ])
    .await;
    bench.policy.deny.lock().expect("deny").push("Read".into());
    let session = bench.start(bench.spec("w-1")).await;
    session.send("go".into()).await.expect("sends");
    let events = bench.after_turns("w-1", 1).await;

    assert_eq!(
        tags(&events)[2..],
        [
            "turn:started",
            "msg:assistant:tool_call",
            "msg:tool:tool_result",
            "msg:assistant:tool_call",
            "msg:tool:tool_result",
            "msg:assistant:text",
            "usage",
            "turn:ended"
        ]
    );
    let results: Vec<&Value> = events.iter().filter(|e| e["role"] == "tool").map(|e| &e["blocks"][0]).collect();
    assert_eq!(results[0]["content"], r#"worker=w-1 call=t1 input={"note":"hi"}"#);
    assert_eq!(
        (results[1]["isError"].as_bool(), results[1]["content"].as_str()),
        (Some(true), Some("Read is denied by policy"))
    );

    let asked = bench.policy.asked.lock().expect("asked");
    let seen: Vec<(&str, &str, bool, bool)> = asked
        .iter()
        .map(|c| (c.worker_id.as_str(), c.tool_name.as_str(), c.agent_id.is_some(), c.full_surface))
        .collect();
    assert_eq!(seen, [("w-1", TOOL, false, false), ("w-1", "Read", false, false)]);
    assert_eq!(asked[0].tool_use_id.as_deref(), Some("t1"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_focused_session_keeps_the_full_tool_surface() {
    let bench = Bench::new([Reply::tool_use("t1", TOOL, "{}"), Reply::text("ok")]).await;
    let spec = LaunchSpec { role: eos_contracts::SessionFactsRole::Focused, ..bench.spec("w-f") };
    let session = bench.start(spec).await;
    session.send("go".into()).await.expect("sends");
    bench.after_turns("w-f", 1).await;
    let request = bench.mock.requests()[0].json();
    let tools: Vec<&str> =
        request["tools"].as_array().expect("tools").iter().filter_map(|t| t["name"].as_str()).collect();
    assert!(tools.contains(&"AskUserQuestion") && tools.contains(&"Agent"), "{tools:?}");
    assert!(bench.policy.asked.lock().expect("asked")[0].full_surface);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_interrupt_ends_the_turn_as_aborted_and_the_session_goes_on() {
    // Each step of the first answer takes a while, so the interrupt lands mid-answer.
    let bench = Bench::new([Reply::text("slow answer").slowed(Duration::from_millis(400)), Reply::text("quick")]).await;
    let session = bench.start(bench.spec("w-1")).await;
    session.send("take your time".into()).await.expect("sends");
    bench.sink.until("w-1", |events| events.iter().any(|e| e["type"] == "delta")).await;
    session.interrupt().await;
    let events = bench.after_turns("w-1", 1).await;
    // What had streamed stays in the conversation, so it is recorded.
    assert_eq!(tags(&events)[2..], ["turn:started", "msg:assistant:text", "usage", "turn:aborted"]);
    assert_eq!(
        events.iter().find(|e| e["type"] == "message").expect("the cut answer")["blocks"][0]["text"],
        "slow answer"
    );
    assert_eq!(events.last().expect("the end")["reason"], "interrupted");

    session.send("again".into()).await.expect("sends");
    let events = bench.after_turns("w-1", 2).await;
    assert_eq!(events.last().expect("the end")["phase"], "ended");
    assert!(events.iter().any(|e| e["blocks"][0]["text"] == "quick"));
    assert!(bench.request_text(1).contains("slow answer"), "the model remembers what it had said");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_request_tells_the_user_and_ends_the_turn_in_an_error() {
    let refused = Reply::Status {
        status: 400,
        headers: Vec::new(),
        body: r#"{"type":"error","error":{"type":"invalid_request_error","message":"bad request"}}"#.into(),
    };
    let bench = Bench::new([refused, Reply::text("fine now")]).await;
    let session = bench.start(bench.spec("w-1")).await;
    session.send("go".into()).await.expect("sends");
    let events = bench.after_turns("w-1", 1).await;
    assert_eq!(tags(&events)[2..], ["turn:started", "msg:assistant:text", "usage", "turn:error"]);
    let notice = events.iter().find(|e| e["type"] == "message").expect("the notice");
    assert!(notice["blocks"][0]["text"].as_str().expect("text").contains("bad request"), "{notice}");
    assert_eq!(events.last().expect("the end")["reason"], "error_during_execution");

    // The session survives a failed turn.
    session.send("again".into()).await.expect("sends");
    assert_eq!(bench.after_turns("w-1", 2).await.last().expect("the end")["phase"], "ended");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stopped_session_exits_and_its_conversation_resumes() {
    let bench = Bench::new([Reply::text("the codename is BLUEFIN"), Reply::text("as I said")]).await;
    let session = bench.start(LaunchSpec { prompt: Some("pick a codename".into()), ..bench.spec("w-1") }).await;
    bench.after_turns("w-1", 1).await;

    session.stop().await;
    assert_eq!(*bench.sink.exits.lock().expect("exits"), [("w-1".to_owned(), Some(143))]);
    assert!(!session.is_alive());
    assert_eq!(bench.engine.live(), 0);
    assert!(bench.engine.session("w-1").is_none());
    assert_eq!(session.send("late".into()).await, Err(SessionError::Gone));
    assert_eq!(session.read_transcript().await, Err(SessionError::Gone));
    session.stop().await;
    assert_eq!(bench.sink.exits.lock().expect("exits").len(), 1, "stopping twice reports one exit");
    let launched = bench.credentials.launched.lock().expect("launched").clone();
    assert_eq!(launched.last(), Some(&("w-1".to_owned(), None)), "its credential is released");

    // The row's session id is the worker's own: the engine recorded the conversation.
    let resumed = LaunchSpec { resume: Some("w-1".into()), prompt: Some("which one?".into()), ..bench.spec("w-1") };
    bench.start(resumed).await;
    bench.after_turns("w-1", 2).await;
    let second = bench.request_text(1);
    assert!(
        second.contains("pick a codename") && second.contains("BLUEFIN") && second.contains("which one?"),
        "{second}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_old_chat_continues_from_the_transcript_claude_code_wrote() {
    let bench = Bench::new([Reply::text("yes, PELICAN")]).await;
    // What Claude Code recorded for the session, under its own projects folder.
    let project = bench.project();
    let folder = bench.dir.path().join("home/.claude/projects").join(eos_agent_compat::project_dir_name(&project));
    std::fs::create_dir_all(&folder).expect("a folder");
    let entry = |kind: &str, uuid: &str, parent: Value, message: Value| {
        serde_json::json!({"type": kind, "uuid": uuid, "parentUuid": parent, "sessionId": "sess-old",
                           "timestamp": "2026-01-01T00:00:00.000Z", "message": message})
        .to_string()
    };
    let lines = [
        entry("user", "u1", Value::Null, serde_json::json!({"role": "user", "content": "remember PELICAN"})),
        entry(
            "assistant",
            "a1",
            "u1".into(),
            serde_json::json!({"role": "assistant", "model": "claude-old", "content": [{"type": "text", "text": "noted"}]}),
        ),
    ];
    std::fs::write(folder.join("sess-old.jsonl"), lines.join("\n") + "\n").expect("the transcript");

    let spec =
        LaunchSpec { resume: Some("sess-old".into()), prompt: Some("what was it?".into()), ..bench.spec("w-old") };
    let session = bench.start(spec).await;
    let events = bench.after_turns("w-old", 1).await;
    assert_eq!(events[1]["sessionId"], "w-old", "from now on the engine's own record is the conversation");
    let sent = bench.request_text(0);
    assert!(sent.contains("remember PELICAN") && sent.contains("noted") && sent.contains("what was it?"), "{sent}");
    let targets = session.rewind_targets().await.expect("targets");
    let prompts: Vec<&str> = targets.iter().map(|t| t.text.as_str()).collect();
    assert_eq!(prompts, ["remember PELICAN", "what was it?"]);

    // A chat whose transcript is gone cannot be continued; nothing is started.
    let missing = LaunchSpec { resume: Some("sess-gone".into()), ..bench.spec("w-gone") };
    let refused = bench.engine.start(missing, bench.sink.clone()).await.err();
    assert!(matches!(refused, Some(Error::Rule(_))), "{refused:?}");
    assert!(bench.engine.session("w-gone").is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_conversation_can_be_cut_back_cleared_and_replaced() {
    let bench = Bench::new([Reply::text("one"), Reply::text("two"), Reply::text("three"), Reply::text("four")]).await;
    let session = bench.start(bench.spec("w-1")).await;
    session.send("ALPHA-ONE".into()).await.expect("sends");
    bench.after_turns("w-1", 1).await;
    session.send("BETA-TWO".into()).await.expect("sends");
    bench.after_turns("w-1", 2).await;

    let targets = session.rewind_targets().await.expect("targets");
    assert_eq!(
        targets.iter().map(|t| (t.text.as_str(), t.up_count)).collect::<Vec<_>>(),
        [("ALPHA-ONE", 2), ("BETA-TWO", 1)]
    );
    let code_only = session.rewind(&targets[1].uuid, eos_contracts::RewindMode::Code).await;
    assert_eq!(code_only.err().map(|e| e.to_string()).as_deref(), Some("file rewind unavailable on this session"));
    let back = session.rewind(&targets[1].uuid, eos_contracts::RewindMode::Both).await.expect("rewinds");
    assert_eq!((back.text.as_str(), back.index), ("BETA-TWO", 1));
    session.send("GAMMA-THREE".into()).await.expect("sends");
    bench.after_turns("w-1", 3).await;
    let sent = bench.request_text(2);
    assert!(sent.contains("ALPHA-ONE") && sent.contains("GAMMA-THREE") && !sent.contains("BETA-TWO"), "{sent}");

    // Taking back the last prompt, then replacing everything with a summary.
    session.recall_last_user_turn().await.expect("recalls");
    let left: Vec<String> = session.rewind_targets().await.expect("targets").into_iter().map(|t| t.text).collect();
    assert_eq!(left, ["ALPHA-ONE"]);
    session.replace_context("SUMMARY OF THE WORK".into()).await.expect("replaces");
    session.send("carry on".into()).await.expect("sends");
    bench.after_turns("w-1", 4).await;
    let sent = bench.request_text(3);
    assert!(sent.contains("SUMMARY OF THE WORK") && sent.contains("carry on") && !sent.contains("ALPHA-ONE"), "{sent}");

    session.clear_context().await.expect("clears");
    assert_eq!(session.read_transcript().await.expect("reads"), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_credential_that_runs_out_is_replaced_or_ends_the_turn_quietly() {
    let limit = || Reply::Status {
        status: 429,
        headers: vec![
            ("anthropic-ratelimit-unified-status".into(), "rejected".into()),
            ("anthropic-ratelimit-unified-reset".into(), "1794416400".into()),
        ],
        body: r#"{"type":"error","error":{"type":"rate_limit_error","message":"limit"}}"#.into(),
    };
    let bench = Bench::new([limit(), Reply::text("on the spare"), limit(), Reply::text("on the key")]).await;
    let spare = SessionCredential::ApiKey { provider: "anthropic".into(), key: "k-spare".into() };
    bench
        .credentials
        .verdicts
        .lock()
        .expect("verdicts")
        .extend([PlanVerdict::Switch(spare.clone()), PlanVerdict::Exhausted]);
    let session = bench.start(bench.spec("w-1")).await;

    // Another credential is ready: the same request goes out again, the turn carries on.
    session.send("go".into()).await.expect("sends");
    let events = bench.after_turns("w-1", 1).await;
    assert_eq!(tags(&events)[2..], ["turn:started", "msg:assistant:text", "usage", "turn:ended"]);
    let keys: Vec<Option<String>> = bench.mock.requests().iter().map(key_of).collect();
    assert_eq!(keys, [Some("k-first".to_owned()), Some("k-spare".to_owned())]);
    let failures = bench.credentials.failures.lock().expect("failures").clone();
    let PlanFailure::LimitReached(limits) = &failures[0].1 else { panic!("a limit: {failures:?}") };
    assert_eq!((failures[0].0.as_str(), limits.resets_at_ms), ("w-1", Some(1_794_416_400_000)));
    assert_eq!(bench.credentials.launched.lock().expect("launched").last(), Some(&("w-1".to_owned(), Some(spare))));

    // Nothing else is ready: the accounts feature tells the user, the turn ends without a notice.
    session.send("more".into()).await.expect("sends");
    let events = bench.after_turns("w-1", 2).await;
    assert_eq!(tags(&events)[6..], ["turn:started", "usage", "turn:error"]);

    // "Use API key": the session moves and runs the cut-off turn again, with no new message.
    let key = SessionCredential::ApiKey { provider: "anthropic".into(), key: "k-own".into() };
    bench.engine.move_session("w-1", key).await.expect("moves");
    let events = bench.after_turns("w-1", 3).await;
    assert_eq!(tags(&events)[9..], ["turn:started", "msg:assistant:text", "usage", "turn:ended"]);
    assert_eq!(key_of(bench.mock.requests().last().expect("a request")).as_deref(), Some("k-own"));
    let moved = bench
        .engine
        .move_session("w-none", SessionCredential::ApiKey { provider: "anthropic".into(), key: "x".into() });
    assert_eq!(moved.await.err().as_deref(), Some("this agent can't change account right now"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_worker_has_one_session_at_a_time() {
    let bench = Bench::new([]).await;
    bench.start(bench.spec("w-1")).await;
    let again = bench.engine.start(bench.spec("w-1"), bench.sink.clone()).await.err();
    assert!(matches!(again, Some(Error::Conflict(_))), "{again:?}");
    assert_eq!(bench.engine.live(), 1);
}
