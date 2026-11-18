//! The engine end to end against a scripted model API: sessions start, run
//! turns, call tools through Eos's policy, stop, resume and continue old
//! chats. No real model is called and no real credential is read.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use eos_agent_mock_api::{MockApi, Output, Reply};
use eos_core::Error;
use eos_core::accounts::{AfterMove, PlanFailure, PlanVerdict, SessionAccountSwitch, SessionCredential};
use eos_core::agent::{AgentRuntime, AgentSession, BackendCatalog, CompactionNotice, LaunchSpec, SessionError};
use eos_engine::{Engine, EngineDeps, EngineOptions, LazyEngine};
use eos_testkit::{EchoTool, FakeClock, FakeCredentials, FakePolicy, FakeToolSets, FakeUser, RecordingSink};
use serde_json::Value;

const TOOL: &str = "whoami";
const QUIET: &str = "no_reply";

/// A tool whose result ends the agent's turn.
struct Quiet(eos_core::agent::ToolDefinition);

impl eos_core::agent::HostTool for Quiet {
    fn definition(&self) -> &eos_core::agent::ToolDefinition {
        &self.0
    }

    fn call<'a>(
        &'a self,
        _caller: eos_core::agent::ToolCaller<'a>,
        _input: Value,
    ) -> eos_core::BoxFuture<'a, eos_core::agent::ToolReply> {
        Box::pin(std::future::ready(eos_core::agent::ToolReply::text("Turn ended without a reply.").ending_turn()))
    }
}

fn quiet() -> Arc<dyn eos_core::agent::HostTool> {
    Arc::new(Quiet(eos_core::agent::ToolDefinition {
        name: QUIET.to_owned(),
        description: "Ends the turn.".to_owned(),
        input_schema: serde_json::json!({"type": "object", "properties": {}}),
        deferred: false,
        search_hint: None,
        main_agent_only: true,
    }))
}

const HELD: &str = "hold";

/// A tool that runs until the test lets it end, so a turn can be caught between two requests.
struct Held {
    definition: eos_core::agent::ToolDefinition,
    started: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

impl Held {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            definition: eos_core::agent::ToolDefinition {
                name: HELD.to_owned(),
                description: "Waits.".to_owned(),
                input_schema: serde_json::json!({"type": "object", "properties": {}}),
                deferred: false,
                search_hint: None,
                main_agent_only: false,
            },
            started: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
        })
    }
}

impl eos_core::agent::HostTool for Held {
    fn definition(&self) -> &eos_core::agent::ToolDefinition {
        &self.definition
    }

    fn call<'a>(
        &'a self,
        _caller: eos_core::agent::ToolCaller<'a>,
        _input: Value,
    ) -> eos_core::BoxFuture<'a, eos_core::agent::ToolReply> {
        Box::pin(async move {
            self.started.notify_one();
            self.release.notified().await;
            eos_core::agent::ToolReply::text("held done")
        })
    }
}

/// A note as the callers of `note` wrap it.
fn reminder(text: &str) -> String {
    format!("<system-reminder>{text}</system-reminder>")
}

struct Bench {
    engine: Engine,
    /// What a second engine over the same folder is built from.
    setup: (EngineOptions, EngineDeps),
    keychain: Arc<eos_testkit::MemoryKeychain>,
    mock: MockApi,
    sink: Arc<RecordingSink>,
    policy: Arc<FakePolicy>,
    credentials: Arc<FakeCredentials>,
    user: Arc<FakeUser>,
    dir: tempfile::TempDir,
}

impl Bench {
    async fn new(replies: impl IntoIterator<Item = Reply>) -> Self {
        Self::in_dir(tempfile::tempdir().expect("a folder"), replies).await
    }

    /// The bench with `dir` as its data folder.
    async fn in_dir(dir: tempfile::TempDir, replies: impl IntoIterator<Item = Reply>) -> Self {
        Self::with_mock(dir, MockApi::start(replies).await.expect("the mock API")).await
    }

