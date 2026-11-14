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
    user: Arc<FakeUser>,
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
        let user = Arc::new(FakeUser::default());
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
            questions: user.clone(),
            clock: Arc::new(FakeClock::new()),
            secrets: Arc::new(eos_testkit::NoKeychain),
        };
        let engine = Engine::build(options, deps).await.expect("the engine");
        Self { engine, mock, sink: Arc::new(RecordingSink::default()), policy, credentials, user, dir }
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

// Without a sign-in a turn read "Not signed in: not signed in." above a raw error box.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_without_any_credential_says_once_where_to_sign_in() {
    let bench = Bench::new([Reply::text("never asked")]).await;
    *bench.credentials.new_session.lock().expect("credential") = None;
    let session = bench.start(bench.spec("w-1")).await;
    session.send("hello".into()).await.expect("sends");
    let events = bench.after_turns("w-1", 1).await;
    assert_eq!(tags(&events)[2..], ["turn:started", "msg:assistant:text", "usage", "turn:ended"]);
    let texts: Vec<&str> =
        events.iter().filter(|e| e["type"] == "message").filter_map(|e| e["blocks"][0]["text"].as_str()).collect();
    assert_eq!(texts, ["Not signed in · Sign in to Claude under Settings › Accounts"]);
    assert!(bench.mock.requests().is_empty(), "nothing went out");
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

/// Writes Claude Code's transcript of `session` for the bench's project:
/// one prompt and its answer per pair.
fn claude_transcript(bench: &Bench, session: &str, turns: &[(&str, &str)]) -> PathBuf {
    let folder =
        bench.dir.path().join("home/.claude/projects").join(eos_agent_compat::project_dir_name(&bench.project()));
    std::fs::create_dir_all(&folder).expect("a folder");
    let mut lines = String::new();
    let mut parent = Value::Null;
    for (n, (prompt, answer)) in turns.iter().enumerate() {
        let (user, assistant) = (format!("u{n}"), format!("a{n}"));
        let entry = |kind: &str, uuid: &str, parent: Value, message: Value| {
            serde_json::json!({"type": kind, "uuid": uuid, "parentUuid": parent, "sessionId": session,
                               "timestamp": "2026-01-01T00:00:00.000Z", "message": message})
            .to_string()
                + "\n"
        };
        lines += &entry("user", &user, parent, serde_json::json!({"role": "user", "content": prompt}));
        let reply = serde_json::json!({"role": "assistant", "model": "claude-old", "content": [{"type": "text", "text": answer}]});
        lines += &entry("assistant", &assistant, user.into(), reply);
        parent = assistant.into();
    }
    let path = folder.join(format!("{session}.jsonl"));
    std::fs::write(&path, lines).expect("the transcript");
    path
}

