//! The micro-task runner and the auto-name task over the real store and bus,
//! with a scripted model.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use eos_core::agent::OneShotError;
use eos_mod_auto_name::{AUTO_NAME_TASK, AutoNameModule, MicroTasks, RunnerParts};
use eos_prompts::tool_names::tool_name_vars;
use eos_prompts::{PromptRegistry, PromptService};
use eos_runtime::access::Caller;
use eos_runtime::http::{Method, Request};
use eos_runtime::router::PluginSwitch;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_store_files::prompts::LibraryPromptSource;
use eos_testkit::{FakeClock, FakeConfig, FakeSleeper, ScriptedOneShot, TempStore};
use serde_json::{Value, json};

struct Switch(AtomicBool);

impl PluginSwitch for Switch {
    fn is_on(&self, _plugin: &str) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

struct Bench {
    runtime: Runtime,
    runner: MicroTasks,
    temp: TempStore,
    model: Arc<ScriptedOneShot>,
    sleeper: Arc<FakeSleeper>,
    clock: Arc<FakeClock>,
    plugin: Arc<Switch>,
}

/// Waits for `done` to hold; the runner works in tasks of its own.
async fn until(what: &str, done: impl Fn() -> bool) {
    for _ in 0..2000 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    panic!("never happened: {what}");
}

impl Bench {
    /// On the wire fixtures' rows, with `w-CHAT` (a focused chat) still under its default name.
    async fn new(config: Value) -> Self {
        let clock = Arc::new(FakeClock::at(1_000));
        let kernel = Kernel::new(KernelOptions { clock: clock.clone(), ..KernelOptions::default() });
        let temp = TempStore::seeded_on_bus("/sandbox", &kernel.bus);
        temp.exec("UPDATE workers SET name_source = 'default', agent_role = 'focused' WHERE id = 'w-CHAT'");
        let (model, sleeper) = (Arc::new(ScriptedOneShot::default()), Arc::new(FakeSleeper::default()));
        let plugin = Arc::new(Switch(AtomicBool::new(true)));
        let library = Arc::new(LibraryPromptSource::embedded());
        let parts = RunnerParts {
            bus: kernel.bus.clone(),
            one_shot: model.clone(),
            prompts: Arc::new(PromptService::new(Arc::new(PromptRegistry::new(library)), tool_name_vars())),
            config: Arc::new(FakeConfig::new(config)),
            plugins: plugin.clone(),
            clock: clock.clone(),
            sleeper: sleeper.clone(),
        };
        let module = Arc::new(AutoNameModule::new(parts, temp.port()));
        let runner = module.runner().clone();
        let runtime = Runtime::build(kernel, vec![module], plugin.clone()).expect("composes");
        assert_eq!(runtime.router.undeclared(), Vec::<String>::new());
        runtime.lifecycle.start().await.expect("starts");
        Self { runtime, runner, temp, model, sleeper, clock, plugin }
    }

    /// The chat starts its first turn.
    fn trigger(&self, worker: &str) {
        let change = json!({"workerId": worker, "rowId": 1, "from": "IDLE", "state": "WORKING"});
        self.runtime.kernel.bus.publish_raw("worker:change", None, change.to_string().into());
    }

    async fn armed(&self, waits: &[i64]) {
        let want = waits.to_vec();
        until(&format!("waits {want:?}, have {:?}", self.sleeper.pending()), || self.sleeper.pending() == want).await;
    }

    fn name(&self, worker: &'static str) -> (Option<String>, String) {
        let row = self.temp.store.read_blocking(move |tx| tx.workers().find(worker)).expect("reads").expect("a row");
        (row.name, format!("{:?}", row.name_source))
    }

