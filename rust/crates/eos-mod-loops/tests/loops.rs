//! The goal loop with scripted agents and a scripted judge: what each tick
//! does to the loop, what the worker and its orchestrator are sent
//! (`core/src/__tests__/runLoopTick.test.ts`, `manager/services/__tests__/GoalLoopService.test.ts`,
//! `manager/routes/__tests__/loops.test.ts`). No model is asked; verify
//! commands are `true`, `false` and `exit 3` in a temporary folder.

use std::sync::Arc;

use eos_core::store::Store;
use eos_domain::WorkerLoop;
use eos_kit_proc::{ProcessTrees, Runner};
use eos_mod_loops::{LoopsModule, Parts, ShellCommands};
use eos_prompts::tool_names::tool_name_vars;
use eos_prompts::{PromptRegistry, PromptService};
use eos_runtime::access::Caller;
use eos_runtime::http::{Method, Request};
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_sessions::{NoHooks, SessionDeps, Sessions, SpawnRequest};
use eos_store_files::prompts::LibraryPromptSource;
use eos_testkit::{
    FakeClock, FakeConfig, FakeModelCatalog, FakePrompts, FakeRecents, FakeSleeper, FakeWorktrees, ScriptedOneShot,
    ScriptedRuntime, SeqIds, TempStore, Turn,
};
use serde_json::{Value, json};

/// The judge's verdict as it would answer.
fn judged(met: bool, unmet: &[&str]) -> String {
    let criteria: Vec<Value> =
        ["c1"].iter().map(|id| json!({"id": id, "met": !unmet.contains(id), "evidence": "src/a.ts line 3"})).collect();
    json!({"met": met, "criteria": criteria, "unmet": unmet, "confidence": 0.8, "reason": "graded"}).to_string()
}

struct Bench {
    runtime: Runtime,
    module: Arc<LoopsModule>,
    agents: ScriptedRuntime,
    sessions: Sessions,
    judge: Arc<ScriptedOneShot>,
    temp: TempStore,
    folder: tempfile::TempDir,
    boss: String,
    worker: String,
}

impl Bench {
    async fn new() -> Self {
        let temp = TempStore::new();
        let folder = tempfile::tempdir().expect("a folder");
        let agents = ScriptedRuntime::new();
        let clock = Arc::new(FakeClock::new());
        let ids = Arc::new(SeqIds::new());
        let config = Arc::new(FakeConfig::new(json!({"loop": {"enabled": true, "noProgressWindow": 3}})));
        let sessions = Sessions::new(SessionDeps {
            store: temp.port(),
            runtime: agents.port(),
            clock: clock.clone(),
            ids: ids.clone(),
            config: config.clone(),
            models: Arc::new(FakeModelCatalog::default()),
            prompts: Arc::new(FakePrompts::default()),
            worktrees: Arc::new(FakeWorktrees::default()),
            recents: Arc::new(FakeRecents::default()),
            hooks: Arc::new(NoHooks),
            sleeper: Arc::new(FakeSleeper::default()),
        });
        let library = Arc::new(LibraryPromptSource::with_overrides(Vec::new()));
        let prompts = Arc::new(PromptService::new(Arc::new(PromptRegistry::new(library)), tool_name_vars()));
        let trees =
            ProcessTrees::new(eos_platform::isolate_command, |pid| eos_platform::kill_process_tree(pid).is_ok());
        let runner = Runner::new(trees.clone());
        let judge = Arc::new(ScriptedOneShot::default());
        let kernel = Kernel::new(KernelOptions::default());
        let module = Arc::new(LoopsModule::new(Parts {
            store: temp.port(),
            sessions: sessions.clone(),
            config,
            prompts,
            judge: judge.clone(),
            diffs: Arc::new(eos_git::Git::new(Runner::new(trees), clock)),
            commands: Arc::new(ShellCommands::new(runner, Some("/bin/sh".into()))),
            ids,
            bus: kernel.bus.clone(),
        }));
        let runtime = Runtime::build(kernel, vec![module.clone()], Arc::new(AllPluginsOn)).expect("composes");
        let cwd = folder.path().to_string_lossy().into_owned();
        agents.script(Turn::reply("on it"));
        let boss = SpawnRequest {
            prompt: "lead".into(),
            cwd: Some(cwd.clone()),
            is_orchestrator: true,
            ..SpawnRequest::default()
        };
        let boss = sessions.spawn(boss).await.expect("spawns").id;
        agents.settled().await;
        agents.script(Turn::reply("working"));
        let worker = SpawnRequest {
            prompt: "your part".into(),
            cwd: Some(cwd),
            parent_id: Some(boss.clone()),
            ..SpawnRequest::default()
        };
        let worker = sessions.spawn(worker).await.expect("spawns").id;
        agents.settled().await;
        Self { runtime, module, agents, sessions, judge, temp, folder, boss, worker }
    }

