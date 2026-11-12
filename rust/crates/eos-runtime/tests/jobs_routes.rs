//! The Jobs tab's routes over the registry: what the dashboard reads and does.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use eos_runtime::access::Caller;
use eos_runtime::http::{Body, Method, Request, Response};
use eos_runtime::jobs::{JobActionError, JobSpec, JobStatus};
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use serde_json::{Value, json};

fn build() -> Runtime {
    Runtime::build(Kernel::new(KernelOptions::default()), Vec::new(), Arc::new(AllPluginsOn)).expect("composes")
}

fn json_of(res: &Response) -> Value {
    let Body::Bytes(bytes) = &res.body else { panic!("a whole body") };
    serde_json::from_slice(bytes).expect("json")
}

async fn call(runtime: &Runtime, method: Method, target: &str) -> (u16, Value) {
    let res = runtime.router.handle(Request::new(method, target, Caller::DASHBOARD)).await;
    (res.status, json_of(&res))
}

#[tokio::test]
async fn the_dashboard_lists_reads_stops_and_dismisses_jobs() {
    let runtime = build();
    let stopped = Arc::new(AtomicBool::new(false));
    let flag = stopped.clone();
    let mut spec = JobSpec::new("shell", None, "run-1", "sleep 30");
    spec.command = Some("sleep 30".into());
    spec.memory_output = true;
    let job = runtime.kernel.jobs.start(spec.on_stop(move || {
        let flag = flag.clone();
        async move {
            // A second stop finds the command already gone.
            if flag.swap(true, Ordering::SeqCst) {
                Err(JobActionError { status: 409, error: "the command already ended".into() })
            } else {
                Ok(())
            }
        }
    }));
    job.append_output("started\n");
    job.update_now(|j| j.detail = Some("started".into()));

    let (status, list) = call(&runtime, Method::Get, "/api/jobs").await;
    assert_eq!(status, 200);
    assert_eq!(list["jobs"][0]["id"], "shell:eos:run-1");
    assert_eq!(list["jobs"][0]["status"], "running");
    assert_eq!(list["jobs"][0]["canStop"], true);
    assert_eq!(list["jobs"][0]["hasOutput"], true);

    // The id travels percent-encoded, as the dashboard writes it.
    let (status, out) = call(&runtime, Method::Get, "/api/jobs/shell%3Aeos%3Arun-1/output?since=3").await;
    assert_eq!((status, out), (200, json!({ "text": "rted\n", "next": 8, "truncated": false, "reset": false })));
    assert_eq!(
        call(&runtime, Method::Get, "/api/jobs/nope/output").await,
        (404, json!({ "error": "no output for that job" }))
    );

    // A stop goes through what the job's producer registered.
    assert_eq!(call(&runtime, Method::Post, "/api/jobs/shell:eos:run-1/stop").await, (200, json!({ "ok": true })));
    assert!(stopped.load(Ordering::SeqCst));
    assert_eq!(
        call(&runtime, Method::Post, "/api/jobs/shell:eos:run-1/stop").await,
        (409, json!({ "error": "the command already ended" }))
    );
    assert_eq!(
        call(&runtime, Method::Post, "/api/jobs/shell:eos:run-1/dismiss").await,
        (404, json!({ "error": "no finished job with that id" })),
        "a running job is not dismissed"
    );

    job.finish(JobStatus::Stopped, |j| j.detail = Some("stopped by user".into()));
    assert_eq!(
        call(&runtime, Method::Post, "/api/jobs/shell:eos:run-1/stop").await,
        (404, json!({ "error": "no running job with that id" }))
    );
    assert_eq!(call(&runtime, Method::Post, "/api/jobs/shell:eos:run-1/dismiss").await, (200, json!({ "ok": true })));
    assert_eq!(call(&runtime, Method::Get, "/api/jobs").await, (200, json!({ "jobs": [] })));

    let again = runtime.kernel.jobs.start(JobSpec::new("shell", None, "run-2", "true"));
    again.finish(JobStatus::Completed, |_| {});
    assert_eq!(call(&runtime, Method::Post, "/api/jobs/clear").await, (200, json!({ "ok": true })));
    assert!(runtime.kernel.jobs.list().is_empty());
}

#[tokio::test]
async fn only_the_users_dashboard_reaches_them() {
    let runtime = build();
    for (method, target) in [
        (Method::Get, "/api/jobs"),
        (Method::Get, "/api/jobs/x/output"),
        (Method::Post, "/api/jobs/x/stop"),
        (Method::Post, "/api/jobs/x/dismiss"),
        (Method::Post, "/api/jobs/clear"),
    ] {
        let res = runtime.router.handle(Request::new(method, target, Caller::UNTRUSTED)).await;
        assert_eq!((res.status, json_of(&res)), (403, json!({ "error": "ui token required" })), "{target}");
    }
}
