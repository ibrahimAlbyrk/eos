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
        // The source's first poll settles before the test looks at it.
        bench.until(|| bench.temp.count("SELECT count(*) FROM signal_sources WHERE next_poll_at IS NULL") == 0).await;
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
    let routes: [(Method, &str, Option<Value>, Option<Tier>); 9] = [
        (Method::Get, "/api/signals/routines", None, Some(Tier::Read)),
        (Method::Get, "/api/signals/routines/rt-a", None, Some(Tier::Read)),
        (Method::Get, "/api/signals", None, Some(Tier::Read)),
        (Method::Get, "/api/signals/summary", None, Some(Tier::Read)),
        (Method::Post, "/api/signals/replay", Some(json!({ "routineId": "rt-a", "signalIds": [] })), Some(Tier::High)),
        (
            Method::Post,
            "/api/signals/schedule/preview",
            Some(json!({ "schedule": schedule(), "count": 1 })),
            Some(Tier::Read),
        ),
        (Method::Post, "/api/signals/which/preview", Some(which), None),
        (Method::Get, "/api/signals/settings", None, Some(Tier::Read)),
        (Method::Put, "/api/signals/settings", Some(json!({ "keepAwakeForSchedules": false })), Some(Tier::Low)),
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

#[tokio::test(flavor = "multi_thread")]
async fn every_routine_says_when_it_runs_next_and_whether_its_sources_work() {
    let mut routines = active();
    routines[0].when = serde_json::from_value(json!({
        "on": [
            { "schedule": { "daily": "09:00", "days": "all", "zone": "UTC" } },
            { "schedule": schedule() },
            { "source": "github.pulls", "scope": { "repo": "acme/game" }, "events": ["opened"] },
        ],
    }))
    .expect("a When");
    routines.push(routine("rt-b", RoutineState::Active, &["opened"], None));
    let mut by_hand = routine("rt-c", RoutineState::Active, &[], None);
    by_hand.when = serde_json::from_value(json!({ "on": [] })).expect("a When");
    routines.push(by_hand);
    let rig = Rig::new(routines, true).await;

    let (status, rows) = rig.ask(Method::Get, "/api/signals/routines", None).await;
    assert_eq!(status, 200);
    assert_eq!(
        rows,
        json!([
            { "routineId": "rt-a", "nextAt": 5 * 3_600_000, "holder": "dev-1", "sourcesOk": true },
            { "routineId": "rt-b", "holder": "dev-1", "sourcesOk": true },
            { "routineId": "rt-c", "holder": "dev-1", "sourcesOk": true },
        ]),
        "the soonest of its schedules"
    );
    rig.bench.temp.exec("UPDATE signal_sources SET state = 'needs-attention'");
    let (_, rows) = rig.ask(Method::Get, "/api/signals/routines", None).await;
    assert_eq!((rows[0]["sourcesOk"].clone(), rows[2]["sourcesOk"].clone()), (json!(false), json!(true)));
}

#[tokio::test(flavor = "multi_thread")]
async fn keeping_the_mac_awake_for_schedules_is_set_through_its_own_route() {
    let rig = Rig::new(active(), true).await;
    let on = json!({ "keepAwakeForSchedules": true });
    let (status, answer) = rig.ask(Method::Put, "/api/signals/settings", Some(on.clone())).await;
    assert_eq!((status, answer), (200, on.clone()));
    assert_eq!(rig.ask(Method::Get, "/api/signals/settings", None).await, (200, on), "the read answers it");
    let stored = rig.bench.settings.0.lock().expect("settings").get("signals.keepAwakeForSchedules").cloned();
    assert_eq!(stored, Some(eos_contracts::SettingValue::Flag(true)));
    assert_eq!(rig.ask(Method::Put, "/api/signals/settings", Some(json!({}))).await.0, 400);
    let protected = rig.runtime.protected_settings.iter().flat_map(|p| p.keys.iter()).collect::<Vec<_>>();
    assert_eq!(protected, [&"signals.keepAwakeForSchedules"], "the flat settings route refuses it");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_summary_counts_each_kind_since_a_time_for_every_routine_and_each() {
    let mut routines = active();
    routines[0].when = serde_json::from_value(json!({
        "on": [{ "source": "github.pulls", "scope": { "repo": "acme/game" }, "events": ["opened"] }],
        "limits": { "perHour": 2, "queued": 25 },
    }))
    .expect("a When");
    routines.push(routine("rt-b", RoutineState::Active, &["opened"], None));
    let rig = Rig::new(routines, true).await;
    let drafts = vec![pull(1, "v0", "opened", true, &[])];
    rig.module.ingest(SOURCE_ID, page(drafts, json!({}))).await.expect("kept");
    rig.pulls(0).await;
    // rt-a ignores the draft, runs two of the others and holds two back; rt-b runs every one.
    let more = (2..=5).map(|n| pull(n, "v0", "opened", false, &[])).collect();
    rig.module.ingest(SOURCE_ID, page(more, json!({}))).await.expect("kept");
    rig.pulls(0).await;
    rig.bench.temp.exec("UPDATE runs SET state = 'waiting_for_user' WHERE id = 'rn-2'");
    rig.bench.temp.exec("UPDATE runs SET state = 'failed' WHERE id = 'rn-3'");
    rig.bench.temp.exec("UPDATE runs SET state = 'done' WHERE id IN ('rn-1', 'rn-4')");
    // A slot of rt-b that ran for three others, ten minutes late.
    rig.bench.temp.exec(
        "INSERT INTO signals (source_id, key, subject, kind, occurred_at, received_at, facts_json, item_json, \
         depth, state) VALUES ('src-clock', 'clock:rt-b:1', 'clock:rt-b:1', 'clock', -595000, 5000, \
         '{\"missed\":3}', 'null', 0, 'routed')",
    );
    rig.bench.temp.exec(
        "INSERT INTO signal_routes (signal_id, routine_id, routine_version, decision, decided_at) \
         SELECT id, 'rt-b', 'rv-rt-b', 'run', 5000 FROM signals WHERE kind = 'clock'",
    );

    let (status, summary) = rig.ask(Method::Get, "/api/signals/summary?since=0", None).await;
    assert_eq!(status, 200, "{summary}");
    let by_routine = &summary["byRoutine"];
    assert_eq!(rig.bench.runs("rt-a").len(), 2);
    assert_eq!(summary["since"], 0);
    let total =
        |field: &str| by_routine["rt-a"][field].as_i64().unwrap_or(0) + by_routine["rt-b"][field].as_i64().unwrap_or(0);
    for field in ["handled", "waiting", "ignored", "heldBack", "failed", "missed", "late"] {
        assert_eq!(summary["counts"][field].as_i64(), Some(total(field)), "{field}");
    }
    assert_eq!(by_routine["rt-a"]["ignored"], 1);
    assert_eq!(by_routine["rt-a"]["heldBack"], 2);
    assert_eq!((by_routine["rt-b"]["missed"].clone(), by_routine["rt-b"]["late"].clone()), (json!(3), json!(1)));
    let all = summary["counts"].clone();
    assert_eq!((all["handled"].clone(), all["waiting"].clone(), all["failed"].clone()), (json!(3), json!(1), json!(1)));
    assert_eq!(rig.ask(Method::Get, "/api/signals/summary?since=soon", None).await.0, 400);
    let (_, later) = rig.ask(Method::Get, "/api/signals/summary?since=999999999", None).await;
    assert_eq!(later["counts"]["ignored"], 0, "nothing since then");
}
