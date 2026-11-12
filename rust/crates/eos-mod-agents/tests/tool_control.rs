//! The feature as an agent's tools reach it: each operation answers what its
//! route answers, and a refusal carries the route's status and words.

use std::sync::Arc;

use eos_contracts::SpawnWorkerRequest;
use eos_core::agent::{Refused, WorkerControl};
use eos_git::Git;
use eos_kit_proc::{ProcessTrees, Runner};
use eos_mod_agents::{AgentsModule, Spawning, ToolControl};
use eos_prompts::tool_names::tool_name_vars;
use eos_prompts::{PromptRegistry, PromptService};
use eos_sessions::{NoHooks, SessionDeps, Sessions};
use eos_store_files::prompts::LibraryPromptSource;
use eos_store_files::worker_definitions::FsWorkerDefinitionFiles;
use eos_testkit::{
    FakeClock, FakeConfig, FakeModelCatalog, FakePrompts, FakeRecents, FakeScratch, FakeSettings, FakeWorktrees,
    ScriptedRuntime, SeqIds, TempStore, Turn,
};
use eos_workers::WorkerDefinitions;
use serde_json::json;

struct Bench {
    control: ToolControl,
    agents: ScriptedRuntime,
    sessions: Sessions,
    _temp: TempStore,
}

fn bench() -> Bench {
    let temp = TempStore::new();
    let agents = ScriptedRuntime::new();
    let clock = Arc::new(FakeClock::new());
    let ids = Arc::new(SeqIds::new());
    let config = Arc::new(FakeConfig::default());
    let library = Arc::new(LibraryPromptSource::with_overrides(Vec::new()));
    let spawning = Spawning {
        config: config.clone(),
        settings: Arc::new(FakeSettings::default()),
        prompts: Arc::new(PromptService::new(Arc::new(PromptRegistry::new(library)), tool_name_vars())),
        scratch: Arc::new(FakeScratch::default()),
    };
    let sessions = Sessions::new(SessionDeps {
        store: temp.port(),
        runtime: agents.port(),
        clock: clock.clone(),
        ids: ids.clone(),
        config,
        models: Arc::new(FakeModelCatalog::default()),
        prompts: Arc::new(FakePrompts::default()),
        worktrees: Arc::new(FakeWorktrees::default()),
        recents: Arc::new(FakeRecents::default()),
        hooks: Arc::new(NoHooks),
        sleeper: Arc::new(eos_testkit::FakeSleeper::default()),
    });
    let files = Arc::new(FsWorkerDefinitionFiles::new(temp.home.path().join("workers")));
    let definitions = Arc::new(WorkerDefinitions::new(files, temp.port(), clock.clone()));
    let module = AgentsModule::new(sessions.clone(), temp.port(), ids, definitions, spawning);
    let trees = ProcessTrees::new(eos_platform::isolate_command, |pid| eos_platform::kill_process_tree(pid).is_ok());
    let git = Arc::new(Git::new(Runner::new(trees), clock));
    let control = ToolControl::new(&module, git).expect("the routes compose");
    Bench { control, agents, sessions, _temp: temp }
}

fn spawn_request(parent: &str, cwd: &str) -> SpawnWorkerRequest {
    let request =
        json!({"prompt": "Fix the parser", "name": "fix-parser", "withGateway": true, "parentId": parent, "cwd": cwd});
    serde_json::from_value(request).expect("a request")
}

impl Bench {
    /// An orchestrator working in `cwd`.
    async fn orchestrator(&self, cwd: &str) -> String {
        self.agents.script(Turn::reply("ready"));
        let request = eos_sessions::SpawnRequest {
            prompt: "Coordinate".into(),
            cwd: Some(cwd.to_owned()),
            is_orchestrator: true,
            ..eos_sessions::SpawnRequest::default()
        };
        let id = self.sessions.spawn(request).await.expect("spawns").id;
        self.agents.settled().await;
        id
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_orchestrator_starts_directs_and_removes_its_worker() {
    let bench = bench();
    let folder = tempfile::tempdir().expect("a folder");
    let cwd = folder.path().to_string_lossy().into_owned();
    let orchestrator = bench.orchestrator(&cwd).await;

    // Git does not know the folder: a worker started there works in it as it is.
    let found = bench.control.folder(&orchestrator).await;
    assert_eq!((found.cwd.as_str(), found.git_repo), (cwd.as_str(), false));
    assert_eq!(bench.control.folder("w-nobody").await.cwd, "");

    bench.agents.script(Turn::reply("result: done"));
    let worker = bench.control.spawn(spawn_request(&orchestrator, &cwd)).await.expect("starts");
    assert_eq!(worker.isolation, "cwd");
    bench.agents.settled().await;

    bench.agents.script(Turn::reply("result: tests pass"));
    let sent = bench.control.message(&orchestrator, &worker.id, "Also run the tests.".into()).await.expect("sent");
    assert_eq!((sent.id.as_str(), sent.name.as_deref()), (worker.id.as_str(), Some("fix-parser")));
    bench.agents.settled().await;

    // Only its own workers: the route's refusals, status and words.
    let foreign = bench.control.message("o-other", &worker.id, "hi".into()).await;
    assert_eq!(foreign, Err(Refused::new(403, format!("worker {} is not managed by o-other", worker.id))));
    let unknown = bench.control.message(&orchestrator, "w-nobody", "hi".into()).await;
    assert_eq!(unknown, Err(Refused::new(404, "worker not found")));
    let not_mine = bench.control.kill("o-other", &worker.id).await;
    assert_eq!(not_mine, Err(Refused::new(403, format!("worker {} is not managed by o-other", worker.id))));
    assert_eq!(
        bench.control.kill(&orchestrator, "w-nobody").await,
        Err(Refused::new(404, "worker not found: w-nobody"))
    );
    // An agent does not remove itself through this door.
    assert!(bench.control.kill(&orchestrator, &orchestrator).await.is_err());

    let gone = bench.control.kill(&orchestrator, &worker.id).await.expect("removed");
    assert_eq!((gone.id.as_str(), gone.name.as_deref(), gone.removed), (worker.id.as_str(), Some("fix-parser"), true));
    assert!(bench.control.folder(&worker.id).await.cwd.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_request_the_route_refuses_is_refused_in_its_words() {
    let bench = bench();
    let folder = tempfile::tempdir().expect("a folder");
    let cwd = folder.path().to_string_lossy().into_owned();
    let orchestrator = bench.orchestrator(&cwd).await;
    let mut request = spawn_request(&orchestrator, &cwd);
    request.from = Some("no-such-worker".into());
    assert_eq!(bench.control.spawn(request).await, Err(Refused::new(400, "unknown worker definition: no-such-worker")));
}

#[tokio::test]
async fn what_this_feature_does_not_serve_yet_says_so() {
    let bench = bench();
    // A report answers as its route does; one from a worker nobody knows is refused.
    let report = bench.control.report("w-1", "result: done".into()).await.expect_err("an unknown worker");
    assert_eq!((report.status, report.message.as_str()), (404, "worker not found"));
    let integrate = bench.control.integrate("o-1", None).await.expect_err("not served");
    assert_eq!(integrate.status, 501);
}
