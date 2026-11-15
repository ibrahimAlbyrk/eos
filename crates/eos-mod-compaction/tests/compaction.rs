//! `/compact` end to end over the real store, the session service and a
//! scripted runtime whose sessions summarize as the engine does.

use std::sync::{Arc, OnceLock};

use eos_contracts::{CatalogModel, WorkerState};
use eos_core::agent::{CompactionNotice, CompactionWords, WorkerSessions};
use eos_core::store::{EventOrder, EventQuery, Store};
use eos_mod_compaction::{CompactionModule, CompactionService, Parts, Words};
use eos_prompts::tool_names::tool_name_vars;
use eos_prompts::{PromptRegistry, PromptService};
use eos_runtime::module::Module;
use eos_runtime::{Kernel, KernelOptions};
use eos_sessions::{
    CommandAnswer, Dispatched, MessageInput, SessionDeps, SessionHooks, Sessions, SlashCommand, SpawnRequest,
};
use eos_store_files::prompts::LibraryPromptSource;
use eos_testkit::agent::Call;
use eos_testkit::{
    COMPACT_AFTER_TOKENS, COMPACT_SUMMARY, FakeClock, FakeConfig, FakeModelCatalog, FakePrompts, FakeRecents,
    FakeWorktrees, ScriptedRuntime, SeqIds, TempStore,
};
use serde_json::{Value, json};

/// The app's side of the session service: the module holds the worker and
/// hears each summary.
#[derive(Default)]
struct Hooks {
    module: OnceLock<Arc<CompactionModule>>,
    idle: tokio::sync::Notify,
}

impl SessionHooks for Hooks {
    fn holds_worker(&self, worker_id: &str) -> bool {
        self.module.get().is_some_and(|m| m.holds_worker(worker_id))
    }

    fn idle(&self, _worker_id: &str) {
        self.idle.notify_one();
    }

    fn compaction(&self, worker_id: &str, notice: &CompactionNotice) {
        if let Some(module) = self.module.get() {
            module.on_compaction(worker_id, notice);
        }
    }
}

struct Bench {
    sessions: Sessions,
    agents: ScriptedRuntime,
    temp: TempStore,
    service: CompactionService,
    module: Arc<CompactionModule>,
    hooks: Arc<Hooks>,
    kernel: Kernel,
    /// The session service holds the module's commands weakly.
    _commands: Vec<Arc<dyn SlashCommand>>,
}

impl Bench {
    fn new() -> Self {
        let temp = TempStore::new();
        let agents = ScriptedRuntime::new();
        let hooks = Arc::new(Hooks::default());
        let clock = Arc::new(FakeClock::new());
        let config = json!({"compaction": {"enabled": true, "threshold": 0.7, "timeoutMs": 60_000}});
        let opus = CatalogModel {
            id: "claude-opus-5-5".into(),
            display_name: "Opus".into(),
            created_at: "2026-05-01".into(),
            max_input_tokens: Some(1_000_000),
            max_tokens: None,
            effort_levels: None,
        };
        let sessions = Sessions::new(SessionDeps {
            store: temp.port(),
            runtime: agents.port(),
            clock: clock.clone(),
            ids: Arc::new(SeqIds::new()),
            config: Arc::new(FakeConfig::new(config)),
            models: Arc::new(FakeModelCatalog { models: vec![opus] }),
            prompts: Arc::new(FakePrompts::default()),
            worktrees: Arc::new(FakeWorktrees::default()),
            recents: Arc::new(FakeRecents::default()),
            hooks: hooks.clone(),
            sleeper: Arc::new(eos_testkit::FakeSleeper::default()),
        });
        let kernel = Kernel::new(KernelOptions::default());
        let module = Arc::new(CompactionModule::new(Parts {
            store: temp.port(),
            sessions: Arc::new(sessions.clone()),
            clock,
            jobs: kernel.jobs.clone(),
        }));
        let service = module.service().clone();
        let _ = hooks.module.set(module.clone());
        let mut commands = Vec::new();
        for declared in module.slash_commands() {
            let command = declared.command.downcast_ref::<Arc<dyn SlashCommand>>().expect("a session command");
            sessions.register_command(command);
            commands.push(command.clone());
        }
        Self { sessions, agents, temp, service, module, hooks, kernel, _commands: commands }
    }

