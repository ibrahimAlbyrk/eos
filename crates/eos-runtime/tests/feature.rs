//! One feature, end to end: it declares a route, publishes an event and
//! registers a job; a dashboard stream sees all of it; the app shuts down.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use eos_runtime::access::{Access, Caller, Tier};
use eos_runtime::bus::{Topic, TopicDecl};
use eos_runtime::http::{ApiError, Body, BodyStream, Method, Request, Response};
use eos_runtime::idle::IdleHook;
use eos_runtime::jobs::{JobSpec, JobStatus};
use eos_runtime::module::{Module, ModuleError};
use eos_runtime::router::{AllPluginsOn, BoxFuture, RouteDef};
use eos_runtime::{Error, Kernel, KernelOptions, Runtime};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Serialize, Deserialize)]
struct NoteChange {
    id: u64,
    title: String,
}

const NOTES_CHANGE: Topic<NoteChange> = Topic::new("notes:change");

/// A small feature built from the kernel services it needs.
struct Notes {
    kernel: Kernel,
    count: Arc<AtomicU64>,
}

impl Notes {
    fn create(&self) -> RouteDef {
        let (kernel, count) = (self.kernel.clone(), self.count.clone());
        RouteDef::post("/api/notes", move |req: Request| {
            let (kernel, count) = (kernel.clone(), count.clone());
            async move {
                #[derive(Deserialize)]
                struct Body {
                    title: String,
                }
                let body: Body = req.json()?;
                // The transition and its event are one lane job: no other
                // note's event can come between this count and its announcement.
                let bus = kernel.bus.clone();
                let id = kernel
                    .ordered
                    .run(move || {
                        let id = count.fetch_add(1, Ordering::SeqCst) + 1;
                        bus.publish(&NOTES_CHANGE, &NoteChange { id, title: body.title });
                        id
                    })
                    .await
                    .map_err(|e| ApiError::Internal(e.to_string()))?;
                Ok(Response::json(200, &json!({ "id": id })))
            }
        })
        .access(Access::ui_token().phone_user(Tier::Low))
    }

    fn export(&self) -> RouteDef {
        let kernel = self.kernel.clone();
        RouteDef::post("/api/notes/{id}/export", move |req: Request| {
            let kernel = kernel.clone();
            async move {
                let id = req.param("id").unwrap_or_default().to_owned();
                let job =
                    kernel.jobs.start(JobSpec::new("note-export", None, id.as_str(), format!("Exporting note {id}")));
                job.update_now(|j| j.detail = Some("Writing".into()));
                job.finish(JobStatus::Completed, |j| j.detail = None);
                Ok(Response::json(200, &json!({ "job": job.id() })))
            }
        })
        .access(Access::ui_token())
    }
}

impl Module for Notes {
    fn id(&self) -> &'static str {
        "notes"
    }
    fn routes(&self) -> Vec<RouteDef> {
        vec![self.create(), self.export()]
    }
    fn topics(&self) -> Vec<TopicDecl> {
        vec![NOTES_CHANGE.decl()]
    }
    fn job_kinds(&self) -> Vec<&'static str> {
        vec!["note-export"]
    }
    fn idle_hooks(&self) -> Vec<IdleHook> {
        vec![IdleHook::new("notes-nudge", 50, |_| std::future::ready(false))]
    }
    fn start(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        Box::pin(async { Ok(()) })
    }
}

async fn frames(stream: &mut BodyStream) -> Vec<Value> {
    let mut out = Vec::new();
    while let Ok(Some(Ok(frame))) = tokio::time::timeout(Duration::from_millis(50), stream.next()).await {
        let text = String::from_utf8(frame.to_vec()).expect("utf-8");
        if let Some(at) = text.find("data: ").filter(|_| text.contains("event: change")) {
            out.push(serde_json::from_str(&text[at + 6..]).expect("json"));
        }
    }
    out
}

fn build() -> Runtime {
    let kernel = Kernel::new(KernelOptions::default());
    let notes = Arc::new(Notes { kernel: kernel.clone(), count: Arc::new(AtomicU64::new(0)) });
    Runtime::build(kernel, vec![notes], Arc::new(AllPluginsOn)).expect("composes")
}

