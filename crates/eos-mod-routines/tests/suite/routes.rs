//! The read routes on a store the test fills: a routine with two versions
//! and a few runs, a built-in one, a deleted one; and who may read them.

use std::sync::Arc;

use eos_contracts::{RoutineKind, RoutineState, VersionAuthor, VersionStatus};
use eos_core::Ids;
use eos_core::store::{StoredRoutine, StoredRun, StoredVersion};
use eos_domain::routine::blueprint::{Readable, canonical_json, hash, read};
use eos_domain::routine::run::RunState;
use eos_domain::run_scope::Trust;
use eos_mod_routines::{RoutinesModule, RoutinesParts};
use eos_runtime::access::{Caller, Tier};
use eos_runtime::http::{Method, Request};
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_testkit::{FakeClock, FakeSleeper, SeqIds, TempStore};
use serde_json::{Value, json};

const DAY: i64 = 24 * 60 * 60 * 1000;

struct Bench {
    runtime: Runtime,
    temp: TempStore,
    ids: SeqIds,
    now: i64,
}

impl Bench {
    fn new() -> Self {
        let temp = TempStore::new();
        let clock = Arc::new(FakeClock::new());
        let now = FakeClock::START_MS;
        let module = Arc::new(RoutinesModule::new(RoutinesParts {
            store: temp.port(),
            clock,
            sleeper: Arc::new(FakeSleeper::default()),
            ids: Arc::new(SeqIds::new()),
            device: "mac-1".into(),
            autostart: true,
        }));
        let runtime = Runtime::build(Kernel::new(KernelOptions::default()), vec![module], Arc::new(AllPluginsOn))
            .expect("composes");
        assert_eq!(runtime.router.undeclared(), Vec::<String>::new());
        Self { runtime, temp, ids: SeqIds::new(), now }
    }

