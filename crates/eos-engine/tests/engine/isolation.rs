//! A routine run's session works in an empty folder Eos owns, under the
//! data folder's `routines/` entry, and reads the checkout as a further
//! root: nothing of the checkout's project configuration reaches it, and
//! its file tools never write the run's `files/`, which the check reads.

use std::path::{Path, PathBuf};
use std::time::Duration;

use eos_agent_mock_api::Reply;
use eos_contracts::SessionFactsRole;
use eos_core::agent::{AgentRuntime, LaunchSpec};
use eos_engine::{Engine, EngineOptions};
use serde_json::Value;

use super::Bench;

/// One marker per kind of project file; none may reach a request.
const MARKERS: [&str; 8] = [
    "MARK-CLAUDE-MD",
    "MARK-CLAUDE-LOCAL",
    "MARK-RULE",
    "MARK-SKILL",
    "MARK-COMMAND",
    "MARK-AGENT",
    "MARK-GENERAL-PURPOSE",
    "MARK-WORKFLOW",
];
const NOTES: &str = "plain notes of the checkout";

/// A pull request's checkout that configures everything a project can.
fn plant_checkout(checkout: &Path, server_started: &Path) {
    let write = |path: &str, text: &str| {
        let path = checkout.join(path);
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("a folder");
        std::fs::write(path, text).expect("a file");
    };
    write("CLAUDE.md", "MARK-CLAUDE-MD");
    write("CLAUDE.local.md", "MARK-CLAUDE-LOCAL");
    write(".claude/rules/style.md", "MARK-RULE");
    write(".claude/settings.json", r#"{"enableAllProjectMcpServers": true}"#);
    let server =
        serde_json::json!({"command": "/bin/sh", "args": ["-c", format!("touch '{}'", server_started.display())]});
    write(".mcp.json", &serde_json::json!({"mcpServers": {"pr-server": server}}).to_string());
    write(".claude/skills/pr-skill/SKILL.md", "---\nname: pr-skill\ndescription: MARK-SKILL\n---\nMARK-SKILL body\n");
    write(".claude/commands/pr-command.md", "---\ndescription: MARK-COMMAND\n---\nMARK-COMMAND body\n");
    write(".claude/agents/pr-agent.md", "---\nname: pr-agent\ndescription: MARK-AGENT\n---\nMARK-AGENT prompt\n");
    write(
        ".claude/agents/general-purpose.md",
        "---\nname: general-purpose\ndescription: MARK-GENERAL-PURPOSE\n---\nMARK-GENERAL-PURPOSE prompt\n",
    );
    write(
        ".claude/workflows/pr-flow.js",
        "export const meta = {name: 'pr-flow', description: 'MARK-WORKFLOW'};\nreturn 'MARK-WORKFLOW';\n",
    );
    write("sub/notes.txt", NOTES);
}

struct Run {
    bench: Bench,
    engine: Engine,
    checkout: PathBuf,
    /// The run's folder: `routines/<routine>/runs/<run>` in the data folder.
    run: PathBuf,
    server_started: PathBuf,
}

impl Run {
    /// The bench with a planted checkout, an empty working folder under the
    /// run's folder, and an engine that would connect a folder's servers.
    async fn new(replies: impl Fn(&Path, &Path) -> Vec<Reply>) -> Self {
        let dir = tempfile::tempdir().expect("a folder");
        let data = dir.path().canonicalize().expect("the folder");
        let (checkout, run) = (data.join("checkout"), data.join("routines/rt-1/runs/rn-1"));
        let server_started = data.join("server-started");
        plant_checkout(&checkout, &server_started);
        std::fs::create_dir_all(run.join("work")).expect("the working folder");
        std::fs::create_dir_all(run.join("files")).expect("the files folder");
        let bench = Bench::in_dir(dir, replies(&checkout, &run)).await;
        let options = EngineOptions { mcp: true, ..bench.setup.0.clone() };
        let engine = Engine::build(options, bench.setup.1.clone()).await.expect("the engine");
        Self { bench, engine, checkout, run, server_started }
    }

    /// A run session as Eos starts one: focused, in the empty folder, the
    /// checkout a further root, the folder's servers off.
    async fn start(&self, worker: &str) -> Vec<Value> {
        let spec = LaunchSpec {
            role: SessionFactsRole::Focused,
            additional_dirs: vec![self.checkout.to_string_lossy().into_owned()],
            folder_mcp: false,
            prompt: Some("work on the pull request".into()),
            ..LaunchSpec::new(worker, self.run.join("work").to_string_lossy(), "mock-model")
        };
        self.engine.start(spec, self.bench.sink.clone()).await.expect("the session starts in the run's folder");
        self.bench.after_turns(worker, 1).await
    }

    fn requests(&self) -> String {
        self.bench.mock.requests().iter().map(|r| r.json().to_string()).collect::<Vec<_>>().join("\n")
    }
}

fn tool_results(events: &[Value]) -> Vec<(bool, String)> {
    events
        .iter()
        .filter(|e| e["role"] == "tool")
        .map(|e| &e["blocks"][0])
        .map(|b| (b["isError"].as_bool().unwrap_or(false), b["content"].to_string()))
        .collect()
}

/// Nothing of the checkout's configuration loads, the folder's server never
/// starts, and the agent still reaches the checkout with `cd` and `Read`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_run_session_loads_nothing_of_the_checkout_it_reads() {
    let run = Run::new(|checkout, _| {
        let cd = serde_json::json!({"command": format!("cd '{}' && pwd && ls sub", checkout.display())});
        let read = serde_json::json!({"file_path": checkout.join("sub/notes.txt")});
        vec![
            Reply::tool_use("t1", "Bash", &cd.to_string()),
            Reply::tool_use("t2", "Read", &read.to_string()),
            Reply::text("done"),
        ]
    })
    .await;
    let events = run.start("w-run").await;

    let results = tool_results(&events);
    assert_eq!(results.len(), 2, "{results:?}");
    let checkout = run.checkout.to_string_lossy().into_owned();
    assert!(!results[0].0 && results[0].1.contains(&checkout) && results[0].1.contains("notes.txt"), "{results:?}");
    assert!(!results[1].0 && results[1].1.contains(NOTES), "{results:?}");
    let sent = run.requests();
    for marker in MARKERS {
        assert!(!sent.contains(marker), "{marker} reached a request");
    }
    assert!(!sent.contains("pr-server"), "the folder's server is never named");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!run.server_started.exists(), "the folder's server was not started");
}

