//! The signal routes over the real store: who may call each, the list, a
//! routine's trigger status, replay through the run intake and the two
//! previews.

use std::sync::Arc;
use std::time::Duration;

use eos_contracts::RoutineState;
use eos_core::routine::{RoutineTriggers, RunIntake};
use eos_mod_signals::SignalsModule;
use eos_runtime::access::{Caller, Tier};
use eos_runtime::http::{Method, Request};
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use serde_json::{Value, json};

use crate::rig::{Bench, SOURCE_ID, TableIntake, page, pull, routine};

struct Rig {
    bench: Bench,
    module: Arc<SignalsModule>,
    runtime: Runtime,
}

impl Rig {
    async fn new(routines: Vec<RoutineTriggers>, autostart: bool) -> Self {
        let bench = Bench::new(routines);
        let intake: Arc<dyn RunIntake> = Arc::new(TableIntake::new(bench.clock.clone()));
        let module = Arc::new(bench.module(bench.temp.store.clone(), intake, autostart));
        let runtime =
            Runtime::build(Kernel::new(KernelOptions::default()), vec![module.clone()], Arc::new(AllPluginsOn))
                .expect("composes");
        assert_eq!(runtime.router.undeclared(), Vec::<String>::new());
        runtime.lifecycle.start().await.expect("starts");
        runtime.lifecycle.ready().await.expect("ready");
        Self { bench, module, runtime }
    }

