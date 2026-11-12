//! Compaction end to end over the real store, the session service and a
//! scripted runtime, with a scripted summarizer
//! (`core/src/__tests__/CompactContext.test.ts`,
//! `manager/modules/compaction/__tests__/CompactionService.test.ts`).

use std::sync::{Arc, OnceLock};

use eos_contracts::{CatalogModel, WorkerState};
use eos_core::agent::{OneShotError, WorkerSessions};
use eos_core::store::{EventOrder, EventQuery, Store};
use eos_mod_compaction::{CompactionModule, CompactionService, Parts};
use eos_prompts::tool_names::tool_name_vars;
use eos_prompts::{PromptRegistry, PromptService};
use eos_runtime::module::Module;
use eos_runtime::{Kernel, KernelOptions};
use eos_sessions::{Dispatched, MessageInput, SessionDeps, SessionHooks, Sessions, SlashCommand, SpawnRequest};
use eos_store_files::prompts::LibraryPromptSource;
use eos_testkit::agent::Call;
use eos_testkit::{
    FakeClock, FakeConfig, FakeModelCatalog, FakePrompts, FakeRecents, FakeWorktrees, ScriptedOneShot, ScriptedRuntime,
    SeqIds, TempStore,
};
use serde_json::{Value, json};

/// The app's side of the session service: the module holds the worker, and
/// its hook runs at the idle edge.
#[derive(Default)]
struct Hooks {
    service: OnceLock<CompactionService>,
    idle: tokio::sync::Notify,
}

impl SessionHooks for Hooks {
    fn holds_worker(&self, worker_id: &str) -> bool {
        self.service.get().is_some_and(|s| s.is_compacting(worker_id))
    }

    fn idle(&self, _worker_id: &str) {
        self.idle.notify_one();
    }
}

struct Bench {
    sessions: Sessions,
    agents: ScriptedRuntime,
    temp: TempStore,
    model: Arc<ScriptedOneShot>,
    service: CompactionService,
    module: CompactionModule,
    hooks: Arc<Hooks>,
    kernel: Kernel,
}

const SUMMARY: &str = "<analysis>x</analysis><summary>the summary</summary>";

impl Bench {
    fn new(config: Value) -> Self {
        let temp = TempStore::new();
        let agents = ScriptedRuntime::new();
        let hooks = Arc::new(Hooks::default());
        let clock = Arc::new(FakeClock::new());
        let config = Arc::new(FakeConfig::new(config));
        // `opus` has a 200k window here.
        let opus = CatalogModel {
            id: "claude-opus-5-5".into(),
            display_name: "Opus".into(),
            created_at: "2026-05-01".into(),
            max_input_tokens: Some(200_000),
            max_tokens: None,
            effort_levels: None,
        };
        let models = Arc::new(FakeModelCatalog { models: vec![opus] });
        let sessions = Sessions::new(SessionDeps {
            store: temp.port(),
            runtime: agents.port(),
            clock: clock.clone(),
            ids: Arc::new(SeqIds::new()),
            config: config.clone(),
            models: models.clone(),
            prompts: Arc::new(FakePrompts::default()),
            worktrees: Arc::new(FakeWorktrees::default()),
            recents: Arc::new(FakeRecents::default()),
            hooks: hooks.clone(),
        });
        let library = Arc::new(LibraryPromptSource::embedded());
        let model = Arc::new(ScriptedOneShot::default());
        let kernel = Kernel::new(KernelOptions::default());
        let module = CompactionModule::new(Parts {
            store: temp.port(),
            sessions: Arc::new(sessions.clone()),
            config,
            models,
            summarizer: model.clone(),
            prompts: Arc::new(PromptService::new(Arc::new(PromptRegistry::new(library)), tool_name_vars())),
            clock,
            jobs: kernel.jobs.clone(),
        });
        let service = module.service().clone();
        let _ = hooks.service.set(service.clone());
        for declared in module.slash_commands() {
            let command = declared.command.downcast_ref::<Arc<dyn SlashCommand>>().expect("a session command");
            sessions.register_command(command.clone());
        }
        Self { sessions, agents, temp, model, service, module, hooks, kernel }
    }

    fn store(&self) -> Arc<dyn Store> {
        self.temp.port()
    }

