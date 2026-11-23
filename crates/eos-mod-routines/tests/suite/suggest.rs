//! Suggestions from repeated work: the night's read over the first requests
//! of the user's own top-level chats, one suggestion at most a week, never
//! the same task twice, never from a chat an agent or a routine started,
//! and "make it" handing the sentence to the architect.

use eos_contracts::{NameSource, RoutineState};
use eos_core::Clock;
use eos_core::store::{NewWorker, StoredRoutineSession};
use eos_domain::inbox::ItemKind;
use eos_runtime::module::Module;
use serde_json::{Value, json};

use crate::bench::Bench;

const DAY: i64 = 24 * 60 * 60 * 1000;

fn worker(id: &str, prompt: &str, parent: Option<&str>, started_at: i64) -> NewWorker {
    NewWorker {
        id: id.into(),
        prompt: prompt.into(),
        cwd: None,
        worktree_from: None,
        branch: None,
        name: None,
        name_source: NameSource::Default,
        pid: None,
        port: 0,
        started_at,
        parent_id: parent.map(str::to_owned),
        model: "sonnet".into(),
        effort: None,
        is_orchestrator: false,
        backend_kind: "claude".into(),
        backend_profile: None,
        agent_role: None,
        worker_definition: None,
        tool_scope: None,
        with_gateway: false,
        collaborate: false,
        worktree_dir: None,
        workspace_owner_id: None,
        workspace_ready: true,
        scratch: false,
    }
}

/// Three chats asking for standup notes, one started by an agent, one a
/// routine's session and one from a month ago.
fn chats(bench: &Bench) {
    let now = bench.clock.now_ms();
    bench
        .temp
        .store
        .write_blocking(move |tx, _| {
            for (n, day) in [(1, 1), (2, 5), (3, 9)] {
                let prompt = format!("write my standup notes from yesterday's commits ({n})");
                tx.workers().insert(&worker(&format!("w-{n}"), &prompt, None, now - day * DAY))?;
            }
            tx.workers().insert(&worker("w-child", "PLANTED child request", Some("w-1"), now))?;
            tx.workers().insert(&worker("w-run", "PLANTED run request", None, now))?;
            tx.routine_sessions().insert(&StoredRoutineSession {
                worker_id: "w-run".into(),
                routine_id: "rt-x".into(),
                run_id: Some("rn-x".into()),
                role: "solo".into(),
                agent_key: None,
                created_at: now,
            })?;
            tx.workers().insert(&worker("w-old", "PLANTED old request", None, now - 30 * DAY))
        })
        .expect("writes");
}

fn suggestion() -> Value {
    json!({ "sentence": "Every morning, write my standup notes from yesterday's commits", "taskKey": "Standup notes" })
}

/// The suggestions waiting for the user.
fn suggestions(bench: &Bench) -> Vec<eos_core::store::StoredItem> {
    let items = bench.temp.store.read_blocking(|tx| tx.inbox_items().waiting(100)).expect("reads");
    items.into_iter().filter(|item| item.kind == ItemKind::Suggestion).collect()
}

/// A later night: a module as after a restart reads again.
async fn another_night(bench: &Bench, days: i64) {
    bench.clock.advance(days * DAY);
    let module = bench.another_module();
    module.after_ready().await.expect("starts");
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_night_suggests_one_repeated_task_from_the_users_own_chats() {
    let bench = Bench::new(true);
    chats(&bench);
    bench.model.data(suggestion());
    bench.supervise().await;
    bench.model.until_asked(1).await;
    bench.eventually(|| suggestions(&bench).len() == 1).await;
    let item = suggestions(&bench).remove(0);
    let payload: Value = serde_json::from_str(&item.payload).expect("json");
    assert_eq!(payload["taskKey"], "standup-notes");
    assert_eq!(item.summary, "Every morning, write my standup notes from yesterday's commits");
    let prompt = bench.model.asked()[0].prompt.clone();
    assert!(prompt.contains("(1)") && prompt.contains("(2)") && prompt.contains("(3)"));
    assert!(!prompt.contains("PLANTED"), "only the user's own recent first requests: {prompt}");
    bench.module.stop().await;

    // The same day, then within the week: not read again.
    another_night(&bench, 0).await;
    another_night(&bench, 3).await;
    assert_eq!(bench.model.asked().len(), 1);
    // A week later it reads; the same task is not suggested twice.
    chats_again(&bench);
    bench.model.data(suggestion());
    another_night(&bench, 5).await;
    assert_eq!(bench.model.asked().len(), 2);
    assert_eq!(suggestions(&bench).len(), 1);
}

/// Fresh requests, as the user keeps asking.
fn chats_again(bench: &Bench) {
    let now = bench.clock.now_ms() + 5 * DAY;
    bench
        .temp
        .store
        .write_blocking(move |tx, _| {
            for n in 4..7 {
                tx.workers().insert(&worker(&format!("w-{n}"), "standup notes again", None, now - DAY))?;
            }
            Ok(())
        })
        .expect("writes");
}

#[tokio::test(flavor = "multi_thread")]
async fn fewer_than_three_requests_ask_nothing_and_make_it_starts_the_architect() {
    let bench = Bench::new(true);
    let now = bench.clock.now_ms();
    bench
        .temp
        .store
        .write_blocking(move |tx, _| tx.workers().insert(&worker("w-lone", "one request", None, now)))
        .expect("writes");
    bench.supervise().await;
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert!(bench.model.asked().is_empty(), "one request is not repeated work");
    bench.module.stop().await;

    chats(&bench);
    bench.model.data(suggestion());
    another_night(&bench, 1).await;
    bench.eventually(|| suggestions(&bench).len() == 1).await;
    let item = suggestions(&bench).remove(0);
    let module = bench.another_module();
    module.after_ready().await.expect("starts");
    bench.answer(&item, "dashboard", json!({"kind": "suggestion", "choice": "make_it"}));
    let drafts = || {
        let routines = bench.temp.store.read_blocking(|tx| tx.routines().list()).expect("reads");
        routines.into_iter().filter(|routine| routine.state == RoutineState::Draft).count()
    };
    bench.eventually(|| drafts() == 1).await;
    let state = bench
        .temp
        .store
        .read_blocking(|tx| tx.routine_suggestions().find("chat:standup-notes"))
        .expect("reads")
        .map(|s| s.state);
    assert_eq!(state.as_deref(), Some("taken"));
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn off_the_network_the_night_asks_the_model_nothing() {
    let bench = Bench::new(false);
    chats(&bench);
    bench.model.data(suggestion());
    bench.supervise().await;
    another_night(&bench, 1).await;
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert!(bench.model.asked().is_empty(), "a dev run, a replay or a data copy spends nothing unasked");
    assert!(suggestions(&bench).is_empty());
    bench.module.stop().await;
}