    async fn intent(&self, worker: &str, active: Value) -> (u16, Value) {
        let req = Request::new(Method::Put, &format!("/workers/{worker}/rename-intent"), Caller::UNTRUSTED)
            .body(serde_json::to_vec(&json!({"active": active})).expect("json"));
        let response = self.runtime.router.handle(req).await;
        let status = response.status;
        let bytes = response.body.collect().await.expect("a body");
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_fresh_chat_is_named_once_from_its_first_request_after_the_delay() {
    let bench = Bench::new(json!({})).await;
    bench.trigger("w-CHAT");
    bench.armed(&[5000]).await;
    assert!(bench.model.asked().is_empty(), "nothing is asked before the delay is over");
    // A second trigger while it waits arms nothing more.
    bench.trigger("w-CHAT");
    bench.runtime.kernel.bus.flush().await;

    bench.model.text("\"empty input parser.\"\n");
    assert!(bench.sleeper.wake());
    until("the chat is renamed", || bench.name("w-CHAT").1 == "Some(Auto)").await;
    assert_eq!(bench.name("w-CHAT").0.as_deref(), Some("Empty Input Parser"));
    let asked = bench.model.asked();
    assert_eq!((asked.len(), asked[0].model.as_deref()), (1, Some("claude-sonnet-5-5")));
    assert_eq!(asked[0].timeout, Some(Duration::from_secs(120)));
    assert!(asked[0].system.is_none() && asked[0].schema.is_none());
    assert!(asked[0].prompt.contains("Fix the parser so empty input returns an empty list."), "{}", asked[0].prompt);
    assert_eq!(asked[0].prompt, asked[0].prompt.trim());
    let renamed = bench.temp.announced.list().pop().expect("an announcement");
    assert_eq!(renamed, ("worker:change", r#"{"workerId":"w-CHAT"}"#.to_owned()));

    // Handled once: later turns never ask again.
    bench.trigger("w-CHAT");
    bench.runtime.kernel.bus.flush().await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!((bench.runner.pending(), bench.sleeper.pending().len()), (0, 0));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_request_is_cut_to_the_limit_and_the_users_own_template_wins() {
    let config = json!({"microTasks": {"tasks": {"auto-name": {
        "enabled": true, "delayMs": 10, "model": "haiku", "charLimit": 10, "promptTemplate": "  Name: {{USER_INPUT}}  "
    }}}});
    let bench = Bench::new(config).await;
    bench.trigger("w-CHAT");
    bench.armed(&[10]).await;
    bench.model.text("NO_TITLE");
    assert!(bench.sleeper.wake());
    bench.model.until_asked(1).await;
    let asked = bench.model.asked();
    assert_eq!((asked[0].prompt.as_str(), asked[0].model.as_deref()), ("Name: Fix the pa", Some("haiku")));
    until("the run is over", || bench.runner.pending() == 0).await;
    assert_eq!(
        bench.name("w-CHAT"),
        (Some("Fix the parser".to_owned()), "Some(Default)".to_owned()),
        "the sentinel names nothing"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn only_a_top_level_chat_under_its_default_name_is_armed() {
    let bench = Bench::new(json!({})).await;
    // A worker of an orchestrator, a chat the user named, and events that are not a first turn.
    bench.temp.exec("UPDATE workers SET name_source = 'default' WHERE id = 'w-KID1'");
    bench.temp.exec("UPDATE workers SET name_source = 'user', agent_role = 'focused' WHERE id = 'w-BARE'");
    for worker in ["w-KID1", "w-BARE", "w-nope"] {
        bench.trigger(worker);
    }
    let bus = &bench.runtime.kernel.bus;
    for other in [
        json!({"workerId": "w-CHAT", "from": "WORKING", "state": "IDLE"}),
        json!({"workerId": "w-CHAT", "from": "ENDING", "state": "WORKING"}),
        json!({"workerId": "w-CHAT", "rowId": 5}),
        json!({"from": "IDLE", "state": "WORKING"}),
    ] {
        bus.publish_raw("worker:change", None, other.to_string().into());
    }
    // The orchestrator is armed; the plugin switched off arms nothing.
    bench.temp.exec("UPDATE workers SET name_source = 'default' WHERE id = 'o-ORCH'");
    bench.trigger("o-ORCH");
    bench.armed(&[5000]).await;
    bench.plugin.0.store(false, Ordering::SeqCst);
    bench.trigger("w-CHAT");
    bus.flush().await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(bench.runner.pending(), 1, "only the orchestrator's run");

    // With the plugin off its run asks nothing when the delay ends.
    assert!(bench.sleeper.wake());
    until("the run is over", || bench.runner.pending() == 0).await;
    assert!(bench.model.asked().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_rename_editor_pauses_the_wait_and_closing_it_resumes_what_was_left() {
    let bench = Bench::new(json!({})).await;
    bench.trigger("w-CHAT");
    bench.armed(&[5000]).await;
    bench.clock.advance(2000);
    assert_eq!(bench.intent("w-CHAT", json!(true)).await, (200, json!({"ok": true})));
    bench.armed(&[5000, 10_000]).await;
    assert_eq!(bench.intent("w-CHAT", json!(false)).await, (200, json!({"ok": true})));
    bench.armed(&[5000, 10_000, 3000]).await;
    // The first timer speaks for nobody any more; neither does the pause's own.
    assert!(bench.sleeper.wake() && bench.sleeper.wake());
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(bench.model.asked().is_empty());
    bench.model.text("Parser Fix");
    assert!(bench.sleeper.wake());
    until("the chat is renamed", || bench.name("w-CHAT").1 == "Some(Auto)").await;

    assert_eq!(bench.intent("w-CHAT", json!("yes")).await.0, 400);
    // For a chat with no pending run the signal does nothing.
    assert_eq!(bench.intent("w-BARE", json!(false)).await.0, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pause_before_the_trigger_holds_the_run_and_ends_by_itself() {
    let bench = Bench::new(json!({})).await;
    bench.runner.pause(AUTO_NAME_TASK, "w-CHAT");
    bench.trigger("w-CHAT");
    // Stored paused: only the pause's own deadline runs.
    bench.armed(&[10_000]).await;
    assert_eq!(bench.runner.pending(), 1);
    assert!(bench.sleeper.wake());
    // No resume ever came: the whole delay starts now.
    bench.armed(&[5000]).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rename_by_the_user_or_the_chats_end_drops_the_pending_run() {
    let bench = Bench::new(json!({})).await;
    let bus = &bench.runtime.kernel.bus;
    bench.trigger("w-CHAT");
    bench.armed(&[5000]).await;
    bus.publish_raw("worker:change", None, json!({"workerId": "w-CHAT", "renamedBy": "user"}).to_string().into());
    until("the run is cancelled", || bench.runner.pending() == 0).await;
    assert!(bench.sleeper.wake());
    bench.trigger("w-CHAT");
    bus.flush().await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(bench.model.asked().is_empty() && bench.runner.pending() == 0, "cancelled for good");

    bench.temp.exec("UPDATE workers SET name_source = 'default' WHERE id = 'o-ORCH'");
    bench.trigger("o-ORCH");
    bench.armed(&[5000]).await;
    bus.publish_raw("worker:exit", None, json!({"workerId": "o-ORCH", "code": 0}).to_string().into());
    until("the run is dropped", || bench.runner.pending() == 0).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failing_model_an_unnameable_request_and_a_switched_off_subsystem_leave_the_name_alone() {
    let bench = Bench::new(json!({})).await;
    bench.trigger("w-CHAT");
    bench.armed(&[5000]).await;
    bench.model.fail(OneShotError::NoCredential);
    assert!(bench.sleeper.wake());
    bench.model.until_asked(1).await;
    until("the run is over", || bench.runner.pending() == 0).await;
    assert_eq!(bench.name("w-CHAT").1, "Some(Default)");

    // "hi" is not worth a model request.
    bench.temp.exec("UPDATE workers SET name_source = 'default' WHERE id = 'o-ORCH'");
    bench.temp.exec("DELETE FROM events WHERE worker_id = 'o-ORCH'");
    bench.temp.exec(
        "INSERT INTO events (worker_id, ts, type, payload) VALUES ('o-ORCH', 1, 'user_message', '{\"text\":\"hi\"}')",
    );
    bench.trigger("o-ORCH");
    bench.armed(&[5000]).await;
    assert!(bench.sleeper.wake());
    until("the run is over", || bench.runner.pending() == 0).await;
    assert_eq!(bench.model.asked().len(), 1);

    let off = Bench::new(json!({"microTasks": {"enabled": false}})).await;
    off.trigger("w-CHAT");
    off.runtime.kernel.bus.flush().await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(off.runner.pending(), 0);
}