// Going back to the TypeScript app resumes the chat from the same Claude Code
// session (the row keeps it), where the turns made here are not. When the
// user goes on there and then comes back, the conversation Claude Code holds
// is the newer one, and the chat continues from it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_chat_the_typescript_app_went_on_with_is_taken_again() {
    let bench = Bench::new([Reply::text("one"), Reply::text("two"), Reply::text("three"), Reply::text("four")]).await;
    let session = "0b8f3c1e-7d2a-4c55-9a51-3e9d2f6a8b10";
    claude_transcript(&bench, session, &[("remember PELICAN", "noted")]);
    let resume =
        |prompt: &str| LaunchSpec { resume: Some(session.into()), prompt: Some(prompt.into()), ..bench.spec("w-old") };

    let first = bench.start(resume("RUST-ONE")).await;
    bench.after_turns("w-old", 1).await;
    first.stop().await;
    let again = bench.start(resume("RUST-TWO")).await;
    bench.after_turns("w-old", 2).await;
    again.stop().await;
    let sent = bench.request_text(1);
    assert!(sent.contains("PELICAN") && sent.contains("RUST-ONE") && sent.contains("RUST-TWO"), "{sent}");

    // Back in the TypeScript app, the chat went on from the Claude Code session.
    claude_transcript(&bench, session, &[("remember PELICAN", "noted"), ("TS-TURN", "answered there")]);
    let back = bench.start(resume("RUST-THREE")).await;
    bench.after_turns("w-old", 3).await;
    let sent = bench.request_text(2);
    assert!(sent.contains("PELICAN") && sent.contains("TS-TURN") && sent.contains("RUST-THREE"), "{sent}");
    assert!(!sent.contains("RUST-ONE"), "the newer conversation is the TypeScript app's: {sent}");

    // A chat cleared here stays cleared: the record is the conversation.
    back.clear_context().await.expect("clears");
    back.stop().await;
    bench.start(resume("RUST-FOUR")).await;
    bench.after_turns("w-old", 4).await;
    let sent = bench.request_text(3);
    assert!(sent.contains("RUST-FOUR") && !sent.contains("PELICAN") && !sent.contains("TS-TURN"), "{sent}");
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_request_outside_any_conversation_answers_text_or_data_on_a_new_sessions_credential() {
    use eos_core::agent::{OneShot, OneShotError, OneShotRequest};

    let bench = Bench::new([
        Reply::text("a summary"),
        Reply::tool_use("t1", "StructuredOutput", r#"{"title":"Fix the parser"}"#),
        Reply::text("late").slowed(Duration::from_millis(400)),
    ])
    .await;
    let asked = OneShotRequest::new("condense this").system("You summarize.").model(Some("mock-model"));
    let answer = bench.engine.complete(asked).await.expect("answers");
    assert_eq!((answer.text.as_str(), answer.structured), ("a summary", None));
    let request = &bench.mock.requests()[0];
    assert_eq!(key_of(request).as_deref(), Some("k-first"));
    let sent = request.json();
    assert!(sent["system"].to_string().contains("You summarize."), "{}", sent["system"]);
    assert!(sent["messages"].to_string().contains("condense this"));
    assert!(sent.get("tools").is_none_or(Value::is_null), "no tools: {}", sent["tools"]);

    let schema =
        serde_json::json!({"type": "object", "properties": {"title": {"type": "string"}}, "required": ["title"]});
    let answer = bench.engine.complete(OneShotRequest::new("name it").schema(schema)).await.expect("answers");
    assert_eq!(answer.structured, Some(serde_json::json!({"title": "Fix the parser"})));

    let slow = bench.engine.complete(OneShotRequest::new("slow").timeout_ms(50)).await;
    assert_eq!(slow, Err(OneShotError::TimedOut(Duration::from_millis(50))));
    assert_eq!(bench.engine.live(), 0, "no session was started for any of it");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_question_reaches_the_user_with_the_call_that_asks_it() {
    let ask = r#"{"questions":[{"question":"Which one?","header":"Pick","multiSelect":false,
        "options":[{"label":"A","description":"the first"},{"label":"B","description":"the second"}]}]}"#;
    let bench = Bench::new([Reply::tool_use("toolu_ask", "AskUserQuestion", ask), Reply::text("going with A")]).await;
    *bench.user.answers.lock().expect("answers") =
        Some([("Which one?".to_owned(), serde_json::json!("A"))].into_iter().collect());
    let spec = LaunchSpec { role: eos_contracts::SessionFactsRole::Focused, ..bench.spec("w-q") };
    let session = bench.start(spec).await;
    session.send("ask me".into()).await.expect("sends");
    bench.after_turns("w-q", 1).await;
    assert_eq!(*bench.user.calls.lock().expect("calls"), [Some("toolu_ask".to_owned())]);
    assert!(bench.request_text(1).contains("Which one?"), "the answer went back to the model");
}

