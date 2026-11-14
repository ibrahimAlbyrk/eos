use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

use super::*;
use crate::bus::BusOptions;
use crate::ordered::Ordered;
use eos_core::Clock;

struct TestClock(AtomicU64);
impl Clock for TestClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst) as i64
    }
}

struct Harness {
    reg: JobRegistry,
    bus: Bus,
    clock: Arc<TestClock>,
    changes: Arc<Mutex<Vec<Value>>>,
    _sub: crate::bus::Subscription,
}

fn harness(throttle_ms: u64, finished_max: usize) -> Harness {
    let clock = Arc::new(TestClock(AtomicU64::new(1000)));
    let bus = Bus::new(Ordered::new(), clock.clone(), BusOptions { delta_window: None });
    let changes = Arc::new(Mutex::new(Vec::new()));
    let log = changes.clone();
    let sub =
        bus.on(&JOBS_CHANGE, move |ev| log.lock().expect("changes").push(ev.payload_as::<Value>().expect("json")));
    let reg = JobRegistry::new(
        bus.clone(),
        JobOptions { throttle: Duration::from_millis(throttle_ms), finished_max, max_jobs: 6 },
    );
    Harness { reg, bus, clock, changes, _sub: sub }
}

impl Harness {
    fn tick(&self, ms: u64) {
        self.clock.0.fetch_add(ms, Ordering::SeqCst);
    }
    async fn changes(&self) -> Vec<Value> {
        self.bus.flush().await;
        self.changes.lock().expect("changes").clone()
    }
    /// Waits for the throttle timer rather than for a fixed time.
    async fn wait_for(&self, changes: usize) {
        let waiting = std::time::Instant::now();
        while self.changes().await.len() < changes && waiting.elapsed() < Duration::from_secs(10) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
    fn shell(&self, reference: &str) -> JobHandle {
        let spec = JobSpec {
            command: Some("npm run dev".into()),
            call_id: Some("toolu_1".into()),
            ..JobSpec::new("shell", Some("w1"), reference, "Start dev server")
        };
        let handle = self.reg.start(spec.on_stop(|| async { Ok(()) }));
        handle.update_now(|_| {});
        handle
    }
    fn ids(&self) -> Vec<String> {
        self.reg.list().into_iter().map(|j| j.id).collect()
    }
}

#[tokio::test]
async fn tracks_a_job_from_start_to_a_failed_end() {
    let h = harness(0, 50);
    let job = h.shell("b1");
    assert_eq!(
        h.reg.list(),
        [BackgroundJob {
            id: "shell:w1:b1".into(),
            kind: "shell".into(),
            status: JobStatus::Running,
            worker_id: Some("w1".into()),
            title: "Start dev server".into(),
            command: Some("npm run dev".into()),
            detail: None,
            started_at: 1000,
            ended_at: None,
            progress: None,
            exit_code: None,
            call_id: Some("toolu_1".into()),
            has_output: false,
            can_stop: true,
        }]
    );
    h.tick(5000);
    job.finish(JobStatus::Failed, |j| j.exit_code = Some(1));
    let done = &h.reg.list()[0];
    assert_eq!(
        (done.status, done.exit_code, done.ended_at, done.can_stop),
        (JobStatus::Failed, Some(1), Some(6000), false)
    );

    // The wire shape of jobs:change, keys in today's order, nulls kept.
    h.bus.flush().await;
    let raw = serde_json::to_string(&JobChange { job: Some(done.clone()), removed: None }).expect("serializes");
    assert_eq!(
        raw,
        r#"{"job":{"id":"shell:w1:b1","kind":"shell","status":"failed","workerId":"w1","title":"Start dev server","command":"npm run dev","detail":null,"startedAt":1000,"endedAt":6000,"progress":null,"exitCode":1,"callId":"toolu_1","hasOutput":false,"canStop":false}}"#
    );
    let changes = h.changes().await;
    assert_eq!(changes.len(), 2);
    assert_eq!(changes[0]["job"]["status"], "running");
    assert_eq!(changes[1]["job"]["status"], "failed");
}

#[tokio::test]
async fn nothing_goes_out_until_the_first_update_and_eos_jobs_have_no_worker() {
    let h = harness(0, 50);
    let job = h.reg.start(JobSpec::new("transfer", None, "t1", "Eos-0.42.dmg → MacBook Air"));
    assert_eq!(job.id(), "transfer:eos:t1");
    assert!(h.changes().await.is_empty());
    assert!(!h.reg.list()[0].can_stop, "a job nobody said how to stop cannot be stopped");
    job.update(|j| j.progress = Some(JobProgress { done: 1024, total: 2048 }));
    let changes = h.changes().await;
    assert_eq!(changes[0]["job"]["progress"], serde_json::json!({ "done": 1024, "total": 2048 }));
    assert_eq!(changes[0]["job"]["workerId"], Value::Null);
    assert!(h.reg.get("transfer", None, "t1").is_some());
    assert!(h.reg.get("transfer", None, "nope").is_none());
}

#[tokio::test]
async fn reads_a_jobs_output_file_from_an_offset() {
    let h = harness(0, 50);
    let dir = std::env::temp_dir().join(format!("eos-runtime-jobs-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let file = dir.join("b1.output");
    std::fs::write(&file, "line one\n").expect("write");
    let job = h.shell("b1");
    assert_eq!(h.reg.output("shell:w1:b1", 0), None, "no output yet");
    job.set_output_file(Some(file.clone()));
    assert!(h.reg.list()[0].has_output);
    let first = h.reg.output("shell:w1:b1", 0).expect("output");
    assert_eq!(first, JobOutput { text: "line one\n".into(), next: 9, truncated: false, reset: false });
    std::fs::write(&file, "line one\nline two\n").expect("append");
    assert_eq!(h.reg.output("shell:w1:b1", first.next).expect("output").text, "line two\n");
    assert!(h.reg.output("shell:w1:b1", 999).expect("output").reset);
    job.set_output_file(Some(dir.join("gone.output")));
    assert_eq!(h.reg.output("shell:w1:b1", 0), None, "a missing file is no output");
    assert_eq!(h.reg.output("nope", 0), None);
    std::fs::remove_dir_all(&dir).expect("cleanup");
}

#[tokio::test]
async fn keeps_memory_output_bounded_and_serves_it_by_offset() {
    let h = harness(0, 50);
    let job = h.reg.start(JobSpec { memory_output: true, ..JobSpec::new("monitor", Some("w1"), "m1", "test watcher") });
    assert!(h.reg.list()[0].has_output);
    job.append_output("PASS a.spec\n");
    job.append_output("FAIL b.spec\n");
    let out = h.reg.output("monitor:w1:m1", 0).expect("output");
    assert_eq!((out.text.as_str(), out.next), ("PASS a.spec\nFAIL b.spec\n", 24));
    assert_eq!(h.reg.output("monitor:w1:m1", 12).expect("output").text, "FAIL b.spec\n");

    // Past 256 KiB the oldest part is dropped; offsets keep counting from the start.
    let chunk = "é".repeat(1024);
    for _ in 0..200 {
        job.append_output(&chunk);
    }
    let total = 24 + 200 * 2048;
    let out = h.reg.output("monitor:w1:m1", 0).expect("output");
    assert_eq!(out.next, total);
    assert!(out.truncated && !out.reset);
    assert!(out.text.len() <= JOB_OUTPUT_MAX && out.text.chars().all(|c| c == 'é'));
    assert!(h.reg.output("monitor:w1:m1", total).expect("output").text.is_empty());
}

#[tokio::test]
async fn stops_a_job_through_its_source_and_refuses_what_cannot_be_stopped() {
    let h = harness(0, 50);
    let stopped = Arc::new(AtomicBool::new(false));
    let flag = stopped.clone();
    let allowed = Arc::new(AtomicBool::new(true));
    let gate = allowed.clone();
    let spec = JobSpec::new("workflow", Some("w1"), "toolu_w", "review-changes")
        .on_stop(move || {
            let flag = flag.clone();
            async move {
                flag.store(true, Ordering::SeqCst);
                Ok(())
            }
        })
        .stoppable_when(move || gate.load(Ordering::SeqCst));
    let job = h.reg.start(spec);
    assert!(h.reg.list()[0].can_stop);
    assert_eq!(h.reg.stop("workflow:w1:toolu_w").await, Ok(()));
    assert!(stopped.load(Ordering::SeqCst));
    allowed.store(false, Ordering::SeqCst);
    assert!(!h.reg.list()[0].can_stop, "the source says not right now");

    h.reg.start(JobSpec::new("sync", None, "sync", "Syncing"));
    assert_eq!(
        h.reg.stop("sync:eos:sync").await,
        Err(JobActionError { status: 409, error: "that job can't be stopped".into() })
    );
    job.finish(JobStatus::Stopped, |_| {});
    let gone = JobActionError { status: 404, error: "no running job with that id".into() };
    assert_eq!(h.reg.stop("workflow:w1:toolu_w").await, Err(gone.clone()));
    assert_eq!(h.reg.stop("nope").await, Err(gone));
}

#[tokio::test]
async fn coalesces_updates_inside_the_throttle_window_but_sends_a_start_and_an_end_at_once() {
    let h = harness(150, 50);
    let job = h.reg.start(JobSpec::new("monitor", Some("w1"), "m1", "m"));
    job.update_now(|_| {});
    job.update(|j| j.detail = Some("1 events · a".into()));
    job.update(|j| j.detail = Some("2 events · b".into()));
    assert_eq!(h.changes().await.len(), 1);
    h.wait_for(2).await;
    let changes = h.changes().await;
    assert_eq!(changes.len(), 2, "one change for the whole window");
    assert_eq!(changes[1]["job"]["detail"], "2 events · b");
    job.finish(JobStatus::Completed, |_| {});
    assert_eq!(h.changes().await.len(), 3);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(h.changes().await.len(), 3, "no timer is left to fire after the end");
}

#[tokio::test]
async fn an_update_after_the_window_goes_out_at_once_and_a_stale_timer_does_not_cut_the_next_window_short() {
    let h = harness(150, 50);
    let job = h.shell("b1");
    h.tick(150);
    job.update(|j| j.detail = Some("later".into()));
    assert_eq!(h.changes().await.len(), 2, "the window had passed");
    // A timer is armed, then an immediate update supersedes it.
    job.update(|j| j.detail = Some("held".into()));
    job.update_now(|j| j.detail = Some("now".into()));
    let changes = h.changes().await;
    assert_eq!((changes.len(), changes[2]["job"]["detail"].as_str()), (3, Some("now")));
    job.update(|j| j.detail = Some("next window".into()));
    h.wait_for(4).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let changes = h.changes().await;
    assert_eq!(changes.len(), 4, "the superseded timer sent nothing of its own");
    assert_eq!(changes[3]["job"]["detail"], "next window");
}

#[tokio::test]
async fn keeps_the_newest_finished_jobs_and_drops_them_on_dismiss_clear_or_a_removed_worker() {
    let h = harness(0, 2);
    for id in ["a", "b", "c"] {
        let job = h.shell(id);
        h.tick(10);
        job.finish(JobStatus::Completed, |j| j.exit_code = Some(0));
    }
    assert_eq!(h.ids(), ["shell:w1:c", "shell:w1:b"]);
    assert_eq!(h.changes().await.last().expect("a change")["removed"], serde_json::json!(["shell:w1:a"]));
    assert_eq!(h.reg.dismiss("shell:w1:c"), Ok(()));
    let missing = JobActionError { status: 404, error: "no finished job with that id".into() };
    assert_eq!(h.reg.dismiss("shell:w1:c"), Err(missing.clone()));
    h.shell("d");
    assert_eq!(h.reg.dismiss("shell:w1:d"), Err(missing), "a running job is not dismissed");
    h.reg.clear_finished();
    assert_eq!(h.ids(), ["shell:w1:d"]);
    h.reg.start(JobSpec::new("transfer", None, "t1", "t")).update_now(|_| {});
    h.reg.forget_worker("w1");
    assert_eq!(h.ids(), ["transfer:eos:t1"]);
    let removed: Vec<Value> = h.changes().await.into_iter().filter(|c| c.get("removed").is_some()).collect();
    assert_eq!(
        removed.iter().map(|c| c["removed"].to_string()).collect::<Vec<_>>(),
        [r#"["shell:w1:a"]"#, r#"["shell:w1:c"]"#, r#"["shell:w1:b"]"#, r#"["shell:w1:d"]"#]
    );
}

#[tokio::test]
async fn lists_running_jobs_first_newest_start_first_then_finished_by_end() {
    let h = harness(0, 50);
    let old = h.shell("old");
    h.tick(10);
    let done_first = h.shell("done-first");
    h.tick(10);
    h.shell("new");
    h.tick(10);
    done_first.finish(JobStatus::Completed, |_| {});
    h.tick(10);
    let done_later = h.shell("done-later");
    done_later.finish(JobStatus::Stopped, |_| {});
    assert_eq!(h.ids(), ["shell:w1:new", "shell:w1:old", "shell:w1:done-later", "shell:w1:done-first"]);
    drop(old);
}

#[tokio::test]
async fn an_ambient_job_shows_only_while_it_runs() {
    let h = harness(0, 50);
    let job = h.reg.start(JobSpec { ambient: true, ..JobSpec::new("compaction", Some("w1"), "context", "Compacting") });
    job.update_now(|_| {});
    assert_eq!(h.ids(), ["compaction:w1:context"]);
    job.finish(JobStatus::Completed, |_| {});
    assert!(h.ids().is_empty());
    let changes = h.changes().await;
    assert_eq!(changes[1], serde_json::json!({ "removed": ["compaction:w1:context"] }));
}

#[tokio::test]
async fn a_job_started_again_replaces_the_old_run_and_its_handle_goes_quiet() {
    let h = harness(0, 50);
    let first = h.shell("b1");
    first.finish(JobStatus::Completed, |_| {});
    h.tick(100);
    let second = h.shell("b1");
    assert_eq!(h.reg.list().len(), 1);
    assert_eq!(h.reg.list()[0].status, JobStatus::Running);
    let before = h.changes().await.len();
    first.update_now(|j| j.detail = Some("ghost".into()));
    first.append_output("ghost");
    first.drop_job();
    assert_eq!(h.changes().await.len(), before, "the old handle changes nothing");
    assert_eq!(first.job(), None);
    assert_eq!(second.job().expect("live").detail, None);
    second.drop_job();
    assert!(h.ids().is_empty());
    h.reg.dispose();
}

#[tokio::test]
async fn concurrent_sources_never_publish_a_jobs_states_out_of_order() {
    let h = harness(0, 50);
    let mut workers = Vec::new();
    for t in 0..4 {
        let reg = h.reg.clone();
        workers.push(std::thread::spawn(move || {
            let job = reg.start(JobSpec::new("shell", Some("w1"), format!("t{t}"), "t"));
            for n in 1..=200u64 {
                job.update_now(|j| j.progress = Some(JobProgress { done: n, total: 200 }));
            }
            job.finish(JobStatus::Completed, |_| {});
        }));
    }
    for w in workers {
        w.join().expect("worker");
    }
    let mut last: std::collections::HashMap<String, (u64, bool)> = std::collections::HashMap::new();
    for change in h.changes().await {
        let Some(job) = change.get("job") else { continue };
        let id = job["id"].as_str().expect("id").to_owned();
        let done = job["progress"]["done"].as_u64().unwrap_or(0);
        let finished = job["status"] == "completed";
        let (prev, was_finished) = last.get(&id).copied().unwrap_or((0, false));
        assert!(done >= prev && !was_finished, "{id} went backwards");
        last.insert(id, (done, finished));
    }
    assert_eq!(last.len(), 4);
    assert!(last.values().all(|&(done, finished)| done == 200 && finished));
}

#[test]
fn slices_output_by_offset() {
    assert_eq!(
        slice_output("abcdef", 10, 12),
        JobOutput { text: "cdef".into(), next: 16, truncated: false, reset: false }
    );
    assert_eq!(
        slice_output("abcdef", 10, 99),
        JobOutput { text: "abcdef".into(), next: 16, truncated: false, reset: true }
    );
    assert_eq!(
        slice_output("abcdef", 10, 0),
        JobOutput { text: "abcdef".into(), next: 16, truncated: true, reset: false }
    );
    let big = "x".repeat(70 * 1024);
    let out = slice_output(&big, 0, 0);
    assert_eq!((out.text.len(), out.truncated), (64 * 1024, true));
    // An offset inside a character moves to the next one.
    assert_eq!(slice_output("aé✓", 0, 2).text, "✓");
}

#[tokio::test]
async fn never_holds_more_jobs_than_its_bound() {
    let h = harness(0, 50);
    let done = h.shell("done");
    done.finish(JobStatus::Completed, |_| {});
    for i in 0..5 {
        h.tick(1);
        h.shell(&format!("r{i}"));
    }
    assert_eq!(h.reg.list().len(), 6);
    h.tick(1);
    h.shell("one-more");
    assert!(!h.ids().contains(&"shell:w1:done".to_owned()), "a finished job makes room first");
    h.tick(1);
    h.shell("and-another");
    assert_eq!(h.reg.list().len(), 6);
    assert!(!h.ids().contains(&"shell:w1:r0".to_owned()), "then the longest-running one");
    let removed: Vec<String> =
        h.changes().await.iter().filter_map(|c| c.get("removed").map(|r| r.to_string())).collect();
    assert_eq!(removed, [r#"["shell:w1:done"]"#, r#"["shell:w1:r0"]"#]);
}
