//! A new user: a fresh data folder answers every Eos read with its empty shape, and with no
//! routine made the app stays quiet: in ten simulated minutes no source is polled, no model
//! is asked, no notification fires and nothing holds the Mac awake.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use eos_app::{App, CapabilityOptions, Options};
use eos_core::agent::{OneShot, OneShotAnswer, OneShotError, OneShotRequest};
use eos_core::{BoxFuture, Clock, Sleeper};
use eos_runtime::http::Method;
use eos_testkit::relay::FakeKeepAwake;
use eos_testkit::{
    FakeBrowser, FakeBrowserPanel, FakeBrowserViews, FakeClock, FakeDockBadge, FakeSignalSources, FakeSource,
    FakeWorkHold, ScriptedRuntime, TempHome,
};
use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::rig::{self, Summarizer};

/// Every Eos read a screen makes before anything exists, by target.
const READS: [&str; 20] = [
    "/api/routines",
    "/api/routines/settings",
    "/api/runs",
    "/api/runs/active",
    "/api/runs/summary?since=0",
    "/api/signals/routines",
    "/api/signals",
    "/api/signals/summary?since=0",
    "/api/signals/settings",
    "/api/inbox",
    "/api/eos/halt",
    "/api/settings/attention",
    "/api/capabilities",
    "/api/memory/summary",
    "/api/memory/notes",
    "/api/memory/stated",
    "/api/memory/settings",
    "/api/surfaces",
    "/api/settings/surfaces",
    "/api/actions",
];

/// The one-shot model the app asks, counted.
#[derive(Default)]
struct CountedModel(AtomicUsize);

impl OneShot for CountedModel {
    fn complete(&self, request: OneShotRequest) -> BoxFuture<'_, Result<OneShotAnswer, OneShotError>> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Summarizer.complete(request)
    }
}

struct NoPicker;

impl eos_core::shell::FilePicker for NoPicker {
    fn pick_directory(&self) -> BoxFuture<'_, Option<String>> {
        Box::pin(async { None })
    }

    fn pick_files(&self) -> BoxFuture<'_, Option<Vec<String>>> {
        Box::pin(async { None })
    }
}

/// Simulated time: every wait the app asks for ends once the test has moved the clock past it.
struct SimTime {
    clock: Arc<FakeClock>,
    waits: Mutex<Vec<(i64, oneshot::Sender<()>)>>,
}

impl SimTime {
    fn advance(&self, ms: i64) {
        let now = self.clock.advance(ms);
        let mut waits = self.waits.lock().unwrap_or_else(PoisonError::into_inner);
        for (_, done) in waits.extract_if(.., |(due, _)| *due <= now) {
            let _ = done.send(());
        }
    }
}

impl Sleeper for SimTime {
    fn sleep(&self, ms: i64) -> BoxFuture<'static, ()> {
        let (done, wait) = oneshot::channel();
        let due = self.clock.now_ms() + ms;
        self.waits.lock().unwrap_or_else(PoisonError::into_inner).push((due, done));
        Box::pin(async move {
            let _ = wait.await;
        })
    }
}

struct Watched {
    time: Arc<SimTime>,
    source: Arc<FakeSource>,
    model: Arc<CountedModel>,
    awake: Arc<FakeKeepAwake>,
    holds: Arc<FakeWorkHold>,
}

