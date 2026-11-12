//! A shut-down app is freed: building, starting, shutting down and dropping
//! many apps in one process leaves no descriptor or thread behind. The test
//! measures the process it runs in, so it is alone in its file.

#[path = "support/rig.rs"]
mod rig;

use std::sync::Arc;
use std::time::Duration;

use eos_app::{AgentOptions, App, Options};
use eos_testkit::{ScriptedRuntime, TempHome};

const APPS: usize = 50;

/// How the app runs its agents.
#[derive(Clone, Copy)]
enum Agents {
    /// A scripted runtime, as the long-run tests build it.
    Scripted,
    /// The engine and the accounts feature's credentials, as the real app
    /// builds it (nothing starts a session, so nothing is read or sent).
    Engine,
}

fn build(home: &TempHome, agents: Agents, scripted: &ScriptedRuntime) -> App {
    match agents {
        Agents::Scripted => rig::build(home.path(), scripted),
        Agents::Engine => App::build(Options {
            launchd: None,
            agents: AgentOptions {
                base_url: Some("http://127.0.0.1:9".into()),
                claude_home: Some(home.path().join("claude-home")),
                no_mcp: true,
                ..AgentOptions::default()
            },
            ..Options::new(home.path())
        })
        .expect("the app builds"),
    }
}

/// One app's whole life; what it held is free once it returns.
async fn one_app(agents: Agents) {
    let home = TempHome::new();
    let scripted = ScriptedRuntime::new();
    let app = build(&home, agents, &scripted);
    app.start().await.expect("starts");
    app.shutdown(Duration::from_secs(5)).await;
    let store = Arc::downgrade(&app.store());
    drop(app);
    assert_eq!(store.strong_count(), 0, "the database is still held once the app is dropped");
}

/// Descriptors and threads once they held still for a second (a thread that
/// was told to stop needs a moment to end).
async fn settled() -> (usize, usize) {
    let mut last = (rig::fds(), rig::threads());
    let mut held = 0;
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let now = (rig::fds(), rig::threads());
        held = if now == last { held + 1 } else { 0 };
        last = now;
        if held >= 10 {
            break;
        }
    }
    last
}

async fn many_apps(agents: Agents) {
    one_app(agents).await;
    let (fds, threads) = settled().await;
    for _ in 0..APPS {
        one_app(agents).await;
    }
    let (end_fds, end_threads) = settled().await;
    assert!(end_fds <= fds + 2, "descriptors grew {fds} → {end_fds} over {APPS} apps");
    assert!(end_threads <= threads + 2, "threads grew {threads} → {end_threads} over {APPS} apps");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fifty_apps_built_started_and_shut_down_leave_nothing_behind() {
    many_apps(Agents::Scripted).await;
    many_apps(Agents::Engine).await;
}