    /// A chat that has had one turn and is idle, with `tokens` of context.
    async fn chat(&self, tokens: i64) -> String {
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
        let worker = id.clone();
        self.store().write(move |tx, _| tx.workers().set_context_tokens(&worker, tokens)).await.expect("writes");
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

    fn seeds(&self) -> Vec<String> {
        let calls = self.agents.calls();
        calls
            .into_iter()
            .filter_map(|c| match c {
                Call::ReplaceContext { seed, .. } => Some(seed),
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

fn threshold(at: f64) -> Value {
    json!({"compaction": {"enabled": true, "threshold": at, "timeoutMs": 60_000}})
}

#[tokio::test(flavor = "multi_thread")]
async fn summarizes_on_the_agents_model_seeds_the_session_drops_occupancy_and_records_the_boundary() {
    let bench = Bench::new(threshold(0.7));
    let id = bench.chat(140_000).await;
    bench.model.text(SUMMARY);

    let answer = bench.sessions.dispatch(bench.message(&id, "/compact   keep the API notes ")).await;
    assert_eq!(answer, Ok(Dispatched::Command(json!({"ok": true, "compacting": true}))));
    assert!(bench.service.is_compacting(&id), "held from the moment the command answers");
    bench.idle().await;

    assert_eq!(bench.kinds(&id).await, ["WORKING", "compaction_started", "compaction_completed", "IDLE"]);
    let asked = bench.model.asked();
    assert_eq!(asked[0].model.as_deref(), Some("opus"));
    assert_eq!(asked[0].timeout, Some(std::time::Duration::from_secs(60)));
    assert!(asked[0].schema.is_none() && asked[0].system.as_deref().is_some_and(|s| !s.is_empty()));
    assert!(asked[0].prompt.contains("[user]\n") && asked[0].prompt.contains("build the thing"), "{}", asked[0].prompt);
    assert!(asked[0].prompt.contains("keep the API notes"));

    let seeds = bench.seeds();
    assert_eq!(seeds.len(), 1);
    assert!(seeds[0].contains("the summary"), "{}", seeds[0]);

    let rows = bench.rows(&id).await;
    let started = &rows[1].1;
    assert_eq!(
        serde_json::to_string(started).expect("json"),
        r#"{"trigger":"manual","beforeTokens":140000,"pct":70,"instructions":"keep the API notes"}"#
    );
    let done = &rows[2].1;
    let keys: Vec<&str> = done.as_object().expect("an object").keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        ["trigger", "beforeTokens", "afterTokens", "pct", "turns", "summary", "durationMs", "instructions"]
    );
    assert_eq!(
        (&done["trigger"], &done["beforeTokens"], &done["pct"]),
        (&json!("manual"), &json!(140_000), &json!(70))
    );
    assert_eq!((&done["turns"], &done["summary"]), (&json!(1), &json!("the summary")));
    let (state, tokens) = bench.state(&id).await;
    assert_eq!(state, WorkerState::Idle);
    assert!(tokens < 140_000 && json!(tokens) == done["afterTokens"]);
    assert!(!bench.service.is_compacting(&id));
    assert!(bench.kernel.jobs.list().is_empty(), "the job is shown only while it runs");
    assert_eq!(bench.module.job_kinds(), ["compaction"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_the_old_conversation_when_the_summarizer_fails_and_still_settles_to_idle() {
    let bench = Bench::new(threshold(0.7));
    let id = bench.chat(140_000).await;
    bench.model.fail(OneShotError::TimedOut(std::time::Duration::from_secs(60)));

    assert!(bench.service.check_on_idle(&id).await, "at the threshold: the idle edge is taken");
    bench.idle().await;

    assert_eq!(bench.kinds(&id).await, ["WORKING", "compaction_started", "compaction_failed", "IDLE"]);
    let failed = bench.rows(&id).await.remove(2).1;
    assert_eq!(failed, json!({"trigger": "auto", "error": "summarizer timed out after 60s"}));
    assert!(bench.seeds().is_empty(), "the conversation was never replaced");
    assert_eq!(bench.state(&id).await, (WorkerState::Idle, 140_000));

    // Not again at the same occupancy; again once a turn moved the context.
    assert!(!bench.service.check_on_idle(&id).await, "no spinning at IDLE");
    let worker = id.clone();
    bench.store().write(move |tx, _| tx.workers().set_context_tokens(&worker, 160_000)).await.expect("writes");
    bench.model.text(SUMMARY);
    assert!(bench.service.check_on_idle(&id).await);
    bench.idle().await;
    assert_eq!(bench.seeds().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn fails_on_an_empty_summary() {
    let bench = Bench::new(threshold(0.7));
    let id = bench.chat(140_000).await;
    bench.model.text("<analysis>only thinking</analysis>");
    assert_eq!(bench.service.start(&id, "").await, Ok(()));
    bench.idle().await;
    let failed = bench.rows(&id).await.remove(2).1;
    assert_eq!(failed, json!({"trigger": "manual", "error": "the summarizer returned an empty summary"}));
    assert!(bench.seeds().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn leaves_the_edge_alone_below_the_threshold_when_off_or_when_the_worker_is_busy() {
    let bench = Bench::new(threshold(0.7));
    let below = bench.chat(100_000).await;
    assert!(!bench.service.check_on_idle(&below).await);
    assert!(!bench.service.check_on_idle("w-nope").await);

    let off = Bench::new(json!({"compaction": {"enabled": false, "threshold": 0.7}}));
    let id = off.chat(190_000).await;
    assert!(!off.service.check_on_idle(&id).await);
    // By hand it runs whatever the switch and the threshold say.
    off.model.text(SUMMARY);
    assert_eq!(off.service.start(&id, "focus on tests").await, Ok(()));
    assert_eq!(off.service.start(&id, "").await, Err("a compaction is already running".to_owned()));
    off.idle().await;
    assert!(off.model.asked()[0].prompt.contains("focus on tests"));

    // A live threshold change is followed.
    let high = Bench::new(threshold(0.8));
    let id = high.chat(150_000).await;
    assert!(!high.service.check_on_idle(&id).await, "75% is under 80%");
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_a_busy_agent_and_one_without_a_live_session() {
    let bench = Bench::new(threshold(0.7));
    let id = bench.chat(150_000).await;
    let gate = bench.agents.script_held(eos_testkit::Turn::reply("working"));
    bench.sessions.dispatch(bench.message(&id, "go")).await.expect("sends");
    bench.agents.running(1).await;
    assert_eq!(bench.service.start(&id, "").await, Err("the agent is busy".to_owned()));
    assert!(!bench.service.check_on_idle(&id).await);
    gate.release();
    bench.agents.settled().await;
    bench.idle().await;

    bench.sessions.suspend(&id, "test").await.expect("suspends");
    assert_eq!(bench.service.start(&id, "").await, Err("the agent is busy".to_owned()));
    assert_eq!(bench.service.start("w-nope", "").await, Err("worker not found".to_owned()));
    assert!(bench.rows(&id).await.is_empty(), "nothing was recorded");
}

#[tokio::test(flavor = "multi_thread")]
async fn messages_queue_while_it_holds_the_worker_and_go_out_at_its_idle_edge() {
    let bench = Bench::new(threshold(0.7));
    let id = bench.chat(150_000).await;
    let gate = bench.model.hold();
    bench.model.text(SUMMARY);
    assert!(bench.service.check_on_idle(&id).await);
    assert!(bench.service.is_compacting(&id));
    assert_eq!(bench.kernel.jobs.list().len(), 1);
    assert_eq!(bench.kernel.jobs.list()[0].title, "Compacting context");

    let queued = bench.sessions.dispatch(bench.message(&id, "next task")).await.expect("queues");
    assert!(matches!(queued, Dispatched::Queued { .. }), "{queued:?}");
    let sent_before = bench.agents.sent(&id).len();
    gate.notify_one();
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
    assert_eq!(bench.seeds().len(), 1, "after the conversation was replaced");
}

#[tokio::test(flavor = "multi_thread")]
async fn does_not_revive_an_agent_stopped_while_the_summarizer_ran() {
    let bench = Bench::new(threshold(0.7));
    let id = bench.chat(150_000).await;
    let gate = bench.model.hold();
    bench.model.text(SUMMARY);
    assert!(bench.service.check_on_idle(&id).await);
    bench.model.until_asked(1).await;
    WorkerSessions::session(&bench.sessions, &id).expect("a live session").stop().await;
    gate.notify_one();
    // The run ends without an idle edge: wait for its failure row.
    for _ in 0..200 {
        if bench.kinds(&id).await.iter().any(|k| k == "compaction_failed") {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let rows = bench.rows(&id).await;
    assert_eq!(rows.last().expect("a row").1, json!({"trigger": "auto", "error": "agent stopped during compaction"}));
    assert!(bench.seeds().is_empty());
    assert_ne!(bench.state(&id).await.0, WorkerState::Idle, "no IDLE over the stop");
    assert!(!bench.service.is_compacting(&id));
}