fn quiet_app(home: &TempHome, agents: &ScriptedRuntime) -> (App, Watched) {
    let watched = Watched {
        time: Arc::new(SimTime { clock: Arc::new(FakeClock::new()), waits: Mutex::default() }),
        source: Arc::new(FakeSource::default()),
        model: Arc::new(CountedModel::default()),
        awake: Arc::new(FakeKeepAwake::new()),
        holds: Arc::new(FakeWorkHold::new()),
    };
    let capabilities = CapabilityOptions {
        sources: Some(Arc::new(FakeSignalSources::new().with("github.pulls", watched.source.clone()))),
        ..CapabilityOptions::default()
    };
    let mut options = rig::options(home.path(), agents, capabilities);
    options.agents.one_shot = Some(watched.model.clone());
    let shell = eos_app::Shell {
        views: FakeBrowserViews::new(),
        panel: FakeBrowserPanel::new(),
        picker: Arc::new(NoPicker),
        secret_prompt: Arc::new(eos_testkit::FakeSecretPrompt::new()),
        opener: Arc::new(FakeBrowser::default()),
        work_hold: watched.holds.clone(),
        dock_badge: Arc::new(FakeDockBadge::new()),
    };
    let app = App::build(Options {
        clock: watched.time.clock.clone(),
        sleeper: watched.time.clone(),
        keep_awake: Some(watched.awake.clone()),
        shell: Some(shell),
        ..options
    })
    .expect("builds");
    (app, watched)
}

/// Every list in the answer is empty: no routine, run, signal, item, note or surface. The
/// capabilities are the built-ins only, and the actions are the ones the app declares.
fn assert_empty(target: &str, body: &Value) {
    fn arrays<'a>(value: &'a Value, path: String, out: &mut Vec<(String, &'a Value)>) {
        match value {
            Value::Array(items) => {
                out.push((path.clone(), value));
                for (i, item) in items.iter().enumerate() {
                    arrays(item, format!("{path}/{i}"), out);
                }
            }
            Value::Object(fields) => {
                for (key, field) in fields {
                    arrays(field, format!("{path}/{key}"), out);
                }
            }
            _ => {}
        }
    }
    match target {
        "/api/capabilities" => {
            for row in body.as_array().unwrap_or_else(|| panic!("{target}: {body}")) {
                assert_eq!(row["origin"], "builtin", "{target}: {row}");
            }
        }
        "/api/actions" => {}
        // Settings answer their defaults.
        _ if target.contains("settings") => assert!(body.is_object(), "{target}: {body}"),
        _ => {
            let mut found = Vec::new();
            arrays(body, String::new(), &mut found);
            for (path, array) in found {
                assert_eq!(array, &json!([]), "{target}: {path}");
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_fresh_home_answers_every_eos_read_empty_and_stays_quiet_for_ten_minutes() {
    let home = TempHome::new();
    let agents = ScriptedRuntime::new();
    let (app, watched) = quiet_app(&home, &agents);
    let mut notifications = app.runtime().kernel.bus.subscribe("notification:fire", 16);
    app.start().await.expect("starts");

    for target in READS {
        let (status, body) = rig::call(&app, Method::Get, target, None).await;
        assert_eq!(status, 200, "{target}: {body}");
        assert_empty(target, &body);
    }

    // Ten minutes a second at a time, each step long enough for whatever woke to run.
    for _ in 0..600 {
        watched.time.advance(1_000);
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    app.runtime().kernel.bus.flush().await;

    assert!(watched.source.requests().is_empty(), "no source was polled");
    assert_eq!(watched.model.0.load(Ordering::SeqCst), 0, "no model was asked");
    assert!(agents.started().is_empty(), "no agent was started");
    let fired = tokio::time::timeout(Duration::from_millis(20), notifications.recv()).await;
    assert!(fired.is_err(), "no notification fired");
    assert_eq!(watched.awake.taken(), 0, "the Mac was never kept awake");
    assert_eq!(watched.holds.taken(), 0, "the app never held its pace");
    // GitHub waits for the user's sign-in: no account is reached by itself.
    let (_, capabilities) = rig::call(&app, Method::Get, "/api/capabilities", None).await;
    let github = capabilities.as_array().into_iter().flatten().find(|row| row["id"] == "github");
    assert_eq!(github.map(|row| &row["state"]), Some(&json!("needs_setup")), "{capabilities}");
    let (_, inbox) = rig::call(&app, Method::Get, "/api/inbox", None).await;
    assert_eq!(inbox["items"], json!([]), "nothing waits for the user");
    assert!(app.shutdown(Duration::from_secs(5)).await.clean());
}