    async fn get(&self, caller: Caller, path: &str) -> (u16, Value) {
        let response = self.runtime.router.handle(Request::new(Method::Get, path, caller)).await;
        let status = response.status;
        let bytes = response.body.collect().await.expect("a body");
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    async fn read(&self, path: &str) -> (u16, Value) {
        self.get(Caller::DASHBOARD, path).await
    }

    /// A routine of `origin` in `state` with one version of `blueprint` per
    /// entry, made a day apart; the last is its head.
    fn routine(&self, origin: &str, state: RoutineState, blueprints: &[Value]) -> (String, Vec<String>) {
        let id = self.ids.routine_id();
        let made = self.now - 10 * DAY;
        let versions: Vec<StoredVersion> = blueprints
            .iter()
            .enumerate()
            .map(|(at, blueprint)| {
                let Ok(Readable::Current(typed)) = read(blueprint) else { panic!("a blueprint of this app") };
                let text = canonical_json(&typed);
                StoredVersion {
                    id: self.ids.routine_version_id(),
                    routine_id: id.clone(),
                    parent_id: None,
                    status: VersionStatus::Kept,
                    author: if at == 0 { VersionAuthor::User } else { VersionAuthor::Architect },
                    note: (at > 0).then(|| "Checks the tests too.".to_owned()),
                    format: 1,
                    hash: hash(&text),
                    blueprint: text,
                    no_trial: false,
                    trust: Trust::Untrusted,
                    device: None,
                    created_at: made + at as i64 * DAY,
                }
            })
            .collect();
        let version_ids: Vec<String> = versions.iter().map(|v| v.id.clone()).collect();
        let routine = StoredRoutine {
            id: id.clone(),
            slug: format!("{origin}-{id}"),
            name: "PR Review".into(),
            kind: RoutineKind::Standing,
            state,
            paused_reason: None,
            head_version_id: version_ids.last().cloned(),
            origin: origin.into(),
            task_key: None,
            agents_may_start: false,
            failure_streak: 0,
            created_at: made,
            updated_at: made,
            changed_at: made,
            started_at: Some(made),
            deleted_at: (state == RoutineState::Deleted).then_some(self.now - 31 * DAY),
        };
        self.temp
            .store
            .write_blocking(move |tx, _| {
                tx.routines().insert(&routine)?;
                versions.iter().try_for_each(|version| tx.routine_versions().insert(version))
            })
            .expect("writes");
        (id, version_ids)
    }

    /// A run of `routine` made `ago` before now.
    fn run(&self, routine: &str, ago: i64, state: RunState) -> String {
        let id = self.ids.run_id();
        let run = StoredRun {
            id: id.clone(),
            routine_id: routine.into(),
            version_id: None,
            kind: "standing".into(),
            origin: "hand".into(),
            origin_ref: None,
            door: Some("routine_page".into()),
            input: json!({"item": {"kind": "github.pull_request", "title": "Fix the login", "untrusted": true},
                          "result": "usual"})
            .to_string(),
            item_key: None,
            state,
            station: None,
            reason: None,
            attempt: 1,
            resumed: 0,
            not_before: None,
            priority: 0,
            progress_done: None,
            progress_total: None,
            headline: None,
            outcome: None,
            cost_usd: 0.25,
            work_ms: 60_000,
            lead_id: None,
            device: "mac".into(),
            remote: false,
            created_at: self.now - ago,
            started_at: None,
            ended_at: None,
            updated_at: self.now - ago,
        };
        self.temp.store.write_blocking(move |tx, _| tx.runs().insert(&run)).expect("writes");
        id
    }
}

/// A routine that reviews pull requests, with three of its four options inline.
fn pr_review(summary: &str) -> Value {
    let agent = |key: &str, lead: bool| {
        json!({"key": key, "name": key, "lead": lead, "brief": "Work.", "model": "sonnet", "effort": "medium",
               "tools": {}, "readsOutside": !lead, "workspace": "worktree"})
    };
    json!({
        "format": 1,
        "name": "PR Review",
        "summary": summary,
        "icon": "eye",
        "aliases": ["review"],
        "kind": "standing",
        "takes": {"kind": "github.pull_request", "label": "pull request", "placeholder": "#470",
                  "empty": "latest", "many": true},
        "options": [
            {"key": "depth", "label": "Depth", "type": "choice", "values": ["quick", "deep"], "default": "quick",
             "inline": true},
            {"key": "long", "label": "Long", "type": "bool", "default": false, "inline": true},
            {"key": "lang", "label": "Language", "type": "text", "default": "en", "inline": true},
            {"key": "top", "label": "Top", "type": "number", "default": 3, "inline": false},
        ],
        "when": {"on": [{"schedule": {"daily": "05:00", "days": "weekdays", "zone": "Europe/Istanbul"}}]},
        "which": {"ask": "Is this about networking?"},
        "who": {"depth": "team", "agents": [agent("reader", false), agent("editor", true)],
                "checker": {"model": "sonnet", "effort": "high"}},
        "how": {"checks": [{"key": "lines", "text": "Every comment names a line."}], "format": "review",
                "checkAgent": true},
        "makes": {"kind": "github.review", "description": "A pending review."},
        "goesTo": [{"id": "pr", "kind": "item_place", "channel": "github"}],
        "freedom": {"rung": "draft"},
        "limits": {"perRunUsd": 2, "perRunMinutes": 30, "perDayUsd": 5, "parallel": 1},
    })
}

fn ids(rows: &Value) -> Vec<&str> {
    rows.as_array().expect("a list").iter().map(|row| row["id"].as_str().expect("an id")).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_fresh_home_answers_an_empty_list() {
    let bench = Bench::new();
    assert_eq!(bench.read("/api/routines").await, (200, json!([])));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_routine_reads_back_with_its_versions_numbered_by_when_they_were_made() {
    let bench = Bench::new();
    let (id, versions) = bench.routine("hand", RoutineState::Active, &[pr_review("First."), pr_review("Second.")]);
    let older = bench.run(&id, 9 * DAY, RunState::Done);
    let live = bench.run(&id, DAY, RunState::Running);
    let newest = bench.run(&id, 60_000, RunState::Queued);

    let (status, list) = bench.read("/api/routines").await;
    assert_eq!(status, 200);
    assert_eq!(ids(&list), [id.as_str()]);
    let row = &list[0];
    assert_eq!(
        (&row["name"], &row["summary"], &row["icon"], &row["kind"], &row["state"], &row["rung"]),
        (&json!("PR Review"), &json!("Second."), &json!("eye"), &json!("standing"), &json!("active"), &json!("draft")),
        "the head's blueprint"
    );
    let inline: Vec<&str> =
        row["options"].as_array().expect("options").iter().map(|o| o["key"].as_str().unwrap_or("")).collect();
    assert_eq!(inline, ["depth", "long", "lang"], "only the options the run form shows");
    assert_eq!((&row["takes"]["kind"], &row["takes"]["itemPatterns"]), (&json!("github.pull_request"), &json!([])));
    assert_eq!((&row["runs7d"], &row["activeRuns"]), (&json!(2), &json!(2)), "the week's runs; those not ended");
    assert_eq!(row["lastRun"]["id"], newest.as_str());
    assert_eq!(row["lastRun"]["itemTitle"], "Fix the login");
    for absent in ["triggerLine", "usual", "stats", "pausedReason"] {
        assert!(row.get(absent).is_none(), "{absent}");
    }

    let (status, rows) = bench.read(&format!("/api/routines/{id}/versions")).await;
    assert_eq!(status, 200);
    let numbered: Vec<(&str, i64, &str)> = rows
        .as_array()
        .expect("a list")
        .iter()
        .map(|r| {
            (r["id"].as_str().unwrap_or(""), r["number"].as_i64().unwrap_or(0), r["author"].as_str().unwrap_or(""))
        })
        .collect();
    assert_eq!(numbered, [(versions[0].as_str(), 1, "user"), (versions[1].as_str(), 2, "architect")]);
    assert_eq!(
        (&rows[1]["note"], &rows[1]["runnable"], &rows[1]["status"]),
        (&json!("Checks the tests too."), &json!(true), &json!("kept"))
    );

    let (status, first) = bench.read(&format!("/api/routines/{id}/versions/{}", versions[0])).await;
    assert_eq!(status, 200);
    assert_eq!((&first["number"], &first["blueprint"]["summary"]), (&json!(1), &json!("First.")));
    assert_eq!(first["hash"].as_str().map(str::len), Some(64));

    let (status, detail) = bench.read(&format!("/api/routines/{id}")).await;
    assert_eq!(status, 200);
    assert_eq!(&detail["routine"], row);
    assert_eq!((&detail["head"]["id"], &detail["head"]["number"]), (&json!(versions[1]), &json!(2)));
    assert_eq!(detail["head"]["blueprint"]["summary"], "Second.");
    assert!(detail.get("draft").is_none(), "nobody is making it");
    assert_eq!(ids(&detail["runs"]), [newest.as_str(), live.as_str(), older.as_str()], "newest first");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_built_in_routine_is_not_listed_and_a_deleted_one_only_while_it_can_come_back() {
    let bench = Bench::new();
    let (own, _) = bench.routine("hand", RoutineState::Active, &[pr_review("Mine.")]);
    let (forge, _) = bench.routine("builtin", RoutineState::Active, &[pr_review("The Forge's.")]);
    let (gone, _) = bench.routine("hand", RoutineState::Deleted, &[pr_review("Deleted a month ago.")]);
    let (status, list) = bench.read("/api/routines").await;
    assert_eq!((status, ids(&list)), (200, vec![own.as_str()]));
    assert_eq!(bench.read(&format!("/api/routines/{forge}")).await.0, 200, "its feature still opens it");
    for path in [format!("/api/routines/{gone}"), format!("/api/routines/{gone}/versions")] {
        assert_eq!(bench.read(&path).await.0, 404, "{path}: past Recently deleted");
    }

    // Deleted yesterday: listed and readable, so it can come back.
    let (recent, _) = bench.routine("hand", RoutineState::Deleted, &[pr_review("Deleted.")]);
    bench.temp.exec(&format!("UPDATE routines SET deleted_at = {} WHERE id = '{recent}'", bench.now - DAY));
    let (_, list) = bench.read("/api/routines").await;
    assert_eq!(ids(&list), [own.as_str(), recent.as_str()]);
    assert_eq!(bench.read(&format!("/api/routines/{recent}")).await.1["routine"]["state"], "deleted");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unknown_routine_or_version_is_not_found() {
    let bench = Bench::new();
    let (id, _) = bench.routine("hand", RoutineState::Active, &[pr_review("One.")]);
    for path in [
        "/api/routines/rt-000000000000".to_owned(),
        "/api/routines/rt-000000000000/versions".to_owned(),
        "/api/routines/rt-000000000000/versions/rv-000000000000".to_owned(),
        format!("/api/routines/{id}/versions/rv-000000000000"),
    ] {
        let (status, body) = bench.read(&path).await;
        assert_eq!(status, 404, "{path}");
        assert!(body["error"].as_str().is_some_and(|e| e.contains("not found")), "{path}: {body}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_users_dashboard_reads_them_all_and_the_phone_only_the_list_and_one_routine() {
    let bench = Bench::new();
    let (id, versions) = bench.routine("hand", RoutineState::Active, &[pr_review("One.")]);
    let list_and_detail = ["/api/routines".to_owned(), format!("/api/routines/{id}")];
    let versions = [format!("/api/routines/{id}/versions"), format!("/api/routines/{id}/versions/{}", versions[0])];
    let phone = Caller::Phone { grant: Tier::Read, mutate: true };
    let phone_without_the_user = Caller::Phone { grant: Tier::High, mutate: false };
    for path in list_and_detail.iter().chain(&versions) {
        assert_eq!(bench.read(path).await.0, 200, "{path}");
        assert_eq!(bench.get(Caller::UNTRUSTED, path).await.0, 403, "{path}: a page without the ui-token");
        assert_eq!(bench.get(phone_without_the_user.clone(), path).await.0, 403, "{path}");
    }
    for path in &list_and_detail {
        assert_eq!(bench.get(phone.clone(), path).await.0, 200, "{path}");
    }
    for path in &versions {
        assert_eq!(bench.get(phone.clone(), path).await.0, 403, "{path}: never the phone");
    }
}