/// The audit's sequence: a turn, a compaction, the next message, a rewind to
/// that message, the message after it. As under TypeScript (the summary was
/// the new session's seed, pushed with `shouldQuery: false`), the summary
/// comes before the next message, a rewind to that message keeps it, and it
/// is no rewind target of its own.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rewind_to_the_first_message_after_a_compaction_keeps_the_summary() {
    let bench = Bench::new([Reply::text("read it"), Reply::text("two"), Reply::text("three")]).await;
    let session = bench.start(bench.spec("w-1")).await;
    session.send("read a.py".into()).await.expect("sends");
    bench.after_turns("w-1", 1).await;
    session.replace_context("SUMMARY: a.py was read".into()).await.expect("replaces");
    session.send("NEXT-ONE".into()).await.expect("sends");
    bench.after_turns("w-1", 2).await;
    let sent = bench.request_text(1);
    let at = |text: &str| sent.find(text).unwrap_or_else(|| panic!("{text} missing: {sent}"));
    assert!(at("SUMMARY: a.py was read") < at("NEXT-ONE") && !sent.contains("read a.py"), "{sent}");

    let targets = session.rewind_targets().await.expect("targets");
    let prompts: Vec<&str> = targets.iter().map(|t| t.text.as_str()).collect();
    assert_eq!(prompts, ["NEXT-ONE"], "the summary is not a prompt");
    session.rewind(&targets[0].uuid, eos_contracts::RewindMode::Both).await.expect("rewinds");
    session.send("NEXT-TWO".into()).await.expect("sends");
    bench.after_turns("w-1", 3).await;

    let sent = bench.request_text(2);
    let at = |text: &str| sent.find(text).unwrap_or_else(|| panic!("{text} missing: {sent}"));
    assert!(at("SUMMARY: a.py was read") < at("NEXT-TWO") && !sent.contains("NEXT-ONE"), "{sent}");
    let transcript = session.read_transcript().await.expect("reads").expect("a conversation");
    assert_eq!(transcript.entries[0], TranscriptEntry::User { text: "SUMMARY: a.py was read".into() });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_outside_the_project_is_read_when_eos_policy_allows_it() {
    // What the dashboard leaves for a pasted attachment: a folder of its own in the temp folder.
    let pasted = tempfile::Builder::new().prefix("eos-paste-").tempdir().expect("the paste folder");
    let file = pasted.path().canonicalize().expect("the folder").join("note.txt");
    std::fs::write(&file, "pasted words").expect("the attachment");
    let read = serde_json::json!({ "file_path": file }).to_string();
    let glob = serde_json::json!({ "pattern": "*.txt", "path": "../home" }).to_string();
    let bench = Bench::new([
        Reply::tool_use("t1", "Read", &read),
        Reply::tool_use("t2", "Glob", &glob),
        Reply::tool_use("t3", "Read", &read),
        Reply::text("read it"),
    ])
    .await;
    bench.policy.deny.lock().expect("deny").push("Glob".into());
    let session = bench.start(bench.spec("w-1")).await;
    session.send("what did I paste?".into()).await.expect("sends");
    let events = bench.after_turns("w-1", 1).await;

    let results: Vec<&Value> = events.iter().filter(|e| e["role"] == "tool").map(|e| &e["blocks"][0]).collect();
    assert_ne!(results[0]["isError"], true, "{}", results[0]);
    assert!(results[0]["content"].as_str().is_some_and(|c| c.contains("pasted words")), "{}", results[0]);
    assert_eq!(results[1]["content"], "Glob is denied by policy", "the policy is the only check on reads");

    let asked = bench.policy.asked.lock().expect("asked");
    assert_eq!(asked[0].input.get("file_path").and_then(Value::as_str), file.to_str());
    let searched = asked[1].input.get("path").and_then(Value::as_str).expect("the search folder");
    assert!(searched.starts_with('/') && searched.ends_with("home"), "made absolute for the policy: {searched}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_idle_agent_is_woken_by_its_own_background_command() {
    let command = r#"{"command":"sleep 0.3; echo built","description":"Build","run_in_background":true}"#;
    let bench =
        Bench::new([Reply::tool_use("t1", "Bash", command), Reply::text("started it"), Reply::text("it built")]).await;
    let session = bench.start(bench.spec("w-1")).await;
    session.send("build it".into()).await.expect("sends");
    let events = bench.after_turns("w-1", 2).await;

    // The second turn is the engine's: no message of the host started it.
    let turns: Vec<&str> =
        events.iter().filter(|e| e["type"] == "turn").map(|e| e["phase"].as_str().unwrap_or_default()).collect();
    assert_eq!(turns, ["started", "ended", "started", "ended"]);
    let answers: Vec<&Value> = events.iter().filter(|e| e["role"] == "assistant").map(|e| &e["blocks"][0]).collect();
    assert_eq!(answers.last().map(|b| &b["text"]), Some(&Value::from("it built")));
    assert!(bench.request_text(2).contains("task-notification"), "the wake turn reads the command's note");
    let tasks = bench.sink.tasks.lock().expect("tasks");
    let ended = tasks.iter().filter(|t| matches!(t, eos_core::agent::BackgroundTaskUpdate::Ended { .. })).count();
    assert_eq!(ended, 1, "the job ends once");
    drop(tasks);
    assert_eq!(session.live_subagents(), 0);
}