#[tokio::test]
async fn a_feature_serves_a_route_publishes_an_event_and_registers_a_job() {
    let runtime = build();
    assert_eq!(runtime.router.undeclared(), Vec::<String>::new(), "every route has an access rule");
    assert_eq!(runtime.job_kinds, ["shell", "note-export"], "the kernel's kinds, then the features'");
    runtime.lifecycle.start().await.expect("started");
    runtime.lifecycle.ready().await.expect("ready");

    let opened = runtime.router.handle(Request::new(Method::Get, "/stream", Caller::DASHBOARD)).await;
    let Body::Stream(mut stream) = opened.body else { panic!("a stream") };

    let create = Request::new(Method::Post, "/api/notes", Caller::DASHBOARD).body(r#"{"title":"Plan"}"#);
    let created = runtime.router.handle(create).await;
    assert_eq!(created.status, 200);
    let export = runtime.router.handle(Request::new(Method::Post, "/api/notes/1/export", Caller::DASHBOARD)).await;
    assert_eq!(export.status, 200);

    runtime.kernel.bus.flush().await;
    let seen = frames(&mut stream).await;
    let reasons: Vec<&str> = seen.iter().map(|f| f["reason"].as_str().unwrap_or("")).collect();
    assert_eq!(reasons, ["notes:change", "jobs:change", "jobs:change"]);
    assert_eq!(seen[0]["payload"], json!({ "id": 1, "title": "Plan" }));
    assert_eq!(seen[1]["payload"]["job"]["status"], "running");
    assert_eq!(seen[2]["payload"]["job"]["status"], "completed");
    assert_eq!(runtime.kernel.jobs.list().len(), 1);

    // The same routes, judged by who calls.
    let frame = Request::new(Method::Post, "/api/notes", Caller::UNTRUSTED).body(r#"{"title":"x"}"#);
    assert_eq!(runtime.router.handle(frame).await.status, 403);
    let phone = Caller::Phone { grant: Tier::High, mutate: true };
    let from_phone = Request::new(Method::Post, "/api/notes", phone.clone()).body(r#"{"title":"From the phone"}"#);
    assert_eq!(runtime.router.handle(from_phone).await.status, 200);
    assert_eq!(runtime.router.handle(Request::new(Method::Post, "/api/notes/1/export", phone)).await.status, 403);

    let report = runtime.shutdown(Duration::from_secs(5)).await;
    assert!(report.clean());
    assert_eq!(report.stopped, ["notes"]);
    assert!(
        tokio::time::timeout(Duration::from_secs(1), async { while stream.next().await.is_some() {} }).await.is_ok(),
        "streams end at shutdown"
    );
    assert!(matches!(runtime.kernel.ordered.run(|| ()).await, Err(Error::LaneStopped)));
}

#[tokio::test]
async fn a_removed_workers_jobs_leave_the_list() {
    let runtime = build();
    let job = runtime.kernel.jobs.start(JobSpec::new("note-export", Some("w1"), "n1", "Exporting"));
    job.update_now(|_| {});
    runtime.kernel.bus.publish_raw("worker:removed", None, bytes::Bytes::from_static(br#"{"workerId":"w1"}"#));
    runtime.kernel.bus.flush().await;
    assert!(runtime.kernel.jobs.list().is_empty());
}

#[tokio::test]
async fn two_features_claiming_one_route_do_not_compose() {
    let kernel = Kernel::new(KernelOptions::default());
    let a = Arc::new(Notes { kernel: kernel.clone(), count: Arc::default() });
    let b = Arc::new(Notes { kernel: kernel.clone(), count: Arc::default() });
    let err = Runtime::build(kernel, vec![a, b], Arc::new(AllPluginsOn)).expect_err("clash");
    let text = err.to_string();
    for clash in [
        "module notes",
        "topic notes:change",
        "job kind note-export",
        "idle hook notes-nudge",
        "route POST /api/notes ",
    ] {
        assert!(text.contains(clash), "{clash} missing from:\n{text}");
    }
}
