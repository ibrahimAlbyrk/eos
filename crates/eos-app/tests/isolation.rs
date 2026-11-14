//! A panic fails only the unit it happens in, in the composed app: a route
//! handler (that request answers 500, the next ones are served), an idle hook
//! (the hooks after it still run: a long chat is still compacted), an agent
//! event handler on the pump (the turn is still recorded and ends). A feature
//! whose start fails or panics does not keep the app from opening: its routes
//! answer 503 naming it, its hooks never run, and the user is told. What the
//! app cannot run without (its database) still fails the start.

#[path = "support/rig.rs"]
mod rig;

use std::sync::Arc;
use std::time::Duration;

use eos_app::{App, Options};
use eos_contracts::AgentEvent;
use eos_runtime::access::Access;
use eos_runtime::http::{ApiError, Method, Request, Response};
use eos_runtime::idle::IdleHook;
use eos_runtime::module::{Module, ModuleError};
use eos_runtime::router::{BoxFuture, RouteDef};
use eos_testkit::{ScriptedRuntime, TempHome};
use serde_json::json;

const WAIT: Duration = Duration::from_secs(20);

/// A module whose every part panics, and whose start can fail.
struct Faulty {
    start: Start,
    /// How often an agent event reached it.
    heard: Arc<std::sync::atomic::AtomicUsize>,
}

#[derive(Clone, Copy, PartialEq)]
enum Start {
    Fine,
    Fails,
    Panics,
}

impl Module for Faulty {
    fn id(&self) -> &'static str {
        "faulty"
    }

    fn routes(&self) -> Vec<RouteDef> {
        async fn boom(_req: Request) -> Result<Response, ApiError> {
            panic!("a route bug")
        }
        vec![RouteDef::get("/test/boom", boom).access(Access::open())]
    }

    fn idle_hooks(&self) -> Vec<IdleHook> {
        // First of all hooks: the ones after it must still run.
        vec![IdleHook::new("faulty", 1, |_worker: &str| async { panic!("an idle hook bug") })]
    }

    fn on_agent_event(&self, _worker_id: &str, _event: &AgentEvent) {
        self.heard.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        panic!("an agent event bug");
    }

    fn start(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        let start = self.start;
        Box::pin(async move {
            match start {
                Start::Fine => Ok(()),
                Start::Fails => Err("its folder is unreadable".into()),
                Start::Panics => panic!("a start bug"),
            }
        })
    }
}

