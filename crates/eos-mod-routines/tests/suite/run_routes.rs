//! The run routes over the module: starting by hand (several items, later,
//! again, a repeat), the estimate by each basis, candidates, the history,
//! one run, its result and timeline, steering a run in each state, the run
//! a worker works for, and who may call what.

use std::sync::Arc;

use eos_contracts::{CapabilityItem, RoutineState};
use eos_core::routine::{RunOrigin, SubmittedResult};
use eos_domain::routine::run::{RunState, Station};
use eos_runtime::access::{Caller, Tier};
use eos_runtime::http::{Method, Request};
use eos_runtime::module::Module;
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_testkit::FakeCapabilityReads;
use serde_json::{Value, json};

use crate::bench::{Bench, blueprint, new_run, pull_request};

struct Routes {
    bench: Bench,
    runtime: Runtime,
}

impl Routes {
    fn new() -> Self {
        Self::over(Bench::new(true))
    }

    fn over(bench: Bench) -> Self {
        let module: Arc<dyn Module> = bench.module.clone();
        let runtime = Runtime::build(Kernel::new(KernelOptions::default()), vec![module], Arc::new(AllPluginsOn))
            .expect("composes");
        assert_eq!(runtime.router.undeclared(), Vec::<String>::new());
        Self { bench, runtime }
    }

    async fn call(&self, method: Method, caller: Caller, path: &str, body: Option<Value>) -> (u16, Value) {
        let mut request = Request::new(method, path, caller);
        if let Some(body) = body {
            request = request.body(body.to_string());
        }
        let response = self.runtime.router.handle(request).await;
        let status = response.status;
        let bytes = response.body.collect().await.expect("a body");
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    async fn get(&self, path: &str) -> (u16, Value) {
        self.call(Method::Get, Caller::DASHBOARD, path, None).await
    }

    async fn post(&self, path: &str, body: Value) -> (u16, Value) {
        self.call(Method::Post, Caller::DASHBOARD, path, Some(body)).await
    }

    /// A run started by hand whose lead works.
    async fn working(&self, routine: &str, number: u32) -> (String, String) {
        let bench = &self.bench;
        let id = bench.hand(routine, Some(pull_request(number))).await;
        bench.eventually(|| bench.run(&id).station == Some(Station::Work)).await;
        (id.clone(), bench.run(&id).lead_id.expect("a lead"))
    }
}

fn pr(number: u32) -> Value {
    serde_json::to_value(pull_request(number)).expect("json")
}

fn start(routine: &str, extra: Value) -> Value {
    let mut body = json!({"routineId": routine, "input": {"result": "usual"}, "door": "routine_page"});
    for (key, value) in extra.as_object().expect("an object") {
        body[key] = value.clone();
    }
    body
}

#[tokio::test(flavor = "multi_thread")]
async fn a_start_by_hand_queues_one_run_per_item_later_again_and_a_confirmed_repeat() {
    let routes = Routes::new();
    let routine = routes.bench.routine(RoutineState::Active, blueprint(1));

    let (status, body) = routes.post("/api/runs", start(&routine, json!({"items": [pr(1), pr(2)]}))).await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["runs"].as_array().map(Vec::len), Some(2));
    assert_eq!(body["runs"][0]["state"], "queued");
    let first = body["runs"][0]["id"].as_str().expect("an id").to_owned();
    assert_eq!(routes.bench.run(&first).door.as_deref(), Some("routine_page"));

    let later = start(&routine, json!({"input": {"result": "usual", "item": pr(3), "at": 9_999_999_999_999_i64}}));
    let (status, body) = routes.post("/api/runs", later).await;
    assert_eq!((status, &body["runs"][0]["notBefore"]), (201, &json!(9_999_999_999_999_i64)));

    let (status, body) = routes.post("/api/runs", start(&routine, json!({"items": [pr(1)]}))).await;
    assert_eq!((status, body["existingRunId"].as_str()), (409, Some(first.as_str())), "{body}");
    let again = start(&routine, json!({"items": [pr(1)], "againOf": first, "confirmRepeat": true}));
    let (status, body) = routes.post("/api/runs", again).await;
    assert_eq!(status, 201, "{body}");
    let id = body["runs"][0]["id"].as_str().expect("an id");
    let run = routes.bench.run(id);
    assert_eq!((run.origin.as_str(), run.origin_ref.as_deref()), ("again", Some(first.as_str())));

