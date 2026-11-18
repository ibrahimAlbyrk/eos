//! What a caller adds to a session besides its turns: notes for the model,
//! left at launch or while it runs, and a start without the folder's MCP
//! servers.

use std::sync::Arc;
use std::time::Duration;

use eos_agent_mock_api::{MockApi, Reply};
use eos_core::agent::{AgentRuntime, LaunchSpec};
use eos_engine::{Engine, EngineDeps, EngineOptions};
use eos_testkit::{EchoTool, FakeToolSets};
use serde_json::Value;

use super::{Bench, TOOL, tags};

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

impl Bench {
    /// A second engine over the same folder and mock, with `held` among its tools.
    async fn holding(&self, held: &Arc<Held>) -> Engine {
        let tools: Vec<Arc<dyn eos_core::agent::HostTool>> = vec![EchoTool::named(TOOL), held.clone()];
        let deps = EngineDeps { tools: Arc::new(FakeToolSets(tools)), ..self.setup.1.clone() };
        Engine::build(self.setup.0.clone(), deps).await.expect("the engine")
    }
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
