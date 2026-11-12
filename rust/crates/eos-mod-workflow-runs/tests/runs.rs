//! Workflow runs over the real store, the session service and a scripted
//! runtime (`manager/modules/workflow-runs/__tests__`).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use eos_contracts::{
    AgentEvent, PtyConversationRow, WorkflowCompletedEvent, WorkflowCompletedEventStatus, WorkflowRunProgress,
    WorkflowRunSnapshot, WorkflowRunStatus, WorkflowStartedEvent,
};
use eos_core::BoxFuture;
use eos_core::agent::{FileStamp, WorkflowRunFiles};
use eos_domain::workflow_run::{apply_workflow_progress, empty_snapshot};
use eos_mod_workflow_runs::{Parts, WORKFLOW_PROGRESS, WorkflowRuns, WorkflowRunsModule};
use eos_runtime::access::Caller;
use eos_runtime::bus::EventReceiver;
use eos_runtime::http::{Method, Request};
use eos_runtime::jobs::JobStatus;
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_sessions::{NoHooks, SessionDeps, Sessions};
use eos_testkit::agent::Call;
use eos_testkit::{
    FakeClock, FakeConfig, FakeModelCatalog, FakePrompts, FakeRecents, FakeSleeper, FakeWorktrees, ScriptedRuntime,
    SeqIds, TempStore,
};
use serde_json::{Value, json};

const DIR: &str = "/engine/workflows/w-CHAT/subagents/workflows/wf_1";

/// The run files of one folder, in memory. An agent's file is as big as its
/// rows, and changes when they do.
#[derive(Default)]
struct Files {
    records: Mutex<HashMap<String, String>>,
    agents: Mutex<HashMap<(String, String), Vec<PtyConversationRow>>>,
    /// How many times a conversation was read.
    reads: std::sync::atomic::AtomicUsize,
}

impl WorkflowRunFiles for Files {
    fn record<'a>(&'a self, transcript_dir: &'a str) -> BoxFuture<'a, Option<String>> {
        Box::pin(std::future::ready(self.records.lock().expect("records").get(transcript_dir).cloned()))
    }

    fn agent_rows<'a>(
        &'a self,
        transcript_dir: &'a str,
        agent_id: &'a str,
    ) -> BoxFuture<'a, Option<Vec<PtyConversationRow>>> {
        let key = (transcript_dir.to_owned(), agent_id.to_owned());
        self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Box::pin(std::future::ready(self.agents.lock().expect("agents").get(&key).cloned()))
    }

    fn agent_stamp<'a>(&'a self, transcript_dir: &'a str, agent_id: &'a str) -> BoxFuture<'a, Option<FileStamp>> {
        let key = (transcript_dir.to_owned(), agent_id.to_owned());
        let stamp = self.agents.lock().expect("agents").get(&key).map(|rows| FileStamp {
            path: format!("{transcript_dir}/agent-{agent_id}.jsonl"),
            size: rows.len() as u64,
            modified_ms: rows.last().map_or(0, |row| row.id),
        });
        Box::pin(std::future::ready(stamp))
    }
}

struct Bench {
    runtime: Runtime,
    runs: WorkflowRuns,
    sessions: Sessions,
    agents: ScriptedRuntime,
    temp: TempStore,
    clock: Arc<FakeClock>,
    sleeper: Arc<FakeSleeper>,
    files: Arc<Files>,
    relayed: tokio::sync::Mutex<EventReceiver>,
}

fn snapshot(rows: Value) -> WorkflowRunSnapshot {
    apply_workflow_progress(&empty_snapshot(), &rows)
}

fn running_agent(index: i64) -> Value {
    json!({"type": "workflow_agent", "index": index, "label": format!("a{index}"), "phaseIndex": 1,
           "state": "progress", "startedAt": 1})
}

fn phases() -> Value {
    json!([{"type": "workflow_phase", "index": 1, "title": "Explore"}, running_agent(1)])
}