fn app_with(home: &TempHome, agents: &ScriptedRuntime, faulty: Faulty) -> App {
    // The rig's options, plus the faulty module.
    let options = Options {
        launchd: None,
        agents: eos_app::AgentOptions {
            claude_home: Some(home.path().join("claude-home")),
            no_mcp: true,
            credential: Some(eos_core::accounts::SessionCredential::ApiKey {
                provider: "anthropic".into(),
                key: "k".into(),
            }),
            runtime: Some(agents.port()),
            one_shot: Some(Arc::new(rig::Summarizer)),
            ..eos_app::AgentOptions::default()
        },
        extra_modules: vec![Arc::new(faulty)],
        ..Options::new(home.path())
    };
    App::build(options).expect("builds")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_panicking_route_hook_or_event_handler_fails_only_itself() {
    let home = TempHome::new();
    let folder = tempfile::tempdir().expect("a folder");
    let cwd = folder.path().canonicalize().expect("the folder").to_string_lossy().into_owned();
    let agents = ScriptedRuntime::new();
    agents.otherwise(rig::turn_for);
    let app = app_with(&home, &agents, Faulty { start: Start::Fine, heard: Arc::default() });
    app.start().await.expect("starts");

    // The route: its request fails, the app goes on serving, that route included.
    for _ in 0..3 {
        let (status, _) = rig::call(&app, Method::Get, "/test/boom", None).await;
        assert_eq!(status, 500);
        let (status, _) = rig::call(&app, Method::Get, "/workers", None).await;
        assert_eq!(status, 200);
    }

    // The pump and the idle edge: every event reaches the panicking handler,
    // the first hook panics at every idle edge; turns still end, rows are
    // still written, and compaction (a later hook) still runs.
    let mut frames = rig::Frames::new(rig::open_stream(&app, "").await.expect("a stream"));
    let chat = rig::focused_chat(&app, &cwd, "[tools] look").await;
    assert!(frames.until(WAIT, |f| rig::went(f, &chat, "IDLE")).await.is_some(), "the first turn ends");
    let big = json!({"text": "[big] keep going"});
    let (status, _) = rig::call(&app, Method::Post, &format!("/workers/{chat}/message"), Some(big)).await;
    assert!(status < 300);
    // The turn ends, then the idle edge compacts the chat (it works again, then
    // rests): each time the chat comes to rest, read what it recorded.
    let deadline = tokio::time::Instant::now() + WAIT;
    let recorded = loop {
        assert!(frames.until(WAIT, |f| rig::went(f, &chat, "IDLE")).await.is_some(), "the chat comes to rest");
        let (_, rows) =
            rig::call(&app, Method::Get, &format!("/workers/{chat}/events?limit=500&order=asc"), None).await;
        let rows = rows.as_array().cloned().unwrap_or_default();
        if rows.iter().any(|r| r["type"] == "compaction_completed") || tokio::time::Instant::now() > deadline {
            break rows;
        }
    };
    assert!(
        recorded.iter().any(|r| r["type"] == "compaction_completed"),
        "the compaction hook ran after the panicking one"
    );
    let tools = recorded.iter().any(|r| r["payload"].as_str().is_some_and(|p| p.contains("tool_call")));
    assert!(tools, "the tool turn was recorded");
    app.shutdown(Duration::from_secs(5)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_feature_that_cannot_start_is_set_aside_and_the_app_opens_without_it() {
    for (start, reason) in [(Start::Fails, "its folder is unreadable"), (Start::Panics, "panicked: a start bug")] {
        let home = TempHome::new();
        let folder = tempfile::tempdir().expect("a folder");
        let cwd = folder.path().canonicalize().expect("the folder").to_string_lossy().into_owned();
        let agents = ScriptedRuntime::new();
        let heard = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let app = app_with(&home, &agents, Faulty { start, heard: heard.clone() });
        let mut frames = rig::Frames::new(rig::open_stream(&app, "").await.expect("a stream"));
        app.start().await.expect("the app opens");

        let banner = frames.until(WAIT, |f| f["reason"] == "notification:fire").await.expect("the user is told");
        assert_eq!(banner["payload"]["title"], "The faulty feature could not start");
        assert_eq!(banner["payload"]["body"], reason);
        let (status, body) = rig::call(&app, Method::Get, "/test/boom", None).await;
        assert_eq!(status, 503);
        assert_eq!(
            body,
            json!({"error": format!("the faulty feature could not start: {reason}"), "code": "feature_failed"})
        );

        // The rest of the app works, and the feature's hooks stay out of it.
        let chat = rig::focused_chat(&app, &cwd, "hello").await;
        assert!(frames.until(WAIT, |f| rig::went(f, &chat, "IDLE")).await.is_some(), "a chat runs");
        assert_eq!(heard.load(std::sync::atomic::Ordering::SeqCst), 0, "no agent event reached the failed feature");
        let report = app.shutdown(Duration::from_secs(5)).await;
        assert!(report.clean(), "{report:?}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unreadable_database_still_fails_the_start() {
    let home = TempHome::new();
    // A folder where the database file should be.
    std::fs::create_dir_all(home.path().join("state.db")).expect("a folder");
    let agents = ScriptedRuntime::new();
    let built = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| rig::build(home.path(), &agents)));
    assert!(built.is_err(), "the app is not built on a database it cannot open");
}
