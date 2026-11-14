//! A thousand sessions started and stopped leave nothing behind. Runs alone
//! in its own binary so the allocation counters see only this.

use std::sync::Arc;
use std::time::Duration;

use eos_agent_mock_api::MockApi;
use eos_agent_testkit::{AllocStats, CountingAlloc};
use eos_core::agent::{AgentRuntime, LaunchSpec};
use eos_engine::{Engine, EngineDeps, EngineOptions};
use eos_testkit::{EchoTool, FakeClock, FakeCredentials, FakePolicy, FakeToolSets, FakeUser, RecordingSink};

#[global_allocator]
static ALLOC: CountingAlloc = CountingAlloc;

const ROUNDS: usize = 10;
const PER_ROUND: usize = 100;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sessions_that_ended_hold_no_memory() {
    let mock = MockApi::start([]).await.expect("the mock API");
    let dir = tempfile::tempdir().expect("a folder");
    for sub in ["home", "project"] {
        std::fs::create_dir_all(dir.path().join(sub)).expect("a folder");
    }
    let options = EngineOptions {
        default_model: Some("mock-model".into()),
        base_url: Some(mock.base_url()),
        claude_home: Some(dir.path().join("home")),
        mcp: false,
        ..EngineOptions::new(dir.path().join("engine"))
    };
    let deps = EngineDeps {
        policy: Arc::new(FakePolicy::default()),
        tools: Arc::new(FakeToolSets(vec![EchoTool::named("mcp__worker__whoami")])),
        credentials: Arc::new(FakeCredentials::default()),
        questions: Arc::new(FakeUser::default()),
        clock: Arc::new(FakeClock::new()),
        secrets: Arc::new(eos_testkit::NoKeychain),
    };
    let engine = Engine::build(options, deps).await.expect("the engine");
    let project = dir.path().join("project").canonicalize().expect("the project");
    let project = project.to_string_lossy().into_owned();

    let mut live_bytes = Vec::new();
    let start = AllocStats::now();
    for round in 0..ROUNDS {
        // A sink per round: what it recorded is dropped with it.
        let sink = Arc::new(RecordingSink::default());
        let mut sessions = Vec::new();
        for n in 0..PER_ROUND {
            let spec = LaunchSpec::new(format!("w-{round}-{n}"), project.clone(), "mock-model");
            sessions.push(engine.start(spec, sink.clone()).await.expect("starts"));
        }
        assert_eq!(engine.live(), PER_ROUND);
        for session in &sessions {
            session.stop().await;
        }
        assert_eq!(engine.live(), 0);
        assert_eq!(sink.exits.lock().expect("exits").len(), PER_ROUND);
        drop(sessions);
        // The engine's agent tasks end on their own once their agents are dropped.
        while Arc::strong_count(&sink) > 1 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        drop(sink);
        tokio::time::sleep(Duration::from_millis(50)).await;
        live_bytes.push(AllocStats::now().since(&start).1);
    }

    // The first rounds fill caches that are per process, not per session.
    let (early, late) = (live_bytes[2], live_bytes[ROUNDS - 1]);
    let per_session = (late - early) / i64::try_from((ROUNDS - 3) * PER_ROUND).expect("fits");
    assert!(per_session < 256, "memory grows by {per_session} bytes per ended session: {live_bytes:?}");
}