fn progress(snapshot: WorkflowRunSnapshot, updated_at: i64) -> WorkflowRunProgress {
    WorkflowRunProgress {
        worker_id: "w-CHAT".into(),
        call_id: "call_1".into(),
        task_id: "t1".into(),
        status: WorkflowRunStatus::Running,
        snapshot,
        usage: None,
        updated_at: updated_at.into(),
    }
}

fn started() -> AgentEvent {
    AgentEvent::WorkflowStarted(WorkflowStartedEvent {
        call_id: "call_1".into(),
        task_id: "t1".into(),
        run_id: Some("wf_1".into()),
        name: Some("review".into()),
        description: Some("Review the change".into()),
        transcript_dir: Some(DIR.into()),
    })
}

fn completed(status: WorkflowCompletedEventStatus, snapshot: Option<WorkflowRunSnapshot>) -> AgentEvent {
    AgentEvent::WorkflowCompleted(WorkflowCompletedEvent {
        call_id: "call_1".into(),
        task_id: "t1".into(),
        status,
        summary: Some("3 findings\nmore".into()),
        usage: None,
        snapshot,
    })
}

impl Bench {
    fn new() -> Self {
        let clock = Arc::new(FakeClock::at(1_000));
        let kernel = Kernel::new(KernelOptions { clock: clock.clone(), ..KernelOptions::default() });
        let temp = TempStore::seeded("/sandbox");
        let agents = ScriptedRuntime::new();
        let sessions = Sessions::new(SessionDeps {
            store: temp.port(),
            runtime: agents.port(),
            clock: clock.clone(),
            ids: Arc::new(SeqIds::new()),
            config: Arc::new(FakeConfig::default()),
            models: Arc::new(FakeModelCatalog::default()),
            prompts: Arc::new(FakePrompts::default()),
            worktrees: Arc::new(FakeWorktrees::default()),
            recents: Arc::new(FakeRecents::default()),
            hooks: Arc::new(NoHooks),
            sleeper: Arc::new(FakeSleeper::default()),
        });
        let (sleeper, files) = (Arc::new(FakeSleeper::default()), Arc::new(Files::default()));
        let relayed = tokio::sync::Mutex::new(kernel.bus.subscribe(&WORKFLOW_PROGRESS, 64));
        let module = Arc::new(WorkflowRunsModule::new(Parts {
            store: temp.port(),
            sessions: Arc::new(sessions.clone()),
            files: files.clone(),
            bus: kernel.bus.clone(),
            jobs: kernel.jobs.clone(),
            clock: clock.clone(),
            sleeper: sleeper.clone(),
        }));
        let runs = module.runs().clone();
        let runtime = Runtime::build(kernel, vec![module], Arc::new(AllPluginsOn)).expect("composes");
        assert_eq!(runtime.router.undeclared(), Vec::<String>::new());
        Self { runtime, runs, sessions, agents, temp, clock, sleeper, files, relayed }
    }

    /// The next relayed message.
    async fn next(&self) -> Value {
        let mut relayed = self.relayed.lock().await;
        let event =
            tokio::time::timeout(Duration::from_secs(10), relayed.recv()).await.expect("a relay").expect("an event");
        event.payload_as().expect("json")
    }

    /// Nothing more was relayed.
    async fn quiet(&self) {
        self.runtime.kernel.bus.flush().await;
        let mut relayed = self.relayed.lock().await;
        let more = tokio::time::timeout(Duration::from_millis(20), relayed.recv()).await;
        assert!(more.is_err(), "nothing more: {more:?}");
    }