    async fn post(&self, target: &str, body: Value) -> (u16, Value) {
        let request = Request::new(Method::Post, target, Caller::DASHBOARD)
            .header("content-type", "application/json")
            .body(body.to_string());
        let res = self.runtime.router.handle(request).await;
        let status = res.status;
        let bytes = res.body.collect().await.expect("a body");
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    /// Arms a loop on the worker with these criteria.
    async fn arm(&self, strategy: &str, verify: Option<&str>, limit: Option<i64>) -> String {
        let mut criterion = json!({"id": "c1", "text": "src/a.ts exports run"});
        if let Some(verify) = verify {
            criterion["verify"] = json!(verify);
        }
        let mut body = json!({"op": "attach", "target": self.worker, "strategy": strategy,
                              "goal": {"summary": "Ship run", "criteria": [criterion]}});
        if let Some(limit) = limit {
            body["limit"] = json!(limit);
        }
        let (status, armed) = self.post(&format!("/orchestrators/{}/loop", self.boss), body).await;
        assert_eq!(status, 200, "{armed}");
        armed["loopId"].as_str().expect("a loop id").to_owned()
    }

    async fn the_loop(&self, id: &str) -> WorkerLoop {
        let (store, id): (Arc<dyn Store>, String) = (self.temp.port(), id.to_owned());
        store.read(move |tx| tx.loops().find(&id)).await.expect("reads").expect("the loop")
    }

    /// The worker reports, and its turn ends: the report is held.
    async fn report(&self, text: &str) {
        let reported = self.sessions.report(&self.worker, text).await.expect("reports");
        assert!(reported.held, "a looped worker's report is held");
    }

    /// One tick, and the turns it caused run to their end.
    async fn check(&self) {
        self.module.check(&self.worker).await.expect("ticks");
        self.agents.settled().await;
    }

    async fn timeline(&self, worker: &str, kind: &str) -> Vec<Value> {
        let (store, id): (Arc<dyn Store>, String) = (self.temp.port(), worker.to_owned());
        let query = eos_core::store::EventQuery {
            worker_id: id,
            since: 0,
            limit: 1000,
            order: eos_core::store::EventOrder::Asc,
            before_id: None,
            after_id: None,
        };
        let rows = store.read(move |tx| tx.events().list(&query)).await.expect("reads");
        rows.into_iter()
            .filter(|r| r.kind == kind)
            .map(|r| serde_json::from_str(r.payload.as_deref().unwrap_or("null")).expect("json"))
            .collect()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_goal_met_on_the_first_check_releases_the_held_report() {
    let bench = Bench::new().await;
    let id = bench.arm("command", Some("true"), None).await;
    bench.report("result: run is exported").await;
    assert_eq!(bench.the_loop(&id).await.held_report.as_deref(), Some("result: run is exported"));

    bench.agents.script(Turn::reply("thanks"));
    bench.check().await;

    let done = bench.the_loop(&id).await;
    assert_eq!((done.status, done.held_report), (eos_contracts::LoopStatus::Passed, None));
    let heard = bench.agents.sent(&bench.boss);
    assert!(heard.last().is_some_and(|m| m.contains("result: run is exported")), "{heard:?}");
    let checks = bench.timeline(&bench.worker, "loop_check").await;
    assert_eq!(checks.len(), 1);
    assert_eq!(
        (&checks[0]["outcome"], &checks[0]["met"], &checks[0]["attempt"]),
        (&json!("released"), &json!(true), &json!(1))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failing_command_sends_the_worker_back_and_a_later_pass_is_released() {
    let bench = Bench::new().await;
    let marker = bench.folder.path().join("done");
    let verify = format!("test -f '{}' || exit 3", marker.display());
    let id = bench.arm("command", Some(&verify), None).await;
    bench.report("result: done").await;

    bench.agents.script(Turn::reply("fixing"));
    bench.check().await;
    let looped = bench.the_loop(&id).await;
    assert_eq!((looped.status, looped.attempt, looped.held_report), (eos_contracts::LoopStatus::Active, 1, None));
    assert_eq!(looped.last_reason.as_deref(), Some("unmet: c1"));
    let sent = bench.agents.sent(&bench.worker);
    let nudge = sent.last().expect("a continuation");
    assert!(nudge.contains("kind=\"dynamic_loop\"") && nudge.contains("attempt=\"1\""), "{nudge}");
    assert!(nudge.contains(&format!("exit 3: {verify}")), "{nudge}");

    // The worker fixes it and reports again: the second check passes.
    std::fs::write(&marker, "").expect("the fix");
    bench.report("result: fixed").await;
    bench.agents.script(Turn::reply("thanks"));
    bench.check().await;
    assert_eq!(bench.the_loop(&id).await.status, eos_contracts::LoopStatus::Passed);
    assert!(bench.agents.sent(&bench.boss).last().is_some_and(|m| m.contains("result: fixed")));
    let outcomes: Vec<Value> =
        bench.timeline(&bench.worker, "loop_check").await.into_iter().map(|c| c["outcome"].clone()).collect();
    assert_eq!(outcomes, [json!("continued"), json!("released")]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_attempt_limit_ends_the_loop_and_the_report_goes_up_annotated() {
    let bench = Bench::new().await;
    let id = bench.arm("command", Some("false"), Some(1)).await;
    bench.agents.script(Turn::reply("again"));
    bench.check().await;
    assert_eq!(bench.the_loop(&id).await.attempt, 1);

    bench.report("result: I think it is done").await;
    bench.agents.script(Turn::reply("noted"));
    bench.check().await;
    let ended = bench.the_loop(&id).await;
    assert_eq!((ended.status, ended.held_report), (eos_contracts::LoopStatus::Exhausted, None));
    let heard = bench.agents.sent(&bench.boss);
    let last = heard.last().expect("the annotated report");
    assert!(last.contains("the attempt limit was reached") && last.contains("result: I think it is done"), "{last}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_judge_that_cannot_be_read_is_a_failed_check_not_a_verdict() {
    let bench = Bench::new().await;
    let id = bench.arm("judge", None, None).await;
    bench.report("result: done").await;
    bench.judge.text("I cannot decide").text("still not json");
    bench.agents.script(Turn::reply("checking"));
    bench.check().await;

    let looped = bench.the_loop(&id).await;
    assert_eq!((looped.check_failures, looped.attempt), (1, 0), "no attempt is counted");
    assert_eq!(looped.held_report.as_deref(), Some("result: done"), "the report is kept");
    assert_eq!(bench.judge.asked().len(), 2, "one retry");
    assert!(bench.judge.asked()[1].prompt.contains("Your previous reply was not valid JSON"));
    let nudge = bench.agents.sent(&bench.worker).pop().expect("a nudge");
    assert!(nudge.contains("dynamic_loop"), "{nudge}");

    // Twice in a row: the check is broken, the loop ends.
    bench.judge.text("nope").text("nope");
    bench.agents.script(Turn::reply("noted"));
    bench.check().await;
    assert_eq!(bench.the_loop(&id).await.status, eos_contracts::LoopStatus::Exhausted);
    let heard = bench.agents.sent(&bench.boss).pop().expect("the report");
    assert!(heard.contains("goal check failing (judge/evidence infrastructure)") && heard.contains("result: done"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_judge_grades_artifacts_and_its_met_releases_the_report() {
    let bench = Bench::new().await;
    std::fs::create_dir_all(bench.folder.path().join("src")).expect("src");
    std::fs::write(bench.folder.path().join("src/a.ts"), "export function run() {}\n").expect("a file");
    let id = bench.arm("hybrid", Some("true"), None).await;
    bench.report("result: exported").await;
    bench.judge.text(&format!("```json\n{}\n```", judged(true, &[])));
    bench.agents.script(Turn::reply("thanks"));
    bench.check().await;

    assert_eq!(bench.the_loop(&id).await.status, eos_contracts::LoopStatus::Passed);
    let prompt = &bench.judge.asked()[0].prompt;
    assert!(prompt.contains("[c1] $ true  ->  exit 0"), "the command's result is evidence");
    assert!(prompt.contains("export function run()"), "the file the criterion names is read");
    assert!(prompt.contains("result: exported"), "the report is shown as a claim");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stopped_loop_is_not_checked_and_unknowns_are_refused() {
    let bench = Bench::new().await;
    let id = bench.arm("command", Some("false"), None).await;
    let stopped = bench
        .post(&format!("/orchestrators/{}/loop/stop", bench.boss), json!({"op": "stop", "target": bench.worker}))
        .await;
    assert_eq!(stopped, (200, json!({"loopId": id, "status": "stopped"})));
    bench.check().await;
    assert!(bench.agents.sent(&bench.worker).iter().all(|m| !m.contains("dynamic_loop")), "nothing re-triggered");
    let again = bench
        .post(&format!("/orchestrators/{}/loop/stop", bench.boss), json!({"op": "stop", "target": bench.worker}))
        .await;
    assert_eq!(again, (404, json!({"error": format!("loop not found: {}", bench.worker)})));
    let by_id =
        bench.post(&format!("/orchestrators/{}/loop/stop", bench.boss), json!({"op": "stop", "loopId": id})).await;
    assert_eq!(by_id, (200, json!({"loopId": id, "status": "stopped"})), "an ended loop says how it ended");

    let no_goal = bench
        .post(&format!("/orchestrators/{}/loop", bench.boss), json!({"op": "attach", "target": bench.worker}))
        .await;
    assert_eq!(no_goal, (400, json!({"error": "goal required to attach a loop"})));
    let foreign = bench
        .post(
            &format!("/orchestrators/{}/loop", bench.worker),
            json!({"op": "attach", "goal": {"summary": "s", "criteria": [{"id": "c1", "text": "t"}]}}),
        )
        .await;
    assert_eq!(foreign.0, 403, "{}", foreign.1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_amended_goal_replaces_the_old_and_a_paused_loop_waits() {
    let bench = Bench::new().await;
    let id = bench.arm("command", Some("false"), None).await;
    let amended = bench
        .post(
            &format!("/orchestrators/{}/loop", bench.boss),
            json!({"op": "amend", "target": bench.worker, "goal": {"summary": "Ship it", "criteria": [{"id": "c9", "text": "x", "verify": "true"}]}, "limit": 5}),
        )
        .await;
    assert_eq!(amended, (200, json!({"loopId": id, "status": "active"})));
    let looped = bench.the_loop(&id).await;
    assert_eq!((looped.goal_spec().map(|g| g.summary), looped.max_attempts), (Some("Ship it".into()), Some(5)));

    // A worker that asked a question waits for the answer: no check runs.
    bench.agents.script(Turn::reply("which?"));
    let question = bench.sessions.report(&bench.worker, "needs input: which db?").await.expect("reports");
    assert!(question.delivered && !question.held);
    bench.agents.settled().await;
    bench.check().await;
    assert_eq!(bench.the_loop(&id).await.status, eos_contracts::LoopStatus::Active);
    assert!(bench.timeline(&bench.worker, "loop_check").await.is_empty());
}