    fn store(&self) -> Arc<dyn Store> {
        self.temp.port()
    }

    /// A chat that has had one turn and is idle.
    async fn chat(&self) -> String {
        let request = SpawnRequest {
            prompt: "build the thing".into(),
            cwd: Some("/sandbox/alpha".into()),
            role: Some("focused".into()),
            model: Some("opus".into()),
            ..SpawnRequest::default()
        };
        let id = self.sessions.spawn(request).await.expect("spawns").id;
        self.agents.settled().await;
        self.hooks.idle.notified().await;
        id
    }

    async fn state(&self, id: &str) -> (WorkerState, i64) {
        let id = id.to_owned();
        let worker = self.store().read(move |tx| tx.workers().find(&id)).await.expect("reads").expect("the row");
        (worker.state, worker.last_context_tokens.unwrap_or(0))
    }

    /// The worker's compaction rows and state changes for it, oldest first.
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
            .filter(|(kind, p)| kind.starts_with("compaction_") || p["reason"] == "compaction")
            .collect()
    }

    async fn kinds(&self, id: &str) -> Vec<String> {
        self.rows(id).await.into_iter().map(|(kind, p)| p["state"].as_str().map_or(kind, str::to_owned)).collect()
    }

    fn compacts(&self) -> Vec<Option<String>> {
        let calls = self.agents.calls();
        calls
            .into_iter()
            .filter_map(|c| match c {
                Call::Compact { instructions, .. } => Some(instructions),
                _ => None,
            })
            .collect()
    }

    fn message(&self, id: &str, text: &str) -> MessageInput {
        MessageInput { worker_id: id.into(), text: text.into(), queue_when_busy: true, ..MessageInput::default() }
    }

    /// The worker's next idle edge with an empty queue.
    async fn idle(&self) {
        self.hooks.idle.notified().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn compact_summarizes_the_session_records_the_boundary_and_settles_to_idle() {
    let bench = Bench::new();
    let id = bench.chat().await;

    let answer = bench.sessions.dispatch(bench.message(&id, "/compact   keep the API notes ")).await;
    assert_eq!(answer, Ok(Dispatched::Command(CommandAnswer::new(202, json!({"ok": true, "compacting": true})))));
    assert!(bench.service.is_compacting(&id), "held from the moment the command answers");
    bench.idle().await;

    assert_eq!(bench.compacts(), [Some("keep the API notes".to_owned())]);
    assert_eq!(bench.kinds(&id).await, ["WORKING", "compaction_started", "compaction_completed", "IDLE"]);
    let rows = bench.rows(&id).await;
    assert_eq!(
        serde_json::to_string(&rows[1].1).expect("json"),
        r#"{"trigger":"manual","beforeTokens":950000,"pct":95,"instructions":"keep the API notes"}"#
    );
    let done = &rows[2].1;
    let keys: Vec<&str> = done.as_object().expect("an object").keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        ["trigger", "beforeTokens", "afterTokens", "pct", "turns", "summary", "durationMs", "instructions"]
    );
    assert_eq!((&done["turns"], &done["summary"]), (&json!(1), &json!(COMPACT_SUMMARY)));
    assert_eq!(bench.state(&id).await, (WorkerState::Idle, COMPACT_AFTER_TOKENS));
    assert!(!bench.service.is_compacting(&id));
    assert!(bench.kernel.jobs.list().is_empty(), "the job is shown only while it runs");
    assert_eq!(bench.module.job_kinds(), ["compaction"]);

    // Nothing said since: nothing to summarize, and the line says so.
    assert_eq!(bench.service.start(&id, "").await, Ok(()));
    bench.idle().await;
    let rows = bench.rows(&id).await;
    let last = rows.iter().rev().find(|(kind, _)| kind.starts_with("compaction_")).expect("a row");
    assert_eq!(
        last,
        &("compaction_failed".to_owned(), json!({"trigger": "manual", "error": "nothing to compact yet"}))
    );
    assert_eq!(bench.state(&id).await.0, WorkerState::Idle);
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_a_busy_agent_and_one_without_a_live_session() {
    let bench = Bench::new();
    let id = bench.chat().await;
    let gate = bench.agents.script_held(eos_testkit::Turn::reply("working"));
    bench.sessions.dispatch(bench.message(&id, "go")).await.expect("sends");
    bench.agents.running(1).await;
    assert_eq!(bench.service.start(&id, "").await, Err("cannot compact from state WORKING".to_owned()));
    assert!(!bench.service.is_compacting(&id), "a refused run holds nothing");
    gate.release();
    bench.agents.settled().await;
    bench.idle().await;

    bench.sessions.suspend(&id, "test").await.expect("suspends");
    assert_eq!(bench.service.start(&id, "").await, Err("this agent cannot be compacted".to_owned()));
    assert_eq!(bench.service.start("w-nope", "").await, Err("this agent cannot be compacted".to_owned()));
    assert!(bench.rows(&id).await.is_empty(), "nothing was recorded");
    assert!(bench.compacts().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn messages_queue_while_it_holds_the_worker_and_go_out_at_its_idle_edge() {
    let bench = Bench::new();
    let id = bench.chat().await;
    let gate = bench.agents.hold_next_compaction();
    assert_eq!(bench.service.start(&id, "").await, Ok(()));
    assert_eq!(bench.service.start(&id, "").await, Err("a compaction is already running".to_owned()));
    for _ in 0..2000 {
        if !bench.kernel.jobs.list().is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    }
    assert_eq!(bench.kernel.jobs.list().len(), 1, "shown while it runs");
    assert_eq!(bench.kernel.jobs.list()[0].title, "Compacting context");

    let queued = bench.sessions.dispatch(bench.message(&id, "next task")).await.expect("queues");
    assert!(matches!(queued, Dispatched::Queued { .. }), "{queued:?}");
    let sent_before = bench.agents.sent(&id).len();
    gate.release();
    // The queued message is delivered at the compaction's idle edge, as a turn of its own.
    for _ in 0..2000 {
        if bench.agents.sent(&id).len() > sent_before {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    }
    bench.agents.settled().await;

    let sent = bench.agents.sent(&id);
    assert_eq!(sent.len(), sent_before + 1, "the queued message went out once the compaction ended");
    assert!(sent[sent_before].contains("next task"));
    assert!(bench.kinds(&id).await.iter().any(|k| k == "compaction_completed"), "after the summary");
}

#[tokio::test(flavor = "multi_thread")]
async fn does_not_revive_an_agent_stopped_while_it_summarized() {
    let bench = Bench::new();
    let id = bench.chat().await;
    let gate = bench.agents.hold_next_compaction();
    assert_eq!(bench.service.start(&id, "").await, Ok(()));
    for _ in 0..2000 {
        if bench.kinds(&id).await.iter().any(|k| k == "compaction_started") {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    }
    WorkerSessions::session(&bench.sessions, &id).expect("a live session").stop().await;
    gate.release();
    for _ in 0..2000 {
        if !bench.service.is_compacting(&id) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    }
    assert!(!bench.service.is_compacting(&id));
    assert_ne!(bench.state(&id).await.0, WorkerState::Idle, "no IDLE over the stop");
}

#[test]
fn the_library_words_ask_for_a_summary_and_carry_it_on() {
    let library = Arc::new(LibraryPromptSource::embedded());
    let words = Words::new(Arc::new(PromptService::new(Arc::new(PromptRegistry::new(library)), tool_name_vars())));
    let asked = words.instruction(Some("keep the API notes"));
    assert!(asked.contains("Do NOT call any tools") && asked.contains("<summary>"), "{asked}");
    assert!(asked.contains("keep the API notes"), "{asked}");
    assert!(!words.instruction(None).contains("Additional instructions"));
    let seed = words.seed("1. Task: build the thing", "/e/w-1.*.jsonl");
    assert!(seed.contains("<compaction_summary>\n1. Task: build the thing\n</compaction_summary>"), "{seed}");
    assert!(seed.contains("/e/w-1.*.jsonl") && seed.contains("Continue the conversation"), "{seed}");
}