    async fn call(&self, method: Method, caller: Caller, target: &str) -> (u16, Value) {
        let response = self.runtime.router.handle(Request::new(method, target, caller)).await;
        let status = response.status;
        let bytes = response.body.collect().await.expect("a body");
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    async fn get(&self, target: &str) -> (u16, Value) {
        self.call(Method::Get, Caller::UNTRUSTED, target).await
    }

    /// Records an agent event row of `w-CHAT` at `ts`, as the session service does.
    fn record(&self, ts: i64, event: &AgentEvent) {
        let payload = serde_json::to_string(event).expect("json").replace('\'', "''");
        self.temp.exec(&format!(
            "INSERT INTO events (worker_id, ts, type, payload) VALUES ('w-CHAT', {ts}, 'agent_event', '{payload}')"
        ));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn relays_the_first_snapshot_at_once_then_at_most_one_per_window_the_latest() {
    let bench = Bench::new();
    bench.runs.on_progress(&progress(snapshot(phases()), 1_000));
    let first = bench.next().await;
    assert_eq!((first["status"].as_str(), first["updatedAt"].as_i64()), (Some("running"), Some(1_000)));
    assert_eq!(first["snapshot"]["agents"].as_array().map(Vec::len), Some(1));
    assert!(first.get("usage").is_none());

    // Inside the window: held, and only the latest goes out when it ends.
    bench.clock.advance(100);
    bench.runs.on_progress(&progress(snapshot(json!([running_agent(1), running_agent(2)])), 1_100));
    bench.clock.advance(100);
    bench.runs.on_progress(&progress(snapshot(json!([running_agent(1), running_agent(2), running_agent(3)])), 1_200));
    bench.quiet().await;
    assert_eq!(bench.sleeper.pending(), [400], "one relay waits for the rest of the window");
    bench.clock.advance(300);
    assert!(bench.sleeper.wake());
    let held = bench.next().await;
    assert_eq!(
        (held["updatedAt"].as_i64(), held["snapshot"]["agents"].as_array().map(Vec::len)),
        (Some(1_200), Some(3))
    );
    bench.quiet().await;
    assert_eq!(bench.runs.live_count(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_runs_end_drops_it_cancels_a_held_relay_and_goes_out_at_once_with_its_status() {
    let bench = Bench::new();
    bench.runs.observe("w-CHAT", &started());
    bench.runs.on_progress(&progress(snapshot(phases()), 1_000));
    bench.next().await;
    bench.clock.advance(100);
    bench.runs.on_progress(&progress(snapshot(json!([running_agent(1), running_agent(2)])), 1_100));
    let jobs = bench.runtime.kernel.jobs.list();
    assert_eq!((jobs.len(), jobs[0].kind.as_str(), jobs[0].title.as_str()), (1, "workflow", "review"));
    assert_eq!((jobs[0].status, jobs[0].can_stop), (JobStatus::Running, false), "no live session to stop it through");

    bench.runs.observe("w-CHAT", &completed(WorkflowCompletedEventStatus::Stopped, None));
    let end = bench.next().await;
    assert_eq!(end["status"], "stopped");
    let states: Vec<&str> =
        end["snapshot"]["agents"].as_array().expect("agents").iter().filter_map(|a| a["state"].as_str()).collect();
    assert_eq!(states, ["cancelled", "cancelled"], "the last snapshot, with what was in flight ended");
    assert_eq!(bench.runs.live_count(), 0);
    // The relay that was waiting finds no run to speak for.
    assert!(bench.sleeper.wake());
    bench.quiet().await;
    let job = &bench.runtime.kernel.jobs.list()[0];
    assert_eq!((job.status, job.detail.as_deref()), (JobStatus::Stopped, Some("3 findings")));
}

#[tokio::test(flavor = "multi_thread")]
async fn lists_running_runs_with_their_launch_facts_and_phase_details_from_the_record() {
    let bench = Bench::new();
    assert_eq!(bench.get("/workers/w-CHAT/workflow-runs").await, (200, json!({"runs": []})));
    bench.runs.observe("w-CHAT", &started());
    bench.runs.on_progress(&progress(snapshot(phases()), 1_000));
    let record = json!({"phases": [{"title": "Explore", "detail": "read the code"}], "logs": ["starting"]});
    bench.files.records.lock().expect("records").insert(DIR.into(), record.to_string());

    let (status, list) = bench.get("/workers/w-CHAT/workflow-runs").await;
    let run = &list["runs"][0];
    assert_eq!(status, 200);
    let keys: Vec<&str> = run.as_object().expect("a run").keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        ["callId", "taskId", "runId", "name", "description", "status", "startedAt", "snapshot", "canStop"]
    );
    assert_eq!((&run["status"], &run["startedAt"], &run["canStop"]), (&json!("running"), &json!(1_000), &json!(false)));
    assert_eq!(run["snapshot"]["phases"], json!([{"index": 1, "title": "Explore", "detail": "read the code"}]));
    assert_eq!(run["snapshot"]["logs"], json!(["starting"]));
    assert_eq!(bench.get("/workers/w-CHAT/workflow-runs/call_1").await.1, *run);
    assert_eq!(bench.get("/workers/w-BARE/workflow-runs").await.1, json!({"runs": []}), "another worker's");
}

#[tokio::test(flavor = "multi_thread")]
async fn rebuilds_a_finished_run_from_its_two_events() {
    let bench = Bench::new();
    let unknown = bench.get("/workers/w-CHAT/workflow-runs/call_nope").await;
    assert_eq!(unknown, (404, json!({"error": "no workflow run with that call id"})));
    assert_eq!(bench.get("/workers/w-CHAT/workflow-runs/call.1").await.0, 404);

    // Started, never ended and not live: it was stopped with its session.
    bench.record(5_000, &started());
    let (_, lost) = bench.get("/workers/w-CHAT/workflow-runs/call_1").await;
    assert_eq!(
        (&lost["status"], &lost["startedAt"], &lost["canStop"]),
        (&json!("stopped"), &json!(5_000), &json!(false))
    );
    assert!(lost.get("endedAt").is_none());

    // An ended run never reports agents still running, even from an older record.
    let last = snapshot(json!([running_agent(1)]));
    bench.record(9_000, &completed(WorkflowCompletedEventStatus::Completed, Some(last)));
    let record = json!({"phases": [], "logs": ["done"], "workflowProgress": [running_agent(1), running_agent(2)]});
    bench.files.records.lock().expect("records").insert(DIR.into(), record.to_string());
    let (status, run) = bench.get("/workers/w-CHAT/workflow-runs/call_1").await;
    assert_eq!(status, 200);
    let keys: Vec<&str> = run.as_object().expect("a run").keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        [
            "callId",
            "taskId",
            "runId",
            "name",
            "description",
            "status",
            "startedAt",
            "endedAt",
            "summary",
            "snapshot",
            "canStop"
        ]
    );
    assert_eq!(
        (&run["status"], &run["endedAt"], &run["summary"]),
        (&json!("completed"), &json!(9_000), &json!("3 findings\nmore"))
    );
    assert_eq!(run["snapshot"]["agents"].as_array().map(Vec::len), Some(1), "the event's agents win over the record's");
    assert_eq!(run["snapshot"]["agents"][0]["state"], "done");
    assert_eq!(run["snapshot"]["logs"], json!(["done"]));
}

#[tokio::test(flavor = "multi_thread")]
async fn serves_an_agents_rows_and_refuses_ids_that_are_not_agent_ids() {
    let bench = Bench::new();
    bench.runs.observe("w-CHAT", &started());
    let rows: Vec<PtyConversationRow> = (1..=205)
        .map(|id| PtyConversationRow {
            id,
            ts: 0.0.into(),
            r#type: "user_message".into(),
            payload: Some(json!({"text": "hi"})),
        })
        .collect();
    bench.files.agents.lock().expect("agents").insert((DIR.into(), "a0123456789abcdef".into()), rows);

    let (status, body) = bench.get("/workers/w-CHAT/workflow-runs/call_1/agents/a0123456789abcdef").await;
    let rows = body["rows"].as_array().expect("rows");
    assert_eq!((status, rows.len(), rows[0]["id"].as_i64()), (200, 200, Some(6)), "the newest 200");
    assert_eq!(rows[0], json!({"id": 6, "ts": 0, "type": "user_message", "payload": {"text": "hi"}}));
    for bad in ["agent-nope", "A0123456789ABCDEF", "abc", "aunknown00"] {
        let refused = bench.get(&format!("/workers/w-CHAT/workflow-runs/call_1/agents/{bad}")).await;
        assert_eq!(refused, (404, json!({"error": "no transcript for that agent"})), "{bad}");
    }
    // A finished run's rows are found through its recorded start.
    bench.record(5_000, &started());
    bench.runs.observe("w-CHAT", &completed(WorkflowCompletedEventStatus::Completed, None));
    assert_eq!(bench.get("/workers/w-CHAT/workflow-runs/call_1/agents/a0123456789abcdef").await.0, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_needs_the_user_and_stops_the_runs_task_through_its_session() {
    let bench = Bench::new();
    let stop = "/workers/w-CHAT/workflow-runs/call_1/stop";
    assert_eq!(bench.call(Method::Post, Caller::UNTRUSTED, stop).await, (403, json!({"error": "ui token required"})));
    let unknown = bench.call(Method::Post, Caller::DASHBOARD, stop).await;
    assert_eq!(unknown, (404, json!({"error": "no running workflow with that call id"})));

    bench.runs.observe("w-CHAT", &started());
    let down = bench.call(Method::Post, Caller::DASHBOARD, stop).await;
    assert_eq!(down, (409, json!({"error": "this session can't stop a workflow"})));

    bench.sessions.resume("w-CHAT").await.expect("resumes");
    let (_, list) = bench.get("/workers/w-CHAT/workflow-runs").await;
    assert_eq!(list["runs"][0]["canStop"], true);
    assert!(bench.runtime.kernel.jobs.list()[0].can_stop);
    assert_eq!(bench.call(Method::Post, Caller::DASHBOARD, stop).await, (200, json!({"ok": true})));
    assert!(bench.agents.calls().contains(&Call::StopTask { worker_id: "w-CHAT".into(), task_id: "t1".into() }));
    assert_eq!(bench.runs.live_count(), 1, "the run's own end event closes it");
}

fn rows(count: i64) -> Vec<PtyConversationRow> {
    (1..=count)
        .map(|id| PtyConversationRow {
            id,
            ts: 0.0.into(),
            r#type: "user_message".into(),
            payload: Some(json!({"text": "hi"})),
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agents_conversation_is_read_again_only_once_its_file_changed() {
    let bench = Bench::new();
    bench.runs.observe("w-CHAT", &started());
    let reads = || bench.files.reads.load(std::sync::atomic::Ordering::SeqCst);
    let agent = |n: usize| format!("a{n:016}");
    let path = |n: usize| format!("/workers/w-CHAT/workflow-runs/call_1/agents/{}", agent(n));
    let write = |n: usize, count: i64| {
        bench.files.agents.lock().expect("agents").insert((DIR.into(), agent(n)), rows(count));
    };

    write(1, 3);
    assert_eq!(bench.get(&path(1)).await.1["rows"].as_array().map(Vec::len), Some(3));
    assert_eq!(bench.get(&path(1)).await.1["rows"].as_array().map(Vec::len), Some(3));
    assert_eq!(reads(), 1, "the same file: read once");
    write(1, 4);
    assert_eq!(bench.get(&path(1)).await.1["rows"].as_array().map(Vec::len), Some(4), "the file grew");
    assert_eq!(reads(), 2);

    // Four kept; a fifth pushes out the least recently read.
    for n in 2..=5 {
        write(n, 1);
        bench.get(&path(n)).await;
    }
    assert_eq!((reads(), bench.runs.kept_conversations()), (6, 4));
    bench.get(&path(1)).await;
    assert_eq!(reads(), 7, "the first one went");
    bench.get(&path(5)).await;
    assert_eq!(reads(), 7, "the last one stayed");

    // A run that ends lets its conversations go.
    bench.record(5_000, &started());
    bench.runs.observe("w-CHAT", &completed(WorkflowCompletedEventStatus::Completed, None));
    assert_eq!(bench.runs.kept_conversations(), 0);
    bench.get(&path(5)).await;
    assert_eq!(reads(), 8);
}