    let (status, body) = routes.post("/api/runs", start(&routine, json!({"door": "window"}))).await;
    assert_eq!(status, 400, "{body}");
    let (status, _) = routes.post("/api/runs", start("rt-none", json!({}))).await;
    assert_eq!(status, 404);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_estimate_comes_from_the_routines_runs_its_trials_or_the_table() {
    let routes = Routes::new();
    let bench = &routes.bench;
    let routine = bench.routine(RoutineState::Active, blueprint(1));
    let ask = json!({"routineId": routine, "input": {"result": "usual"}, "count": 2});

    let (status, table) = routes.post("/api/runs/estimate", ask.clone()).await;
    assert_eq!(status, 200, "{table}");
    assert_eq!(
        (table["basis"].as_str(), table["n"].as_i64(), table["ms"].as_i64()),
        (Some("table"), Some(0), Some(8 * 60_000))
    );
    // Lead and checker on sonnet: (20k × 3 + 6k × 15 + 60k × 0.3 + 10k × 3 + 1.5k × 15 + 20k × 0.3) / 1M, twice.
    assert!((table["usd"].as_f64().expect("usd") - 2.0 * 0.2265).abs() < 1e-9, "{table}");

    let trial = bench.hand(&routine, Some(pull_request(8))).await;
    bench.temp.exec(&format!(
        "UPDATE runs SET kind = 'trial', state = 'done', cost_usd = 0.5, work_ms = 1000 WHERE id = '{trial}'"
    ));
    let (_, trials) = routes.post("/api/runs/estimate", ask.clone()).await;
    assert_eq!(
        (trials["basis"].as_str(), trials["n"].as_i64(), trials["usd"].as_f64()),
        (Some("trials"), Some(1), Some(1.0))
    );

    let done = bench.hand(&routine, Some(pull_request(9))).await;
    bench.temp.exec(&format!("UPDATE runs SET state = 'done', cost_usd = 0.25, work_ms = 3000 WHERE id = '{done}'"));
    let (_, history) = routes.post("/api/runs/estimate", ask).await;
    assert_eq!(
        (history["basis"].as_str(), history["n"].as_i64(), history["usd"].as_f64(), history["ms"].as_i64()),
        (Some("history"), Some(1), Some(0.5), Some(3000))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn candidates_are_the_sources_items_and_the_routines_own_newest_first_each_once() {
    let item = |number: i64, at: i64| CapabilityItem {
        key: format!("github:pr:acme/game#{number}"),
        kind: "github.pull_request".into(),
        title: format!("PR {number}"),
        url: None,
        updated_at: at,
        data: json!({}),
    };
    let reads = FakeCapabilityReads::new().items("github.pulls", vec![item(1, 10), item(4, 2_000_000_000_000_000)]);
    let routes = Routes::over(Bench::with_reads(true, reads));
    let mut sourced = blueprint(1);
    sourced["takes"]["source"] = json!("github.pulls");
    let routine = routes.bench.routine(RoutineState::Active, sourced);
    routes.bench.hand(&routine, Some(pull_request(1))).await;
    routes.bench.hand(&routine, Some(pull_request(2))).await;

    let (status, body) = routes.get(&format!("/api/routines/{routine}/candidates")).await;
    assert_eq!(status, 200, "{body}");
    let keys: Vec<&str> = body["items"].as_array().expect("items").iter().filter_map(|i| i["key"].as_str()).collect();
    assert_eq!(keys, ["github:pr:acme/game#4", "github:pr:acme/game#2", "github:pr:acme/game#1"]);
    assert_eq!(body["items"][0]["untrusted"], true);
    let (_, limited) = routes.get(&format!("/api/routines/{routine}/candidates?limit=1")).await;
    assert_eq!(limited["items"].as_array().map(Vec::len), Some(1));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_history_one_run_its_result_and_its_timeline_read_back() {
    let routes = Routes::new();
    let bench = &routes.bench;
    let mut unchecked = blueprint(1);
    unchecked["how"]["checkAgent"] = json!(false);
    let routine = bench.routine(RoutineState::Active, unchecked);
    bench.supervise().await;
    let (run, lead) = routes.working(&routine, 1).await;
    bench.module.tools().report_progress(&lead, "Reading the diff", None).await.expect("noted");

    let (status, detail) = routes.get(&format!("/api/runs/{run}")).await;
    assert_eq!(status, 200, "{detail}");
    assert_eq!((detail["run"]["state"].as_str(), detail["attempt"].as_i64()), (Some("running"), Some(1)));
    assert_eq!(detail["agents"][0]["workerId"], lead.as_str());
    assert_eq!(
        (detail["agents"][0]["role"].as_str(), detail["agents"][0]["lastActivity"].as_str()),
        (Some("solo"), Some("Reading the diff"))
    );
    assert_eq!(detail["input"]["item"]["key"], "github:pr:acme/game#1");

    let result = SubmittedResult {
        kind: "github.review".into(),
        headline: "Fine".into(),
        body: json!("All good."),
        files: vec![],
    };
    bench.module.tools().submit_result(&lead, result).await.expect("handed in");
    bench.eventually(|| bench.state(&run) == RunState::Done).await;
    let (status, result) = routes.get(&format!("/api/runs/{run}/result")).await;
    assert_eq!(status, 200, "{result}");
    assert_eq!(
        (result["headline"].as_str(), result["body"].as_str(), result["verdict"]["pass"].as_bool()),
        (Some("Fine"), Some("All good."), Some(true))
    );
    let (_, events) = routes.get(&format!("/api/runs/{run}/events")).await;
    let states: Vec<&str> =
        events.as_array().expect("events").iter().filter_map(|e| e["data"]["state"].as_str()).collect();
    assert_eq!(states, ["queued", "running", "running", "checking", "done"]);

    let other = bench.hand(&routine, Some(pull_request(2))).await;
    let (_, page) = routes.get(&format!("/api/runs?routineId={routine}&limit=1")).await;
    assert_eq!((page["runs"][0]["id"].as_str(), page["nextBefore"].is_i64()), (Some(other.as_str()), true));
    let (_, done) = routes.get("/api/runs?state=done").await;
    assert_eq!(done["runs"].as_array().map(Vec::len), Some(1));
    assert_eq!(routes.get("/api/runs?state=sleeping").await.0, 400);
    assert_eq!(routes.get("/api/runs/rn-none").await.0, 404);
    assert_eq!(routes.get(&format!("/api/runs/{other}/result")).await.0, 404, "nothing handed in yet");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_message_reaches_the_lead_and_reopens_a_check_or_a_held_result_but_not_a_delivery() {
    let routes = Routes::new();
    let bench = &routes.bench;
    let routine = bench.routine_with(RoutineState::Active, blueprint(3), false);
    bench.supervise().await;
    let tell = |run: &str| (format!("/api/runs/{run}/message"), json!({"text": "Mind the tests."}));
    let result =
        || SubmittedResult { kind: "github.review".into(), headline: "R".into(), body: json!("r"), files: vec![] };

    let (running, lead) = routes.working(&routine, 1).await;
    let (path, body) = tell(&running);
    assert_eq!(routes.post(&path, body).await.0, 200);
    bench.eventually(|| bench.agents.sent(&lead).iter().any(|text| text.contains("Mind the tests."))).await;
    assert!(!bench.agents.sent(&lead).iter().any(|text| text.contains("routine_note")), "the user's own words");

    bench.module.tools().submit_result(&lead, result()).await.expect("handed in");
    assert_eq!(bench.state(&running), RunState::Checking);
    let is_checker = |s: &eos_core::agent::LaunchSpec| s.worker_definition.as_deref() == Some("eos-run-checker");
    bench.eventually(|| bench.agents.started().iter().any(is_checker)).await;
    let checker = bench.agents.started().into_iter().find(is_checker).expect("a checker").worker_id;
    let (path, body) = tell(&running);
    assert_eq!(routes.post(&path, body).await.0, 200);
    let reopened = bench.run(&running);
    assert_eq!((reopened.state, reopened.station), (RunState::Running, Some(Station::Work)));
    assert!(!bench.module.holds_worker(&lead));
    let id = checker.clone();
    let worker = bench.temp.store.read_blocking(move |tx| tx.workers().find(&id)).expect("reads").expect("a row");
    assert_eq!(worker.state, eos_contracts::WorkerState::Suspended, "the check stops");
    let again = SubmittedResult { headline: "R2".into(), ..result() };
    bench.module.tools().submit_result(&lead, again).await.expect("the reopened round is handed in again");
    assert_eq!(bench.state(&running), RunState::Checking);
    let (_, latest) = routes.get(&format!("/api/runs/{running}/result")).await;
    assert_eq!((latest["attempt"].clone(), latest["headline"].clone()), (json!(1), json!("R2")));

    let (held, held_lead) = routes.working(&routine, 2).await;
    bench.temp.exec(&format!("UPDATE runs SET state = 'waiting_for_user', station = 'gate' WHERE id = '{held}'"));
    let (path, body) = tell(&held);
    assert_eq!(routes.post(&path, body).await.0, 200);
    assert_eq!(bench.gate.withdrawn(), std::slice::from_ref(&held));
    assert_eq!(bench.state(&held), RunState::Running);
    bench.eventually(|| bench.agents.sent(&held_lead).iter().any(|text| text.contains("Mind the tests."))).await;

    bench.temp.exec(&format!("UPDATE runs SET state = 'delivering' WHERE id = '{held}'"));
    let (path, body) = tell(&held);
    assert_eq!(routes.post(&path, body).await.0, 409);
    let queued = bench.start(new_run(&routine, RunOrigin::Hand, Some(pull_request(8)))).await;
    let queued = queued.expect("starts").remove(0).id;
    bench.temp.exec(&format!("UPDATE runs SET state = 'queued' WHERE id = '{queued}'"));
    let (path, body) = tell(&queued);
    assert_eq!(routes.post(&path, body).await.0, 409, "a queued run has no team");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_pauses_resumes_and_stops_with_its_sessions() {
    let routes = Routes::new();
    let bench = &routes.bench;
    let routine = bench.routine(RoutineState::Active, blueprint(1));
    bench.supervise().await;
    let (run, lead) = routes.working(&routine, 1).await;
    bench.agents.settled().await;

    assert_eq!(routes.post(&format!("/api/runs/{run}/pause"), json!({})).await.0, 200);
    let paused = bench.run(&run);
    assert_eq!((paused.state, paused.reason.map(|r| r.as_str())), (RunState::Paused, Some("user")));
    let id = lead.clone();
    let worker = bench.temp.store.read_blocking(move |tx| tx.workers().find(&id)).expect("reads").expect("a row");
    assert_eq!(worker.state, eos_contracts::WorkerState::Suspended, "its session is put away");
    assert_eq!(routes.post(&format!("/api/runs/{run}/pause"), json!({})).await.0, 409);

    assert_eq!(routes.post(&format!("/api/runs/{run}/resume"), json!({})).await.0, 200);
    assert_eq!((bench.state(&run), bench.run(&run).station), (RunState::Running, Some(Station::Work)));
    bench.eventually(|| bench.agents.started().len() == 2).await;
    bench.eventually(|| bench.agents.sent(&lead).iter().any(|text| text.contains("resumed this run"))).await;

    assert_eq!(routes.post(&format!("/api/runs/{run}/stop"), json!({})).await.0, 200);
    assert_eq!(bench.state(&run), RunState::Cancelled);
    assert_eq!(routes.post(&format!("/api/runs/{run}/resume"), json!({})).await.0, 409);
    assert_eq!(routes.post("/api/runs/rn-none/stop", json!({})).await.0, 404);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_workers_run_is_found_and_who_may_call_what() {
    let routes = Routes::new();
    let bench = &routes.bench;
    let routine = bench.routine(RoutineState::Active, blueprint(1));
    bench.supervise().await;
    let (run, lead) = routes.working(&routine, 1).await;

    let (status, found) = routes.call(Method::Get, Caller::UNTRUSTED, &format!("/api/run-agents/{lead}"), None).await;
    assert_eq!((status, found), (200, json!({"runId": run, "routineId": routine, "role": "solo"})));
    assert_eq!(routes.get("/api/run-agents/w-chat").await.0, 404);

    let estimate = json!({"routineId": routine, "input": {"result": "usual"}});
    assert_eq!(routes.call(Method::Post, Caller::UNTRUSTED, "/api/runs/estimate", Some(estimate)).await.0, 200, "open");
    let read = Caller::Phone { grant: Tier::Read, mutate: true };
    let low = Caller::Phone { grant: Tier::Low, mutate: true };
    for path in ["/api/runs".to_owned(), format!("/api/runs/{run}"), format!("/api/routines/{routine}/candidates")] {
        assert_eq!(routes.call(Method::Get, Caller::UNTRUSTED, &path, None).await.0, 403, "{path}: the user's own");
        assert_eq!(routes.call(Method::Get, read.clone(), &path, None).await.0, 200, "{path}: the phone reads");
    }
    let events = format!("/api/runs/{run}/events");
    assert_eq!(routes.call(Method::Get, read.clone(), &events, None).await.0, 403, "not the phone's");
    let message = format!("/api/runs/{run}/message");
    let words = json!({"text": "hi"});
    assert_eq!(routes.call(Method::Post, low.clone(), &message, Some(words)).await.0, 403, "a message needs High");
    let pause = format!("/api/runs/{run}/pause");
    assert_eq!(routes.call(Method::Post, low, &pause, Some(json!({}))).await.0, 200, "a pause is Low");
    let resume = format!("/api/runs/{run}/resume");
    let high = Caller::Phone { grant: Tier::High, mutate: true };
    assert_eq!(routes.call(Method::Post, high, &resume, Some(json!({}))).await.0, 403, "never the phone");
}
