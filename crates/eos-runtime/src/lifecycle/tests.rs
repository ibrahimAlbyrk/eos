use std::sync::Mutex;

use super::*;
use crate::module::{Module, compose};
use crate::router::AllPluginsOn;

type Log = Arc<Mutex<Vec<String>>>;

struct Step {
    id: &'static str,
    log: Log,
    fail_start: bool,
    panic_start: bool,
    fail_ready: bool,
    stop_takes: Duration,
    panic_on_stop: bool,
}

fn step(id: &'static str, log: &Log) -> Step {
    Step {
        id,
        log: log.clone(),
        fail_start: false,
        panic_start: false,
        fail_ready: false,
        stop_takes: Duration::ZERO,
        panic_on_stop: false,
    }
}

impl Step {
    fn note(&self, what: &str) {
        self.log.lock().expect("log").push(format!("{what}:{}", self.id));
    }
}

impl Module for Step {
    fn id(&self) -> &'static str {
        self.id
    }
    fn start(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        Box::pin(async move {
            self.note("start");
            if self.panic_start {
                panic!("start bug");
            }
            if self.fail_start { Err("no disk".into()) } else { Ok(()) }
        })
    }
    fn after_ready(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        Box::pin(async move {
            self.note("ready");
            if self.fail_ready { Err("relay unreachable".into()) } else { Ok(()) }
        })
    }
    fn stop(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            if self.panic_on_stop {
                panic!("stop bug");
            }
            tokio::time::sleep(self.stop_takes).await;
            self.note("stop");
        })
    }
}

fn lifecycle(steps: Vec<Step>) -> Lifecycle {
    let modules = steps.into_iter().map(|s| Arc::new(s) as Arc<dyn Module>).collect();
    Lifecycle::new(compose(modules, Arc::new(AllPluginsOn)).expect("no clashes").modules)
}

fn taken(log: &Log) -> Vec<String> {
    log.lock().expect("log").clone()
}

#[tokio::test]
async fn runs_the_phases_in_order_and_stops_in_reverse() {
    let log = Log::default();
    let life = lifecycle(vec![step("a", &log), step("b", &log), step("c", &log)]);
    assert_eq!(life.phase(), Phase::Built);
    for name in ["backup", "vacuum"] {
        let log = log.clone();
        life.defer(name, move || async move {
            log.lock().expect("log").push(format!("deferred:{name}"));
            Ok(())
        })
        .expect("deferred before ready");
    }
    life.start().await.expect("started");
    assert_eq!(life.phase(), Phase::Started);
    life.ready().await.expect("ready");
    assert_eq!(life.phase(), Phase::Ready);
    life.deferred_done().await;
    let report = life.shutdown(Duration::from_secs(5)).await;
    assert!(report.clean());
    assert_eq!(report.stopped, ["c", "b", "a"]);
    assert_eq!(
        taken(&log),
        [
            "start:a",
            "start:b",
            "start:c",
            "ready:a",
            "ready:b",
            "ready:c",
            "deferred:backup",
            "deferred:vacuum",
            "stop:c",
            "stop:b",
            "stop:a"
        ]
    );
    assert_eq!(life.phase(), Phase::Stopped);
}

#[tokio::test]
async fn refuses_steps_out_of_order() {
    let log = Log::default();
    let life = lifecycle(vec![step("a", &log)]);
    assert!(matches!(life.ready().await, Err(Error::WrongPhase { action: "ready", phase: "built" })));
    life.start().await.expect("started");
    assert!(matches!(life.start().await, Err(Error::WrongPhase { action: "start", phase: "started" })));
    life.ready().await.expect("ready");
    assert!(matches!(life.defer("late", || async { Ok(()) }), Err(Error::WrongPhase { action: "defer", .. })));
    life.shutdown(Duration::from_secs(1)).await;
    assert!(matches!(life.start().await, Err(Error::WrongPhase { phase: "stopped", .. })));
    let again = life.shutdown(Duration::from_secs(1)).await;
    assert!(again.stopped.is_empty(), "a second shutdown stops nothing twice");
}

