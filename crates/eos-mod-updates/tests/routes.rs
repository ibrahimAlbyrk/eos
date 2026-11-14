//! The module on its own: its routes over the service, its line in the Jobs
//! list, and the agent events it reacts to. The recorded wire
//! (`fixtures/wire/recordings/16-services.json`) holds the same routes for a
//! build from source; here the install is a release build.

mod common;

use std::sync::Arc;

use common::{Harness, Setup, harness};
use eos_contracts::stream::topics;
use eos_core::store::ConfigSource;
use eos_mod_updates::UpdatesModule;
use eos_runtime::access::Caller;
use eos_runtime::http::{Method, Request};
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, Runtime};
use eos_testkit::FAKE_DOWNLOAD_BYTES;
use serde_json::{Value, json};

fn runtime(h: &Harness) -> Runtime {
    let kernel: Kernel = h.kernel.clone();
    let module = Arc::new(UpdatesModule::new(h.svc.clone(), h.config.clone(), kernel.bus.clone(), kernel.jobs.clone()));
    Runtime::build(kernel, vec![module], Arc::new(AllPluginsOn)).expect("composes")
}

async fn call(runtime: &Runtime, method: Method, target: &str, body: Option<Value>, caller: Caller) -> (u16, Value) {
    let mut request = Request::new(method, target, caller);
    if let Some(body) = body {
        request = request.header("content-type", "application/json").body(body.to_string());
    }
    let res = runtime.router.handle(request).await;
    let status = res.status;
    let body = res.body.collect().await.expect("a body");
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

async fn post(runtime: &Runtime, target: &str, body: Option<Value>) -> (u16, Value) {
    call(runtime, Method::Post, target, body, Caller::DASHBOARD).await
}

async fn state(runtime: &Runtime) -> Value {
    call(runtime, Method::Get, "/api/update", None, Caller::DASHBOARD).await.1
}

#[tokio::test]
async fn a_check_answers_at_once_with_the_state_already_checking_then_runs_to_ready() {
    let h = harness(Setup::default());
    let runtime = runtime(&h);
    runtime.lifecycle.start().await.expect("started");

    let (status, body) = post(&runtime, "/api/update/check", Some(json!({}))).await;
    assert_eq!((status, &body["status"]["phase"]), (202, &json!("checking")));
    assert_eq!(body["current"], "0.1.2");
    h.settle().await;

    let ready = state(&runtime).await;
    assert_eq!(
        ready,
        json!({
            "current": "0.1.2",
            "status": {
                "phase": "ready", "off": null, "version": "0.1.3", "bytes": FAKE_DOWNLOAD_BYTES, "done": null,
                "full": FAKE_DOWNLOAD_BYTES, "agents": null, "error": null,
            },
            "lastCheckedAt": 1_000,
            "autoDownload": true,
            "notes": "# notes",
            "notice": null,
        })
    );
    // Keys in today's order, as the dashboard and the stream get them.
    let keys: Vec<&str> = ready.as_object().expect("an object").keys().map(String::as_str).collect();
    assert_eq!(keys, ["current", "status", "lastCheckedAt", "autoDownload", "notes", "notice"]);
    let keys: Vec<&str> = ready["status"].as_object().expect("an object").keys().map(String::as_str).collect();
    assert_eq!(keys, ["phase", "off", "version", "bytes", "done", "full", "agents", "error"]);
    h.svc.stop();
}

#[tokio::test]
async fn restart_waits_for_agents_or_applies_and_refuses_when_nothing_is_ready() {
    let h = harness(Setup::default());
    let runtime = runtime(&h);
    runtime.lifecycle.start().await.expect("started");

    let (status, body) = post(&runtime, "/api/update/restart", Some(json!({ "when": "now" }))).await;
    assert_eq!((status, body), (409, json!({ "error": "no update is ready to restart into" })));
    let (status, body) = post(&runtime, "/api/update/restart", Some(json!({ "when": "soon" }))).await;
    assert_eq!(status, 400, "{body}");
    let (status, _) = post(&runtime, "/api/update/restart", Some(json!({}))).await;
    assert_eq!(status, 400);

    post(&runtime, "/api/update/check", None).await;
    h.settle().await;
    h.agents.set(2);
    let (status, body) = post(&runtime, "/api/update/restart", Some(json!({ "when": "idle" }))).await;
    assert_eq!((status, &body["status"]["phase"], &body["status"]["agents"]), (202, &json!("waiting"), &json!(2)));

    // An agent finishing its turn is announced on the bus; the last one starts the swap.
    h.agents.set(1);
    h.kernel.bus.publish_raw(topics::WORKER_CHANGE, None, json!({ "workerId": "w-1" }).to_string().into());
    h.kernel.bus.flush().await;
    h.settle().await;
    assert_eq!(state(&runtime).await["status"]["agents"], 1);

    let (status, body) = post(&runtime, "/api/update/later", None).await;
    assert_eq!((status, &body["status"]["phase"]), (200, &json!("ready")));
    let (_, body) = post(&runtime, "/api/update/restart", Some(json!({ "when": "idle" }))).await;
    assert_eq!(body["status"]["phase"], "waiting");
    h.agents.set(0);
    h.kernel.bus.publish_raw(topics::WORKER_CHANGE, None, json!({ "workerId": "w-1" }).to_string().into());
    h.kernel.bus.flush().await;
    h.settle().await;
    assert_eq!(state(&runtime).await["status"]["phase"], "applying");
    assert_eq!(h.applier.applied().len(), 1);
    h.svc.stop();
}

#[tokio::test]
async fn the_setting_is_written_to_the_configuration_and_starts_what_was_offered() {
    let h = harness(Setup { auto_download_off: true, ..Setup::default() });
    let runtime = runtime(&h);
    runtime.lifecycle.start().await.expect("started");
    post(&runtime, "/api/update/check", None).await;
    h.settle().await;
    assert_eq!(state(&runtime).await["status"]["phase"], "available");

    let (status, body) = call(&runtime, Method::Post, "/api/update/download", None, Caller::DASHBOARD).await;
    assert_eq!((status, &body["status"]["phase"]), (202, &json!("downloading")), "downloading before it answers");
    h.settle().await;
    assert_eq!(state(&runtime).await["status"]["phase"], "ready");

    let on = json!({ "autoDownload": true });
    let (status, body) = call(&runtime, Method::Put, "/api/settings/updates", Some(on), Caller::DASHBOARD).await;
    assert_eq!((status, &body["autoDownload"]), (200, &json!(true)));
    assert!(h.config.current().updates.auto_download);
    let unknown = json!({ "feedUrl": "https://elsewhere.example" });
    let (status, body) = call(&runtime, Method::Put, "/api/settings/updates", Some(unknown), Caller::DASHBOARD).await;
    assert_eq!(status, 400, "only the switch is the user's to set here: {body}");
    assert_eq!(h.config.current().updates.feed_url, None);
    h.svc.stop();
}

#[tokio::test]
async fn only_this_computers_dashboard_reaches_the_update_routes() {
    let h = harness(Setup::default());
    let runtime = runtime(&h);
    for (method, target) in [
        (Method::Get, "/api/update"),
        (Method::Post, "/api/update/check"),
        (Method::Post, "/api/update/download"),
        (Method::Post, "/api/update/restart"),
        (Method::Post, "/api/update/later"),
        (Method::Post, "/api/update/dismiss"),
        (Method::Put, "/api/settings/updates"),
    ] {
        let (status, body) = call(&runtime, method, target, None, Caller::UNTRUSTED).await;
        assert_eq!((status, body), (403, json!({ "error": "ui token required" })), "{target}");
    }
    assert_eq!(h.feed.checks(), 0);
}

#[tokio::test]
async fn a_download_shows_in_the_jobs_list_while_it_runs() {
    let h = harness(Setup::default());
    let runtime = runtime(&h);
    runtime.lifecycle.start().await.expect("started");
    h.feed.hold_ranges();
    post(&runtime, "/api/update/check", None).await;
    h.feed.range_requested().await;
    h.kernel.bus.flush().await;

    let jobs = h.kernel.jobs.list();
    assert_eq!(jobs.len(), 1);
    let job = &jobs[0];
    assert_eq!(
        (job.id.as_str(), job.kind.as_str(), job.title.as_str()),
        ("update:eos:update", "update", "Downloading Eos 0.1.3")
    );
    assert_eq!(job.worker_id, None);
    assert_eq!(job.progress.map(|p| (p.done, p.total)), Some((0, FAKE_DOWNLOAD_BYTES as u64)));
    assert!(!job.can_stop);

    // Stopped (auto-download switched off): the job leaves the list with the download.
    common::set_auto_download(&h.config, false);
    h.svc.settings_changed();
    h.settle().await;
    h.kernel.bus.flush().await;
    assert!(h.kernel.jobs.list().is_empty());
    h.svc.stop();
}
