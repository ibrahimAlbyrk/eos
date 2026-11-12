//! An agent's background commands and monitors as jobs
//! (`manager/services/jobs/__tests__`: the agent task source).

use std::sync::Arc;

use eos_core::agent::{BackgroundTaskKind, BackgroundTaskUpdate, TaskOutcome};
use eos_mod_agent_jobs::AgentJobsModule;
use eos_runtime::access::Caller;
use eos_runtime::http::{Method, Request};
use eos_runtime::jobs::JobStatus;
use eos_runtime::module::Module;
use eos_runtime::{Kernel, KernelOptions};
use eos_sessions::{NoHooks, SessionDeps, Sessions};
use eos_testkit::agent::Call;
use eos_testkit::{
    FakeClock, FakeConfig, FakeModelCatalog, FakePrompts, FakeRecents, FakeWorktrees, ScriptedRuntime, SeqIds,
    TempStore,
};

struct Bench {
    module: AgentJobsModule,
    kernel: Kernel,
    sessions: Sessions,
    agents: ScriptedRuntime,
    _temp: TempStore,
}

fn bench() -> Bench {
    let temp = TempStore::seeded("/sandbox");
    let agents = ScriptedRuntime::new();
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
    });
    let kernel = Kernel::new(KernelOptions::default());
    let module = AgentJobsModule::new(kernel.jobs.clone(), Arc::new(sessions.clone()));
    Bench { module, kernel, sessions, agents, _temp: temp }
}

fn started(task: &str, kind: BackgroundTaskKind, title: &str, command: Option<&str>) -> BackgroundTaskUpdate {
    BackgroundTaskUpdate::Started {
        task_id: task.into(),
        call_id: format!("call_{task}"),
        kind,
        title: title.into(),
        command: command.map(str::to_owned),
        output_file: None,
    }
}

fn ended(task: &str, outcome: TaskOutcome, summary: Option<&str>, exit_code: Option<i64>) -> BackgroundTaskUpdate {
    BackgroundTaskUpdate::Ended {
        task_id: task.into(),
        outcome,
        summary: summary.map(str::to_owned),
        output_file: None,
        exit_code,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_background_command_is_a_job_from_its_start_to_its_end() {
    let b = bench();
    assert_eq!(b.module.job_kinds(), ["shell", "monitor"]);
    b.module.on_background_task("w-CHAT", &started("t1", BackgroundTaskKind::Shell, "Run the tests", Some("npm test")));
    b.module.on_background_task("w-CHAT", &started("t2", BackgroundTaskKind::Monitor, "Watch the log", None));
    let jobs = b.kernel.jobs.list();
    let ids: Vec<&str> = jobs.iter().map(|j| j.id.as_str()).collect();
    assert!(ids.contains(&"shell:w-CHAT:t1") && ids.contains(&"monitor:w-CHAT:t2"), "{ids:?}");
    let shell = jobs.iter().find(|j| j.kind == "shell").expect("the command");
    assert_eq!(
        (shell.title.as_str(), shell.command.as_deref(), shell.call_id.as_deref()),
        ("Run the tests", Some("npm test"), Some("call_t1"))
    );
    assert_eq!((shell.status, shell.can_stop, shell.has_output), (JobStatus::Running, false, false));

    // Its output file makes the output readable.
    let dir = std::env::temp_dir().join(format!("eos-agent-jobs-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("a folder");
    let file = dir.join("t1.output");
    std::fs::write(&file, "ok 12\n").expect("writes");
    let output =
        BackgroundTaskUpdate::Output { task_id: "t1".into(), output_file: file.to_string_lossy().into_owned() };
    b.module.on_background_task("w-CHAT", &output);
    assert_eq!(b.kernel.jobs.output("shell:w-CHAT:t1", 0).map(|o| o.text), Some("ok 12\n".to_owned()));

    // "Completed" with a non-zero exit code failed; the summary's first line is the detail.
    b.module
        .on_background_task("w-CHAT", &ended("t1", TaskOutcome::Completed, Some("\n3 tests failed\nmore"), Some(1)));
    b.module.on_background_task("w-CHAT", &ended("t2", TaskOutcome::Stopped, None, None));
    b.module.on_background_task("w-CHAT", &ended("t-unknown", TaskOutcome::Completed, None, Some(0)));
    let jobs = b.kernel.jobs.list();
    let shell = jobs.iter().find(|j| j.kind == "shell").expect("the command");
    assert_eq!(
        (shell.status, shell.detail.as_deref(), shell.exit_code),
        (JobStatus::Failed, Some("3 tests failed"), Some(1))
    );
    assert_eq!(jobs.iter().find(|j| j.kind == "monitor").map(|j| j.status), Some(JobStatus::Stopped));
    assert_eq!(jobs.len(), 2);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_job_is_stopped_through_the_session_that_runs_it() {
    let b = bench();
    b.module.on_background_task("w-CHAT", &started("t1", BackgroundTaskKind::Shell, "Serve", Some("npm run dev")));
    let routes = eos_runtime::router::Router::builder()
        .routes(eos_runtime::jobs::routes::routes(b.kernel.jobs.clone()))
        .build()
        .expect("routes");
    let stop = || routes.handle(Request::new(Method::Post, "/api/jobs/shell:w-CHAT:t1/stop", Caller::DASHBOARD));
    assert_eq!(stop().await.status, 409, "no live session to stop it through");

    b.sessions.resume("w-CHAT").await.expect("resumes");
    assert!(b.kernel.jobs.list()[0].can_stop);
    assert_eq!(stop().await.status, 200);
    assert!(b.agents.calls().contains(&Call::StopTask { worker_id: "w-CHAT".into(), task_id: "t1".into() }));
    assert_eq!(b.kernel.jobs.list()[0].status, JobStatus::Running, "the task's own end closes it");
}