    /// Keeps pull requests 1 to `n` and waits until each is routed.
    async fn pulls(&self, n: u64) {
        let pulls = (1..=n).map(|n| pull(n, "v0", "opened", false, &["src/net.rs"])).collect();
        self.module.ingest(SOURCE_ID, page(pulls, json!({}))).await.expect("kept");
        tokio::time::timeout(Duration::from_secs(10), async {
            while self.bench.received() > 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("every signal is routed");
    }

    async fn ask_as(&self, caller: Caller, method: Method, path: &str, body: Option<Value>) -> (u16, Value) {
        let mut request = Request::new(method, path, caller);
        if let Some(body) = body {
            request = request.body(body.to_string());
        }
        let response = self.runtime.router.handle(request).await;
        let status = response.status;
        let bytes = response.body.collect().await.expect("a body");
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    async fn ask(&self, method: Method, path: &str, body: Option<Value>) -> (u16, Value) {
        self.ask_as(Caller::DASHBOARD, method, path, body).await
    }
}

fn active() -> Vec<RoutineTriggers> {
    vec![routine("rt-a", RoutineState::Active, &["opened"], Some(json!({ "fact": "draft", "is": false })))]
}

fn schedule() -> Value {
    json!({ "daily": "05:00", "days": "weekdays", "zone": "UTC" })
}

#[tokio::test(flavor = "multi_thread")]
async fn each_route_needs_the_user_and_the_phone_its_tier() {
    let rig = Rig::new(active(), true).await;
    let which = json!({ "which": { "rule": { "fact": "draft", "is": false } }, "limit": 10 });
    let routes: [(Method, &str, Option<Value>, Option<Tier>); 5] = [
        (Method::Get, "/api/signals/routines/rt-a", None, Some(Tier::Read)),
        (Method::Get, "/api/signals", None, Some(Tier::Read)),
        (Method::Post, "/api/signals/replay", Some(json!({ "routineId": "rt-a", "signalIds": [] })), Some(Tier::High)),
        (
            Method::Post,
            "/api/signals/schedule/preview",
            Some(json!({ "schedule": schedule(), "count": 1 })),
            Some(Tier::Read),
        ),
        (Method::Post, "/api/signals/which/preview", Some(which), None),
    ];
    for (method, path, body, tier) in routes {
        assert_eq!(rig.ask_as(Caller::UNTRUSTED, method, path, body.clone()).await.0, 403, "{method:?} {path}");
        assert_eq!(rig.ask(method, path, body.clone()).await.0, 200, "{method:?} {path}: the dashboard");
        for grant in [Tier::Read, Tier::Low, Tier::High] {
            let phone = Caller::Phone { grant, mutate: true };
            let status = rig.ask_as(phone, method, path, body.clone()).await.0;
            let allowed = tier.is_some_and(|tier| grant >= tier);
            assert_eq!(status != 403, allowed, "{method:?} {path} with {grant:?}: {status}");
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_list_and_a_routines_status_show_what_became_of_its_signals() {
    let mut routines = active();
    routines[0].when = serde_json::from_value(json!({
        "on": [
            { "schedule": schedule() },
            { "source": "github.pulls", "scope": { "repo": "acme/game" }, "events": ["opened"] },
        ],
        "limits": { "perHour": 2, "queued": 25 },
    }))
    .expect("a When");
    let rig = Rig::new(routines, true).await;
    rig.pulls(5).await;

    let (status, rows) = rig.ask(Method::Get, "/api/signals?routine=rt-a&decision=over-limit", None).await;
    assert_eq!(status, 200);
    let ids: Vec<i64> =
        rows.as_array().expect("rows").iter().map(|row| row["id"].as_i64().unwrap_or_default()).collect();
    assert_eq!(ids, [5, 4, 3], "newest first");
    assert_eq!(rows[0]["state"], "routed");
    assert_eq!(rows[0]["item"]["kind"], "github.pull_request");
    assert_eq!(rows[0]["decisions"][0]["decision"], "over-limit");
    let (_, page) = rig.ask(Method::Get, "/api/signals?before=3&limit=1", None).await;
    assert_eq!(page[0]["id"], 2);
    assert_eq!(rig.ask(Method::Get, "/api/signals?decision=maybe", None).await.0, 400);

    let (status, view) = rig.ask(Method::Get, "/api/signals/routines/rt-a", None).await;
    assert_eq!(status, 200);
    assert_eq!(view["holder"], json!({ "deviceId": "dev-1", "here": true }));
    assert_eq!(view["schedules"][0]["slot"], 0);
    assert_eq!(view["schedules"][0]["nextAt"], 5 * 3_600_000, "Thursday 1 January 1970 at 05:00");
    assert_eq!(view["schedules"][0]["zoneDiffers"], false);
    assert_eq!(view["sources"][0]["sourceId"], SOURCE_ID);
    assert_eq!(view["sources"][0]["state"], "active");
    assert_eq!(view["countsToday"]["heldBack"], 3);
    assert_eq!(view["counts7d"]["heldBack"], 3);
    assert_eq!(view["countsToday"]["handled"], 0, "its two runs still wait");
    assert_eq!(rig.ask(Method::Get, "/api/signals/routines/rt-missing", None).await.0, 404);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_replay_admits_held_signals_through_the_intake_and_refuses_what_ran() {
    // Off the network nothing starts by itself.
    let rig = Rig::new(active(), false).await;
    rig.pulls(3).await;
    assert_eq!(rig.bench.decided("held-dev"), 3);

    let (status, decided) =
        rig.ask(Method::Post, "/api/signals/replay", Some(json!({ "routineId": "rt-a", "signalIds": [1, 2] }))).await;
    assert_eq!(status, 200, "{decided}");
    assert_eq!(decided.as_array().map(Vec::len), Some(2));
    assert_eq!(decided[0]["decision"], "run");
    assert_eq!(decided[0]["runId"], "rn-1");
    assert_eq!(rig.bench.runs("rt-a").len(), 2);

    let again = json!({ "routineId": "rt-a", "signalIds": [3, 1] });
    assert_eq!(rig.ask(Method::Post, "/api/signals/replay", Some(again)).await.0, 409, "signal 1 ran already");
    assert_eq!(rig.bench.decided("held-dev"), 1, "a refused replay changes nothing");
    let too_many: Vec<i64> = (1..=201).collect();
    let body = json!({ "routineId": "rt-a", "signalIds": too_many });
    assert_eq!(rig.ask(Method::Post, "/api/signals/replay", Some(body)).await.0, 400);
    let unknown = json!({ "routineId": "rt-a", "signalIds": [99] });
    assert_eq!(rig.ask(Method::Post, "/api/signals/replay", Some(unknown)).await.0, 404);
    let changes = rig.bench.temp.announced.list();
    assert!(changes.iter().any(|(topic, _)| *topic == "signals:change"));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_previews_give_next_times_and_what_the_rules_take() {
    let rig = Rig::new(active(), true).await;
    let (status, next) = rig
        .ask(Method::Post, "/api/signals/schedule/preview", Some(json!({ "schedule": schedule(), "count": 3 })))
        .await;
    assert_eq!(status, 200);
    let hour = 3_600_000;
    assert_eq!(next["next"], json!([5 * hour, 29 * hour, 101 * hour]), "Thursday, Friday, then Monday");
    let unknown_zone = json!({ "schedule": { "daily": "05:00", "days": "all", "zone": "Mars/Base" }, "count": 3 });
    assert_eq!(rig.ask(Method::Post, "/api/signals/schedule/preview", Some(unknown_zone)).await.0, 400);
    let too_many = json!({ "schedule": schedule(), "count": 11 });
    assert_eq!(rig.ask(Method::Post, "/api/signals/schedule/preview", Some(too_many)).await.0, 400);

    let drafts = vec![pull(1, "v0", "opened", true, &[]), pull(2, "v0", "opened", false, &["src/net.rs"])];
    rig.module.ingest(SOURCE_ID, page(drafts, json!({}))).await.expect("kept");
    rig.pulls(0).await;
    let which = json!({
        "routineId": "rt-a",
        "which": { "rule": { "all": [{ "fact": "draft", "is": false }, { "fact": "size", "gte": 1 }] }, "ask": "Networking?" },
        "limit": 200,
    });
    let (status, tried) = rig.ask(Method::Post, "/api/signals/which/preview", Some(which)).await;
    assert_eq!(status, 200, "{tried}");
    assert_eq!(tried["unmatched"], json!([{ "rule": 0, "signalIds": [1] }]));
    assert_eq!(tried["undecided"], json!([2]), "no size fact");
    let which = json!({ "which": { "rule": { "fact": "draft", "is": false }, "ask": "Networking?" }, "limit": 200 });
    let (_, tried) = rig.ask(Method::Post, "/api/signals/which/preview", Some(which)).await;
    assert_eq!((tried["matched"].clone(), tried["wouldAsk"].clone()), (json!([2]), json!(1)));
    assert_eq!(rig.bench.decided("run"), 1, "a preview starts nothing");
}