#[tokio::test]
async fn a_module_that_fails_to_start_is_set_aside_and_the_rest_start() {
    let log = Log::default();
    let life = lifecycle(vec![step("a", &log), Step { fail_start: true, ..step("b", &log) }, step("c", &log)]);
    life.start().await.expect("the app starts without b");
    assert_eq!(life.modules.failed().reason("b").as_deref(), Some("no disk"));
    life.ready().await.expect("ready");
    let report = life.shutdown(Duration::from_secs(1)).await;
    assert_eq!(report.stopped, ["c", "b", "a"]);
    assert_eq!(taken(&log), ["start:a", "start:b", "start:c", "ready:a", "ready:c", "stop:c", "stop:b", "stop:a"]);
}

#[tokio::test]
async fn a_module_whose_start_panics_is_set_aside_like_a_failure_and_unwinds_nothing() {
    let log = Log::default();
    let life = lifecycle(vec![step("a", &log), Step { panic_start: true, ..step("b", &log) }, step("c", &log)]);
    life.start().await.expect("the app starts without b");
    assert_eq!(life.modules.failed().reason("b").as_deref(), Some("panicked: start bug"));
    let report = life.shutdown(Duration::from_secs(1)).await;
    assert_eq!(report.stopped, ["c", "b", "a"]);
}

#[tokio::test]
async fn every_module_gets_after_ready_and_one_that_fails_is_set_aside() {
    let log = Log::default();
    let life = lifecycle(vec![Step { fail_ready: true, ..step("sync", &log) }, step("b", &log)]);
    life.start().await.expect("started");
    life.ready().await.expect("the app is ready without sync");
    assert_eq!(life.phase(), Phase::Ready);
    assert_eq!(taken(&log)[2..], ["ready:sync", "ready:b"]);
    assert_eq!(life.modules.failed().list(), ["sync"]);
}

#[tokio::test]
async fn a_failing_or_panicking_deferred_task_does_not_stop_the_next() {
    let log = Log::default();
    let life = lifecycle(vec![step("a", &log)]);
    life.defer("fails", || async { Err("locked".into()) }).expect("deferred");
    life.defer("panics", || async { panic!("sweep bug") }).expect("deferred");
    let l = log.clone();
    life.defer("runs", move || async move {
        l.lock().expect("log").push("deferred:runs".into());
        Ok(())
    })
    .expect("deferred");
    life.start().await.expect("started");
    life.ready().await.expect("ready");
    life.deferred_done().await;
    assert_eq!(taken(&log).last().map(String::as_str), Some("deferred:runs"));
}

#[tokio::test(start_paused = true)]
async fn shutdown_keeps_its_deadline() {
    let log = Log::default();
    let life = lifecycle(vec![
        step("first", &log),
        Step { stop_takes: Duration::from_secs(60), ..step("stuck", &log) },
        Step { stop_takes: Duration::from_secs(1), ..step("slow", &log) },
        Step { panic_on_stop: true, ..step("buggy", &log) },
    ]);
    life.start().await.expect("started");
    life.ready().await.expect("ready");
    let began = tokio::time::Instant::now();
    let report = life.shutdown(Duration::from_secs(5)).await;
    assert_eq!(began.elapsed(), Duration::from_secs(5), "the deadline is the whole budget");
    assert_eq!(report.stopped, ["buggy", "slow"], "a panic while stopping does not end the shutdown");
    assert_eq!(report.timed_out, ["stuck"]);
    assert_eq!(report.skipped, ["first"], "no time was left for it");
    assert!(!report.clean());
    assert_eq!(taken(&log).last().map(String::as_str), Some("stop:slow"));
}

#[tokio::test(start_paused = true)]
async fn shutdown_cancels_deferred_work_still_running() {
    let log = Log::default();
    let life = lifecycle(vec![step("a", &log)]);
    let l = log.clone();
    life.defer("long", move || async move {
        tokio::time::sleep(Duration::from_secs(3600)).await;
        l.lock().expect("log").push("deferred:long".into());
        Ok(())
    })
    .expect("deferred");
    life.start().await.expect("started");
    life.ready().await.expect("ready");
    let report = life.shutdown(Duration::from_secs(5)).await;
    assert!(report.clean());
    tokio::time::sleep(Duration::from_secs(7200)).await;
    assert!(!taken(&log).contains(&"deferred:long".to_owned()));
}