    /// The bench over a mock of the test's own.
    async fn with_mock(dir: tempfile::TempDir, mock: MockApi) -> Self {
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
            protected: eos_platform::DataPaths::new(dir.path()).agent_protected(),
            ..EngineOptions::new(dir.path().join("engine"))
        };
        // Providers reached with a key: the mock, as `deep`, and as the
        // OpenAI preset (no key until a test saves one).
        let config = serde_json::json!({"backends": {"deep": {
            "kind": "openai", "model": "chat-1", "baseUrl": mock.base_url(),
            "auth": {"kind": "keychain", "ref": "eos-deep"},
            "capabilities": {"wire": "openai-chat", "contextWindow": 64_000},
        }, "openai": {
            "kind": "openai", "model": "gpt-5.5", "baseUrl": mock.base_url(),
            "auth": {"kind": "keychain", "ref": "eos-openai"},
            "capabilities": {"wire": "openai-chat", "reasoning": "openai-effort", "contextWindow": 400_000,
                "dropReasoningEffortWithTools": true},
        }}});
        let keychain = Arc::new(eos_testkit::MemoryKeychain::with("eos-deep", "k-deep"));
        let deps = EngineDeps {
            policy: policy.clone(),
            tools: Arc::new(FakeToolSets(vec![EchoTool::named(TOOL), quiet()])),
            credentials: credentials.clone(),
            questions: user.clone(),
            clock: Arc::new(FakeClock::new()),
            secrets: keychain.clone(),
            compaction: Arc::new(eos_testkit::PlainCompactionWords),
            artifacts: Arc::new(eos_testkit::NoArtifactViewer),
            config: Arc::new(eos_testkit::FakeConfig::new(config)),
        };
        let setup = (options.clone(), deps.clone());
        let engine = Engine::build(options, deps).await.expect("the engine");
        Self { engine, setup, keychain, mock, sink: Arc::new(RecordingSink::default()), policy, credentials, user, dir }
    }

    /// An engine that is built when it is first needed, as the app holds it.
    fn lazy(&self) -> LazyEngine {
        LazyEngine::new(self.setup.0.clone(), self.setup.1.clone())
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

    /// A second engine over the same folder and mock, with `held` among its tools.
    async fn holding(&self, held: &Arc<Held>) -> Engine {
        let tools: Vec<Arc<dyn eos_core::agent::HostTool>> = vec![EchoTool::named(TOOL), held.clone()];
        let deps = EngineDeps { tools: Arc::new(FakeToolSets(tools)), ..self.setup.1.clone() };
        Engine::build(self.setup.0.clone(), deps).await.expect("the engine")
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
    assert!(!tools.contains(&"Artifact"), "a worker publishes nothing itself: {tools:?}");
    assert_eq!(key_of(&bench.mock.requests()[0]).as_deref(), Some("k-first"));
    assert_eq!(bench.credentials.launched.lock().expect("launched")[0].0, "w-1");

    assert!(session.is_alive());
    assert_eq!(session.live_subagents(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_model_of_another_provider_moves_the_conversation_there_and_back() {
    let bench = Bench::new([
        Reply::thought("Greet.", "CLAUDE-SIG", "hello from Claude"),
        Reply::responses_text("hello from GPT"),
        Reply::text("Claude again"),
    ])
    .await;
    let session = bench.start(LaunchSpec { prompt: Some("one".into()), ..bench.spec("w-1") }).await;
    bench.after_turns("w-1", 1).await;

    session.set_model("gpt-5", None, None).await.expect("onto OpenAI");
    session.send("two".into()).await.expect("sent");
    bench.after_turns("w-1", 2).await;
    session.set_model("mock-model", None, None).await.expect("back onto Claude");
    session.send("three".into()).await.expect("sent");
    let events = bench.after_turns("w-1", 3).await;

    let sent = bench.mock.requests();
    let paths: Vec<&str> = sent.iter().map(|r| r.path.as_str()).collect();
    assert_eq!(paths, ["/v1/messages", "/v1/responses", "/v1/messages"]);
    let to_gpt = sent[1].json()["input"].to_string();
    assert!(to_gpt.contains("hello from Claude") && !to_gpt.contains("CLAUDE-SIG"), "{to_gpt}");
    let bearer = sent[1].headers.get("authorization").and_then(|v| v.to_str().ok());
    assert_eq!(bearer, Some("Bearer k-first"), "on what a new session of that provider starts on");
    let back = bench.request_text(2);
    assert!(back.contains("CLAUDE-SIG") && back.contains("hello from GPT"), "Claude reads its own reasoning: {back}");
    let said: Vec<&str> =
        events.iter().filter(|e| e["type"] == "message").filter_map(|e| e["blocks"][0]["text"].as_str()).collect();
    assert!(said.contains(&"hello from GPT") && said.contains(&"Claude again"), "{said:?}");
    let launched: Vec<String> =
        bench.credentials.launched.lock().expect("launched").iter().map(|l| l.0.clone()).collect();
    assert_eq!(launched, ["w-1", "w-1", "w-1"], "the accounts feature hears each move");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_chatgpt_accounts_models_are_listed_with_their_windows() {
    use eos_platform::CredentialStore;
    let bench = Bench::new([]).await;
    bench.keychain.delete_secret("eos-deep");
    bench.mock.set_models(serde_json::json!({"models": [
        {"slug": "gpt-6-sol", "display_name": "GPT-6 Sol", "visibility": "list", "context_window": 400_000,
         "default_reasoning_level": "medium", "supported_reasoning_levels": ["low", "medium", "high"]},
        {"slug": "gpt-hidden", "visibility": "hide"},
    ]}));
    let providers = bench.lazy().providers().await;
    let chatgpt = &providers[0];
    assert_eq!((chatgpt.id.as_str(), chatgpt.label.as_str(), chatgpt.ready), ("openai", "ChatGPT", true));
    let ids: Vec<&str> = chatgpt.models.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, ["gpt-6-sol"], "only what the account offers");
    assert_eq!(chatgpt.models[0].display_name, "GPT-6 Sol");
    assert_eq!(chatgpt.models[0].context_window, Some(400_000));
    assert_eq!(chatgpt.models[0].default_effort.as_deref(), Some("medium"));

    assert_eq!(bench.engine.other_provider_window("claude-opus-5-5"), None, "the model catalog's own");
    assert!(bench.engine.other_provider_window("gpt-5").is_some());

    // Signed out, the list is empty and nothing is asked of OpenAI.
    *bench.credentials.new_session.lock().expect("credential") = None;
    let before = bench.mock.requests().len();
    let signed_out = bench.lazy().providers().await;
    assert!(!signed_out[0].ready && signed_out[0].models.is_empty());
    assert_eq!(bench.mock.requests().len(), before);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_runs_on_a_provider_reached_with_a_key() {
    use eos_platform::CredentialStore;
    let bench = Bench::new([
        Reply::chat_text("", "hello from deep"),
        Reply::text("hello from Claude"),
        Reply::chat_text("", "deep again"),
    ])
    .await;
    assert_eq!(bench.engine.other_provider_window("deep/chat-1"), Some(64_000));
    assert_eq!(bench.engine.other_provider_window("nobody/chat-1"), None);

    // A chat starts there: on the provider's key, the model as the provider names it.
    let spec = LaunchSpec { prompt: Some("one".into()), ..bench.spec("w-1") };
    bench.start(LaunchSpec { model: "deep/chat-1".into(), ..spec }).await;
    bench.after_turns("w-1", 1).await;
    let first = &bench.mock.requests()[0];
    assert_eq!(first.path, "/v1/chat/completions");
    assert_eq!(first.headers.get("authorization").and_then(|v| v.to_str().ok()), Some("Bearer k-deep"));
    assert_eq!(first.json()["model"], "chat-1");

    // A Claude chat moves there, and is told when the key is gone.
    let session = bench.start(LaunchSpec { prompt: Some("two".into()), ..bench.spec("w-2") }).await;
    bench.after_turns("w-2", 1).await;
    session.set_model("deep/chat-1", None, None).await.expect("onto the provider");
    session.send("three".into()).await.expect("sent");
    let events = bench.after_turns("w-2", 2).await;
    assert!(events.iter().any(|e| e["blocks"][0]["text"] == "deep again"), "{:?}", tags(&events));
    assert!(bench.request_text(2).contains("hello from Claude"), "the conversation went along");

    session.set_model("mock-model", None, None).await.expect("back onto Claude");
    bench.keychain.delete_secret("eos-deep");
    let refused = session.set_model("deep/chat-1", None, None).await;
    assert_eq!(refused, Err(SessionError::Failed("no key for deep · add one under Settings › Accounts".into())));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_openai_preset_runs_on_the_responses_api_with_its_effort() {
    use eos_platform::CredentialStore;
    let bench = Bench::new([Reply::responses(&[Output::text("hello from the API")], (10, 0, 5))]).await;
    bench.keychain.write_secret("eos-openai", "k-openai").expect("the key");
    bench.mock.set_models(serde_json::json!({"data": [{"id": "gpt-5.5"}]}));
    let providers = bench.lazy().providers().await;
    let openai = providers.iter().find(|p| p.id == "openai-api").expect("the preset");
    let levels = openai.models[0].effort_levels.clone().unwrap_or_default();
    assert_eq!(levels, ["low", "medium", "high", "xhigh"], "the model's own levels");

    let spec = LaunchSpec { prompt: Some("one".into()), effort: Some("max".into()), ..bench.spec("w-1") };
    bench.start(LaunchSpec { model: "openai-api/gpt-5.5".into(), ..spec }).await;
    bench.after_turns("w-1", 1).await;
    let turn = bench.mock.requests().into_iter().find(|r| r.path == "/v1/responses").expect("a Responses request");
    assert_eq!(turn.headers.get("authorization").and_then(|v| v.to_str().ok()), Some("Bearer k-openai"));
    let body = turn.json();
    assert_eq!(body["model"], "gpt-5.5");
    assert_eq!(body["reasoning"]["effort"], "xhigh", "a level it lacks goes down to the nearest it has");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn providers_reached_with_a_key_are_listed_with_their_models() {
    use eos_platform::CredentialStore;
    let bench = Bench::new([]).await;
    bench.mock.set_models(serde_json::json!({"data": [{"id": "reasoner-1"}, {"id": "chat-1"}]}));
    let lazy = bench.lazy();
    assert!(lazy.listed_providers().is_empty(), "nothing is read for it");
    let providers = lazy.providers().await;
    assert_eq!(lazy.listed_providers(), providers, "what was last listed is kept");
    let deep = providers.iter().find(|p| p.id == "deep").expect("the provider");
    assert!(deep.ready);
    let ids: Vec<&str> = deep.models.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, ["deep/chat-1", "deep/reasoner-1"], "the backend's own model first");
    assert_eq!(deep.models[0].display_name, "chat-1");
    assert_eq!(deep.models[0].context_window, Some(64_000));

    bench.keychain.delete_secret("eos-deep");
    let without = bench.lazy().providers().await;
    let deep = without.iter().find(|p| p.id == "deep").expect("still listed");
    assert!(!deep.ready && deep.models.is_empty());
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

/// The agent chooses to say nothing: the tool that ends its turn is the last
/// thing of it, and the model is not asked what to say next.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tool_that_ends_the_turn_is_not_followed_by_another_request() {
    let bench = Bench::new([Reply::tool_use("t1", QUIET, "{}"), Reply::text("filler nobody asked for")]).await;
    let session = bench.start(bench.spec("w-1")).await;
    session.send("<reaction emoji=\"👌\" on=\"yours\">Done.</reaction>".into()).await.expect("sends");
    let events = bench.after_turns("w-1", 1).await;
    let seen = tags(&events);
    assert_eq!(seen[2..5], ["turn:started", "msg:assistant:tool_call", "msg:tool:tool_result"], "{seen:?}");
    assert_eq!(seen.last().map(String::as_str), Some("turn:ended"), "{seen:?}");
    assert!(!seen.iter().any(|tag| tag == "msg:assistant:text"), "the agent wrote nothing: {seen:?}");
    assert_eq!(bench.mock.requests().len(), 1, "one request: the turn ended with the tool");

    // The session goes on: the next message is answered as usual.
    session.send("and now?".into()).await.expect("sends");
    let events = bench.after_turns("w-1", 2).await;
    assert!(tags(&events).iter().any(|tag| tag == "msg:assistant:text"));
}

/// Full access (the fake policy allows every call): a file tool still never
/// writes the app's own state, while a plugin, outside the chat's folder too,
/// is the policy's to decide and is written.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_apps_own_state_stays_unwritten_and_plugins_are_written() {
    let dir = tempfile::tempdir().expect("a folder");
    let data = dir.path().canonicalize().expect("the folder");
    let write = |id: &str, path: &std::path::Path| {
        let input = serde_json::json!({ "file_path": path, "content": "x" });
        Reply::tool_use(id, "Write", &input.to_string())
    };
    let plugin = data.join("plugins/hello/plugin.json");
    let refused = [
        data.join("accounts/claude-a/.credentials.json"),
        data.join("state.db"),
        data.join("peer/identity.json"),
        data.join("engine/transcripts/w-1.jsonl"),
    ];
    let mut replies: Vec<Reply> = refused.iter().enumerate().map(|(n, p)| write(&format!("t{n}"), p)).collect();
    replies.push(write("tp", &plugin));
    replies.push(Reply::text("done"));
    let bench = Bench::in_dir(dir, replies).await;
    std::fs::create_dir_all(plugin.parent().expect("a parent")).expect("a folder");
    let session = bench.start(bench.spec("w-1")).await;
    session.send("go".into()).await.expect("sends");
    let events = bench.after_turns("w-1", 1).await;

    let results: Vec<&Value> = events.iter().filter(|e| e["role"] == "tool").map(|e| &e["blocks"][0]).collect();
    for (n, path) in refused.iter().enumerate() {
        let text = results[n]["content"].as_str().unwrap_or_default();
        assert!(text.contains("which tools do not write"), "{}: {text}", path.display());
        assert!(!path.is_file() || n == 3, "{} was not written", path.display());
    }
    assert_eq!(std::fs::read_to_string(&plugin).expect("the plugin"), "x");
    let asked = bench.policy.asked.lock().expect("asked");
    let plugin_call = asked.iter().find(|c| c.tool_use_id.as_deref() == Some("tp")).expect("asked about the plugin");
    assert!(plugin_call.writes_outside, "a plugin is outside the chat's folder");
    assert_eq!(plugin_call.input.get("file_path").and_then(Value::as_str), plugin.to_str());
}

/// An orchestrator gets the Artifact tools, on a Claude sign-in only: the
/// bench's session runs on an API key, so the call is told to sign in and
/// nothing is sent.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_orchestrator_gets_the_artifact_tools_on_a_claude_sign_in() {
    let bench = Bench::new([Reply::tool_use("t1", "Artifact", r#"{"action":"list"}"#), Reply::text("done")]).await;
    let spec = LaunchSpec {
        role: eos_contracts::SessionFactsRole::Orchestrator,
        prompt: Some("list my artifacts".into()),
        ..bench.spec("w-o")
    };
    bench.start(spec).await;
    let events = bench.after_turns("w-o", 1).await;

    let request = bench.mock.requests()[0].json();
    let tools: Vec<&str> =
        request["tools"].as_array().expect("tools").iter().filter_map(|t| t["name"].as_str()).collect();
    assert!(tools.contains(&"Artifact"), "{tools:?}");
    let result = events.iter().find(|e| e["role"] == "tool").map(|e| &e["blocks"][0]).expect("the tool's result");
    assert_eq!(result["isError"], true, "{result}");
    assert!(result.to_string().contains("needs a Claude sign-in"), "{result}");
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
    assert_eq!(texts, ["Not signed in · Sign in under Settings › Accounts"]);
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
    assert_eq!(session.compact(None).await, Err(SessionError::Gone));
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

/// A sink that, once `stuck`, never returns from `events`: a pump that hands it a batch hangs.
struct StuckSink {
    inner: Arc<RecordingSink>,
    stuck: std::sync::atomic::AtomicBool,
    entered: tokio::sync::Notify,
}

impl eos_core::agent::SessionSink for StuckSink {
    fn events<'a>(&'a self, worker_id: &'a str, events: Vec<eos_contracts::AgentEvent>) -> eos_core::BoxFuture<'a, ()> {
        if !self.stuck.load(std::sync::atomic::Ordering::SeqCst) {
            return self.inner.events(worker_id, events);
        }
        self.entered.notify_one();
        Box::pin(std::future::pending())
    }

    fn exited<'a>(&'a self, worker_id: &'a str, code: Option<i32>) -> eos_core::BoxFuture<'a, ()> {
        self.inner.exited(worker_id, code)
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_whose_pump_is_stuck_is_closed_after_a_while_and_reports_its_exit() {
    let bench = Bench::new([Reply::text("one"), Reply::text("two")]).await;
    let sink = Arc::new(StuckSink {
        inner: bench.sink.clone(),
        stuck: std::sync::atomic::AtomicBool::new(false),
        entered: tokio::sync::Notify::new(),
    });
    let spec = LaunchSpec { prompt: Some("first".into()), ..bench.spec("w-1") };
    let session = bench.engine.start(spec, sink.clone()).await.expect("the session starts");
    bench.after_turns("w-1", 1).await;

    sink.stuck.store(true, std::sync::atomic::Ordering::SeqCst);
    session.send("second".into()).await.expect("sends");
    sink.entered.notified().await;
    let began = std::time::Instant::now();
    tokio::time::timeout(Duration::from_secs(30), session.stop()).await.expect("the stop gives up on the pump");
    assert!(began.elapsed() >= Duration::from_secs(4), "it waited for the pump first");
    assert_eq!(*bench.sink.exits.lock().expect("exits"), [("w-1".to_owned(), Some(143))]);
    assert!(!session.is_alive());
    assert_eq!(bench.engine.live(), 0);
    assert!(bench.engine.session("w-1").is_none());
    session.stop().await;
    assert_eq!(bench.sink.exits.lock().expect("exits").len(), 1, "stopping twice reports one exit");
}

/// A sink whose exit report takes longer than a stop waits for the pump.
struct SlowExitSink {
    inner: Arc<RecordingSink>,
}

impl eos_core::agent::SessionSink for SlowExitSink {
    fn events<'a>(&'a self, worker_id: &'a str, events: Vec<eos_contracts::AgentEvent>) -> eos_core::BoxFuture<'a, ()> {
        self.inner.events(worker_id, events)
    }

    fn exited<'a>(&'a self, worker_id: &'a str, code: Option<i32>) -> eos_core::BoxFuture<'a, ()> {
        Box::pin(async move {
            tokio::time::sleep(Duration::from_secs(6)).await;
            self.inner.exited(worker_id, code).await;
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stop_lets_the_pumps_own_exit_report_finish() {
    let bench = Bench::new([Reply::text("one")]).await;
    let sink = Arc::new(SlowExitSink { inner: bench.sink.clone() });
    let spec = LaunchSpec { prompt: Some("first".into()), ..bench.spec("w-1") };
    let session = bench.engine.start(spec, sink).await.expect("the session starts");
    bench.after_turns("w-1", 1).await;

    tokio::time::timeout(Duration::from_secs(30), session.stop()).await.expect("the stop ends");
    assert_eq!(*bench.sink.exits.lock().expect("exits"), [("w-1".to_owned(), Some(143))], "reported whole, once");
    assert!(!session.is_alive());
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
async fn the_conversation_can_be_cut_back_cleared_and_summarized() {
    let bench = Bench::new([
        Reply::text("one"),
        Reply::text("two"),
        Reply::text("three"),
        Reply::text("<analysis>x</analysis><summary>SUMMARY OF THE WORK</summary>"),
        Reply::text("four"),
    ])
    .await;
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

    // Taking back the last prompt, then summarizing everything.
    session.recall_last_user_turn().await.expect("recalls");
    let left: Vec<String> = session.rewind_targets().await.expect("targets").into_iter().map(|t| t.text).collect();
    assert_eq!(left, ["ALPHA-ONE"]);
    session.compact(Some("keep the codes".into())).await.expect("summarizes");
    let asked = bench.request_text(3);
    assert!(asked.contains("Summarize the conversation. Focus: keep the codes") && asked.contains("ALPHA-ONE"));
    session.send("carry on".into()).await.expect("sends");
    bench.after_turns("w-1", 4).await;
    let sent = bench.request_text(4);
    assert!(sent.contains("SUMMARY OF THE WORK") && sent.contains("carry on") && !sent.contains("ALPHA-ONE"), "{sent}");
    assert!(!sent.contains("<analysis>"), "only the summary carries on: {sent}");

    session.clear_context().await.expect("clears");
    assert!(session.rewind_targets().await.expect("targets").is_empty());
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
    let replies =
        [limit(), Reply::text("on the spare"), limit(), Reply::text("on the key"), Reply::text("on the pick")];
    let bench = Bench::new(replies).await;
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
    bench.engine.move_session("w-1", key, AfterMove::Rerun).await.expect("moves");
    let events = bench.after_turns("w-1", 3).await;
    assert_eq!(tags(&events)[9..], ["turn:started", "msg:assistant:text", "usage", "turn:ended"]);
    assert_eq!(key_of(bench.mock.requests().last().expect("a request")).as_deref(), Some("k-own"));

    // The user's pick: nothing runs again, the next message goes out on it.
    let pick = SessionCredential::ApiKey { provider: "anthropic".into(), key: "k-pick".into() };
    bench.engine.move_session("w-1", pick, AfterMove::CarryOn).await.expect("moves");
    assert_eq!(bench.mock.requests().len(), 4);
    session.send("again".into()).await.expect("sends");
    bench.after_turns("w-1", 4).await;
    assert_eq!(key_of(bench.mock.requests().last().expect("a request")).as_deref(), Some("k-pick"));

    let moved = bench.engine.move_session(
        "w-none",
        SessionCredential::ApiKey { provider: "anthropic".into(), key: "x".into() },
        AfterMove::Rerun,
    );
    assert_eq!(moved.await.err().as_deref(), Some("this agent can't change account right now"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_running_turn_holds_up_neither_the_rewind_list_nor_a_clear() {
    let slow = Reply::text("a slow answer").slowed(Duration::from_secs(3));
    let bench = Bench::new([Reply::text("one"), slow]).await;
    let session = bench.start(bench.spec("w-1")).await;
    session.send("FIRST".into()).await.expect("sends");
    bench.after_turns("w-1", 1).await;
    session.send("SECOND".into()).await.expect("sends");
    let running = |events: &[Value]| {
        events.iter().filter(|e| e["type"] == "turn" && e["phase"] == "started").count() == 2
            && events.last().is_some_and(|e| e["type"] == "delta")
    };
    bench.sink.until("w-1", running).await;

    let soon = Duration::from_millis(1500);
    let targets =
        tokio::time::timeout(soon, session.rewind_targets()).await.expect("answers at once").expect("targets");
    assert_eq!(targets.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(), ["FIRST", "SECOND"]);
    tokio::time::timeout(soon, session.clear_context()).await.expect("clears at once").expect("clears");
    let events = bench.after_turns("w-1", 2).await;
    assert_eq!(events.iter().rev().find(|e| e["type"] == "turn").expect("the end")["phase"], "aborted");
    assert!(session.rewind_targets().await.expect("targets").is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rewind_checks_its_target_then_stops_the_running_turn() {
    let slow = Reply::text("a slow answer").slowed(Duration::from_secs(3));
    let bench = Bench::new([Reply::text("one"), slow]).await;
    let session = bench.start(bench.spec("w-1")).await;
    session.send("FIRST".into()).await.expect("sends");
    bench.after_turns("w-1", 1).await;
    session.send("SECOND".into()).await.expect("sends");
    let running = |events: &[Value]| {
        events.iter().filter(|e| e["type"] == "turn" && e["phase"] == "started").count() == 2
            && events.last().is_some_and(|e| e["type"] == "delta")
    };
    bench.sink.until("w-1", running).await;

    let soon = Duration::from_millis(1500);
    let missing = tokio::time::timeout(soon, session.rewind("m999", eos_contracts::RewindMode::Conversation))
        .await
        .expect("answers at once")
        .err()
        .map(|e| e.to_string());
    assert!(missing.as_deref().is_some_and(|e| e.contains("message not found on the active branch")), "{missing:?}");
    let ended = |events: &[Value]| events.iter().filter(|e| e["type"] == "turn" && e["phase"] != "started").count();
    assert_eq!(ended(&bench.sink.json("w-1")), 1, "an unknown target leaves the turn running");

    let second = session.rewind_targets().await.expect("targets").pop().expect("the second prompt");
    let back = tokio::time::timeout(soon, session.rewind(&second.uuid, eos_contracts::RewindMode::Conversation))
        .await
        .expect("rewinds at once")
        .expect("rewinds");
    assert_eq!((back.text.as_str(), back.index), ("SECOND", 1));
    let events = bench.after_turns("w-1", 2).await;
    assert_eq!(events.iter().rev().find(|e| e["type"] == "turn").expect("the end")["phase"], "aborted");
    let left = session.rewind_targets().await.expect("targets");
    assert_eq!(left.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(), ["FIRST"]);
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
/// that message, the message after it. The summary comes before the next
/// message, a rewind to that message keeps it, and it is no rewind target of
/// its own.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rewind_to_the_first_message_after_a_compaction_keeps_the_summary() {
    let summary = Reply::text("<summary>SUMMARY: a.py was read</summary>");
    let bench = Bench::new([Reply::text("read it"), summary, Reply::text("two"), Reply::text("three")]).await;
    let session = bench.start(bench.spec("w-1")).await;
    session.send("read a.py".into()).await.expect("sends");
    bench.after_turns("w-1", 1).await;
    session.compact(None).await.expect("summarizes");
    session.send("NEXT-ONE".into()).await.expect("sends");
    bench.after_turns("w-1", 2).await;
    let sent = bench.request_text(2);
    let at = |text: &str| sent.find(text).unwrap_or_else(|| panic!("{text} missing: {sent}"));
    assert!(at("SUMMARY: a.py was read") < at("NEXT-ONE") && !sent.contains("read a.py"), "{sent}");

    let targets = session.rewind_targets().await.expect("targets");
    let prompts: Vec<&str> = targets.iter().map(|t| t.text.as_str()).collect();
    assert_eq!(prompts, ["NEXT-ONE"], "the summary is not a prompt");
    session.rewind(&targets[0].uuid, eos_contracts::RewindMode::Both).await.expect("rewinds");
    session.send("NEXT-TWO".into()).await.expect("sends");
    bench.after_turns("w-1", 3).await;

    let sent = bench.request_text(3);
    let at = |text: &str| sent.find(text).unwrap_or_else(|| panic!("{text} missing: {sent}"));
    assert!(at("SUMMARY: a.py was read") < at("NEXT-TWO") && !sent.contains("NEXT-ONE"), "{sent}");

    // The sink heard the summary start and end, and none of its text became a message.
    let notices: Vec<CompactionNotice> =
        bench.sink.compactions.lock().expect("notices").iter().map(|(_, _, n)| n.clone()).collect();
    assert!(matches!(&notices[0], CompactionNotice::Started { trigger: eos_contracts::CompactionTrigger::Manual, .. }));
    let CompactionNotice::Completed { summary, turns, after_tokens, .. } = &notices[1] else {
        panic!("completed: {notices:?}")
    };
    assert_eq!((summary.as_str(), *turns), ("SUMMARY: a.py was read", 1));
    assert!(*after_tokens > 0);
    let said = bench.sink.json("w-1").iter().filter(|e| e.to_string().contains("SUMMARY: a.py")).count();
    assert_eq!(said, 0, "the summary is no event of the conversation");
}

/// A session that summarizes on its own does it inside the turn and the turn
/// goes on from the summary: no turn ends for it, and the notices come
/// inside the turn. (A request the provider finds too long is summarized the
/// same way as one past the threshold, and is easier to script.)
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_that_outgrows_the_context_summarizes_and_goes_on() {
    let summary = Reply::text("<summary>SUMMARY: the codename is PELICAN</summary>");
    let replies = [Reply::text("noted"), Reply::prompt_too_long(), summary, Reply::text("still PELICAN")];
    let bench = Bench::new(replies).await;
    let spec = LaunchSpec { compact_at: Some(10_000_000), ..bench.spec("w-1") };
    let session = bench.start(spec).await;
    session.send("the codename is PELICAN".into()).await.expect("sends");
    bench.after_turns("w-1", 1).await;
    session.send("what is it?".into()).await.expect("sends");
    let events = bench.after_turns("w-1", 2).await;

    assert_eq!(
        tags(&events)[2..],
        [
            "turn:started",
            "msg:assistant:text",
            "usage",
            "turn:ended",
            "turn:started",
            "msg:assistant:text",
            "usage",
            "turn:ended"
        ],
        "the summary's own text is no message"
    );
    let notices = bench.sink.compactions.lock().expect("notices").clone();
    let kinds: Vec<(usize, &str)> = notices
        .iter()
        .map(|(_, at, n)| {
            let kind = match n {
                CompactionNotice::Started { .. } => "started",
                CompactionNotice::Completed { .. } => "completed",
                CompactionNotice::Failed { .. } => "failed",
            };
            (*at, kind)
        })
        .collect();
    let second_turn = events.iter().rposition(|e| e["type"] == "turn" && e["phase"] == "started").expect("a start");
    assert_eq!(kinds.len(), 2, "{kinds:?}");
    assert!(kinds.iter().all(|(at, _)| *at > second_turn), "inside the second turn: {kinds:?} after {second_turn}");
    assert!(matches!(
        &notices[1].2,
        CompactionNotice::Completed { trigger: eos_contracts::CompactionTrigger::Auto, .. }
    ));
    let sent = bench.request_text(3);
    assert!(sent.contains("SUMMARY: the codename is PELICAN") && !sent.contains("noted"), "{sent}");
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

/// The user stops one background subagent through the session, by its agent
/// id: it ends as stopped, its idle parent is told, and stopping it again
/// says it has ended.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_user_stops_one_background_subagent() {
    let seen: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
    let log = seen.clone();
    let mock = MockApi::responder(std::net::SocketAddr::from(([127, 0, 0, 1], 0)), move |body| {
        let body: Value = serde_json::from_slice(body).unwrap_or_default();
        let text = body["messages"].to_string();
        log.lock().expect("log").push(text.clone());
        if !text.contains("PARENT-START") {
            return Reply::text("scouting").slowed(Duration::from_secs(30));
        }
        if text.contains("was stopped by user") {
            return Reply::text("noted");
        }
        if text.contains("tool_result") {
            return Reply::text("parent waits");
        }
        let input = serde_json::json!({"description": "Scout", "prompt": "CHILD-START", "name": "scout",
                                       "run_in_background": true});
        Reply::tool_use("toolu_scout", "Agent", &input.to_string())
    })
    .await
    .expect("the mock API");
    let bench = Bench::with_mock(tempfile::tempdir().expect("a folder"), mock).await;
    let spec = LaunchSpec { role: eos_contracts::SessionFactsRole::Focused, ..bench.spec("w-1") };
    let session = bench.start(spec).await;
    session.send("PARENT-START".into()).await.expect("sends");
    let started = |events: &[Value]| events.iter().any(|e| e["type"] == "subagent_started");
    let events =
        tokio::time::timeout(Duration::from_secs(30), bench.sink.until("w-1", started)).await.expect("it starts");
    let start = events.iter().find(|e| e["type"] == "subagent_started").expect("the start");
    assert_eq!(start["callId"], "toolu_scout");
    let agent = start["agentId"].as_str().expect("an agent id").to_owned();

    session.stop_task(&agent).await.expect("stopped");
    let completed = |events: &[Value]| {
        events.iter().any(|e| e["type"] == "subagent_completed" && e["callId"] == "toolu_scout")
            && events.iter().filter(|e| e["type"] == "turn" && e["phase"] != "started").count() >= 2
    };
    let events =
        tokio::time::timeout(Duration::from_secs(30), bench.sink.until("w-1", completed)).await.expect("it ends");
    let end = events.iter().find(|e| e["type"] == "subagent_completed").expect("the end");
    assert_eq!(end["status"], "stopped");
    let told =
        seen.lock().expect("log").iter().any(|t| t.contains("PARENT-START") && t.contains("was stopped by user"));
    assert!(told, "the idle parent was woken and told");
    match session.stop_task(&agent).await {
        Err(eos_core::agent::SessionError::TaskEnded(message)) => assert!(message.contains("not running"), "{message}"),
        other => panic!("a second stop: {other:?}"),
    }
}

/// A subagent started in plan mode: its calls reach Eos's policy with the
/// mode its chain resolves to (the engine leaves the decision to Eos), and
/// whether the call only looks.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_subagents_declared_mode_reaches_the_policy() {
    let mock = MockApi::responder(std::net::SocketAddr::from(([127, 0, 0, 1], 0)), move |body| {
        let body: Value = serde_json::from_slice(body).unwrap_or_default();
        let text = body["messages"].to_string();
        if text.contains("CHILD-START") {
            if text.contains("tool_result") {
                return Reply::text("child done");
            }
            return Reply::tool_use("toolu_write", "Write", r#"{"file_path":"plan.md","content":"x"}"#);
        }
        if text.contains("tool_result") {
            return Reply::text("parent done");
        }
        let input = serde_json::json!({"description": "Plan", "prompt": "CHILD-START", "mode": "plan"});
        Reply::tool_use("toolu_plan", "Agent", &input.to_string())
    })
    .await
    .expect("the mock API");
    let bench = Bench::with_mock(tempfile::tempdir().expect("a folder"), mock).await;
    let spec = LaunchSpec { role: eos_contracts::SessionFactsRole::Focused, ..bench.spec("w-1") };
    let session = bench.start(spec).await;
    session.send("PARENT-START".into()).await.expect("sends");
    let wrote = || bench.policy.asked.lock().expect("asked").iter().any(|c| c.tool_name == "Write");
    tokio::time::timeout(Duration::from_secs(30), async {
        while !wrote() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the child writes");

    let asked = bench.policy.asked.lock().expect("asked");
    let parent = asked.iter().find(|c| c.tool_name == "Agent").expect("the Agent call");
    assert_eq!(parent.subagent, None, "the worker's own call is decided in its own mode");
    let write = asked.iter().find(|c| c.tool_name == "Write").expect("the child's Write");
    assert!(write.agent_id.is_some());
    let modes = write.subagent.expect("the child's declared mode");
    use eos_contracts::PermissionMode::{AcceptEdits, BypassPermissions};
    use eos_core::policy::AgentMode::Plan;
    assert_eq!((modes.under(AcceptEdits), modes.under(BypassPermissions)), (Plan, Plan));
    assert!(!modes.looks_only, "a Write changes something");
}

/// A file read under a subfolder with skills of its own: the model is told,
/// the composer's menu lists them for the worker, and the notice stays out
/// of the chat.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn skills_of_a_touched_subfolder_join_the_workers_commands() {
    let dir = tempfile::tempdir().expect("a folder");
    let project = dir.path().join("project");
    let skill = project.join("apps/web/.claude/skills/deploy/SKILL.md");
    std::fs::create_dir_all(skill.parent().expect("a parent")).expect("folders");
    std::fs::write(&skill, "---\ndescription: Deploy the web app\n---\nweb deploy").expect("the skill");
    std::fs::write(project.join("apps/web/index.ts"), "x").expect("a file");
    let read = project.canonicalize().expect("the project").join("apps/web/index.ts");
    let input = serde_json::json!({ "file_path": read }).to_string();
    let bench = Bench::in_dir(dir, [Reply::tool_use("t1", "Read", &input), Reply::text("done")]).await;
    let session = bench.start(LaunchSpec { role: eos_contracts::SessionFactsRole::Focused, ..bench.spec("w-1") }).await;
    assert!(!session.commands().iter().any(|c| c.name == "deploy"), "not before a file there is touched");
    session.send("go".into()).await.expect("sends");
    let events = bench.after_turns("w-1", 1).await;

    assert!(bench.request_text(1).contains("New skills discovered in apps/web/.claude/skills"));
    assert!(session.commands().iter().any(|c| c.name == "deploy"), "{:?}", session.commands());
    let shown = serde_json::to_string(&events).expect("json");
    assert!(!shown.contains("New skills discovered"), "the notice is the model's, not the chat's");
}

/// A note left while a tool runs goes out with the request after the tool's
/// result, in the same turn, and never shows in the chat.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_note_left_while_a_tool_runs_reaches_the_next_request() {
    let bench = Bench::new([Reply::tool_use("t1", HELD, "{}"), Reply::text("done")]).await;
    let held = Held::new();
    let engine = bench.holding(&held).await;
    let spec = LaunchSpec { prompt: Some("go".into()), ..bench.spec("w-1") };
    let session = engine.start(spec, bench.sink.clone()).await.expect("the session starts");
    held.started.notified().await;
    session.note(reminder("MID-TURN NOTE")).expect("left");
    held.release.notify_one();
    let events = bench.after_turns("w-1", 1).await;

    assert_eq!(bench.mock.requests().len(), 2, "the note asks for no request of its own");
    assert!(!bench.request_text(0).contains("MID-TURN NOTE"));
    let next = bench.request_text(1);
    let (result, note) = (next.find("held done"), next.find("MID-TURN NOTE"));
    assert!(result.is_some() && note > result, "after the tool's result: {next}");
    let shown = serde_json::to_string(&events).expect("json");
    assert!(!shown.contains("MID-TURN NOTE"), "the note is the model's, not the chat's");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_notes_of_a_launch_reach_the_first_request() {
    let bench = Bench::new([Reply::text("hi")]).await;
    let notes = vec![reminder("LAUNCH NOTE ONE"), reminder("LAUNCH NOTE TWO")];
    bench.start(LaunchSpec { prompt: Some("say hi".into()), notes, ..bench.spec("w-1") }).await;
    bench.after_turns("w-1", 1).await;

    let first = bench.request_text(0);
    assert!(first.contains("say hi"), "{first}");
    assert!(first.contains("LAUNCH NOTE ONE") && first.contains("LAUNCH NOTE TWO"), "{first}");
}

/// The engine runs a turn by itself for a note its own background work
/// leaves; a note left through the session never does.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_note_left_in_an_idle_session_waits_for_the_next_message() {
    let bench = Bench::new([Reply::text("one"), Reply::text("two")]).await;
    let session = bench.start(LaunchSpec { prompt: Some("first".into()), ..bench.spec("w-1") }).await;
    bench.after_turns("w-1", 1).await;
    session.note(reminder("IDLE NOTE")).expect("left");
    tokio::time::sleep(Duration::from_millis(500)).await;

    assert_eq!(bench.mock.requests().len(), 1, "a note starts no turn");
    let turns = tags(&bench.sink.json("w-1")).iter().filter(|t| *t == "turn:started").count();
    assert_eq!(turns, 1);
    session.send("second".into()).await.expect("sends");
    bench.after_turns("w-1", 2).await;
    let next = bench.request_text(1);
    assert!(next.contains("second") && next.contains("IDLE NOTE"), "{next}");
}

/// A note left while a subagent runs stays with the session's own agent: the
/// subagent's requests do not carry it, the parent's next one does.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_subagent_does_not_take_the_note_of_its_parent() {
    let seen: Arc<std::sync::Mutex<Vec<(bool, String)>>> = Arc::default();
    let log = seen.clone();
    let mock = MockApi::responder(std::net::SocketAddr::from(([127, 0, 0, 1], 0)), move |body| {
        let body: Value = serde_json::from_slice(body).unwrap_or_default();
        let text = body["messages"].to_string();
        let parent = text.contains("PARENT-START");
        log.lock().expect("log").push((parent, text.clone()));
        match (parent, text.contains("held done"), text.contains("tool_result")) {
            (false, false, _) => Reply::tool_use("toolu_held", HELD, "{}"),
            (false, true, _) => Reply::text("child done"),
            (true, _, true) => Reply::text("parent done"),
            (true, _, false) => {
                let input = serde_json::json!({"description": "Scout", "prompt": "CHILD-START",
                                               "run_in_background": false});
                Reply::tool_use("toolu_scout", "Agent", &input.to_string())
            }
        }
    })
    .await
    .expect("the mock API");
    let bench = Bench::with_mock(tempfile::tempdir().expect("a folder"), mock).await;
    let held = Held::new();
    let engine = bench.holding(&held).await;
    let spec = LaunchSpec { role: eos_contracts::SessionFactsRole::Focused, ..bench.spec("w-1") };
    let session = engine.start(spec, bench.sink.clone()).await.expect("the session starts");
    session.send("PARENT-START".into()).await.expect("sends");
    held.started.notified().await;
    session.note(reminder("PARENT NOTE")).expect("left");
    held.release.notify_one();
    bench.after_turns("w-1", 1).await;

    let seen = seen.lock().expect("log");
    let child: Vec<&String> = seen.iter().filter(|(parent, _)| !parent).map(|(_, text)| text).collect();
    assert_eq!(child.len(), 2, "the child called the tool and answered");
    assert!(child.iter().all(|text| !text.contains("PARENT NOTE")), "{child:?}");
    let parent = seen.iter().rfind(|(parent, _)| *parent).map(|(_, text)| text).expect("the parent's last request");
    assert!(parent.contains("child done") && parent.contains("PARENT NOTE"), "{parent}");
}

/// A folder that configures and approves an MCP server of its own: a session
/// started without the folder's servers neither starts it nor lists its
/// tools; one started as by default starts it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_without_folder_mcp_connects_none_of_the_folders_servers() {
    let dir = tempfile::tempdir().expect("a folder");
    let project = dir.path().join("project");
    std::fs::create_dir_all(project.join(".claude")).expect("folders");
    let started = dir.path().join("server-started");
    let server = serde_json::json!({"command": "/bin/sh", "args": ["-c", format!("touch '{}'", started.display())]});
    let servers = serde_json::json!({"mcpServers": {"folder-server": server}});
    std::fs::write(project.join(".mcp.json"), servers.to_string()).expect("the servers");
    std::fs::write(project.join(".claude/settings.json"), r#"{"enableAllProjectMcpServers": true}"#).expect("settings");
    let bench = Bench::in_dir(dir, [Reply::text("one"), Reply::text("two")]).await;
    let options = EngineOptions { mcp: true, ..bench.setup.0.clone() };
    let engine = Engine::build(options, bench.setup.1.clone()).await.expect("the engine");

    let spec = LaunchSpec { prompt: Some("one".into()), folder_mcp: false, ..bench.spec("w-off") };
    engine.start(spec, bench.sink.clone()).await.expect("the session starts");
    bench.after_turns("w-off", 1).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!started.exists(), "the folder's server was not started");
    let first = bench.mock.requests()[0].json();
    let tools: Vec<&str> =
        first["tools"].as_array().expect("tools").iter().filter_map(|t| t["name"].as_str()).collect();
    assert!(!tools.iter().any(|t| t.starts_with("mcp__")), "{tools:?}");
    assert!(!first.to_string().contains("folder-server"), "the server is never named");

    let spec = LaunchSpec { prompt: Some("two".into()), ..bench.spec("w-on") };
    engine.start(spec, bench.sink.clone()).await.expect("the session starts");
    bench.after_turns("w-on", 1).await;
    tokio::time::timeout(Duration::from_secs(10), async {
        while !started.exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("by default the folder's server is started");
}