/// The planted checkout does load when a session works in it, as a chat's
/// does: the test above would see it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_planted_checkout_loads_in_a_session_that_works_in_it() {
    let run = Run::new(|_, _| vec![Reply::text("done")]).await;
    let spec = LaunchSpec {
        role: SessionFactsRole::Focused,
        prompt: Some("work".into()),
        ..LaunchSpec::new("w-chat", run.checkout.to_string_lossy(), "mock-model")
    };
    run.engine.start(spec, run.bench.sink.clone()).await.expect("the session starts");
    run.bench.after_turns("w-chat", 1).await;

    let sent = run.requests();
    for marker in ["MARK-CLAUDE-MD", "MARK-RULE", "MARK-SKILL", "MARK-GENERAL-PURPOSE"] {
        assert!(sent.contains(marker), "{marker} loads from the working folder");
    }
    tokio::time::timeout(Duration::from_secs(10), async {
        while !run.server_started.exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the folder's server starts");
}

/// From the working folder under `routines/`, file tools write that folder
/// (the engine counts the working folder among the session's own) and the
/// checkout, a further root, but never the run's `files/`, which the check
/// reads.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn file_tools_write_the_working_folder_and_checkout_but_not_the_runs_files() {
    let write = |id: &str, path: PathBuf| {
        let input = serde_json::json!({"file_path": path, "content": "x"});
        Reply::tool_use(id, "Write", &input.to_string())
    };
    let run = Run::new(|checkout, run| {
        vec![
            write("t1", run.join("work/scratch.txt")),
            write("t2", run.join("files/result.md")),
            write("t3", checkout.join("edited.txt")),
            Reply::text("done"),
        ]
    })
    .await;
    let events = run.start("w-run").await;

    let results = tool_results(&events);
    assert_eq!(results.len(), 3, "{results:?}");
    assert!(!results[0].0, "{results:?}");
    assert_eq!(std::fs::read_to_string(run.run.join("work/scratch.txt")).expect("written"), "x");
    let files = run.run.join("files/result.md");
    assert!(results[1].0 && results[1].1.contains("which tools do not write"), "{results:?}");
    assert!(!files.exists(), "the run's files are not written");
    assert!(!results[2].0, "{results:?}");
    assert_eq!(std::fs::read_to_string(run.checkout.join("edited.txt")).expect("written"), "x");
}

/// Every start of a run session gets a fresh working folder (`work/<n>/`):
/// what an agent left in the folder of an earlier start never loads, and the
/// resumed session still has its conversation.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn instructions_left_in_an_earlier_working_folder_do_not_load_at_the_next_start() {
    let run = Run::new(|_, _| vec![Reply::text("the codename is BLUEFIN"), Reply::text("as I said")]).await;
    let start = |n: u32, prompt: &str, resume: Option<&str>| {
        let folder = run.run.join(format!("work/{n}"));
        std::fs::create_dir_all(&folder).expect("a working folder");
        LaunchSpec {
            role: SessionFactsRole::Focused,
            additional_dirs: vec![run.checkout.to_string_lossy().into_owned()],
            folder_mcp: false,
            prompt: Some(prompt.into()),
            resume: resume.map(str::to_owned),
            ..LaunchSpec::new("w-run", folder.to_string_lossy(), "mock-model")
        }
    };
    let session = run.engine.start(start(1, "pick a codename", None), run.bench.sink.clone()).await.expect("starts");
    run.bench.after_turns("w-run", 1).await;
    session.stop().await;
    std::fs::write(run.run.join("work/1/CLAUDE.md"), "MARK-LEFT-BEHIND").expect("left");

    run.engine.start(start(2, "which one?", Some("w-run")), run.bench.sink.clone()).await.expect("resumes");
    run.bench.after_turns("w-run", 2).await;

    let sent = run.requests();
    assert!(!sent.contains("MARK-LEFT-BEHIND"), "what the first start left does not load");
    let second = run.bench.request_text(1);
    assert!(second.contains("BLUEFIN") && second.contains("which one?"), "the conversation goes on: {second}");
}
