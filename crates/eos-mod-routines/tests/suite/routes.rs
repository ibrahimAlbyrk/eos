//! The read routes on a store the test fills: a routine with two versions
//! and a few runs, a built-in one, a deleted one; and who may read them.

use std::sync::Arc;

use eos_contracts::{RoutineKind, RoutineState, VersionAuthor, VersionStatus};
use eos_core::Ids;
use eos_core::store::{StoredRoutine, StoredRun, StoredVersion};
use eos_domain::routine::blueprint::{Readable, canonical_json, hash, read};
use eos_domain::routine::run::RunState;
use eos_domain::run_scope::Trust;
use eos_runtime::access::{Caller, Tier};
use eos_runtime::http::{Method, Request};
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_testkit::{FakeClock, SeqIds};
use serde_json::{Value, json};

const DAY: i64 = 24 * 60 * 60 * 1000;

struct Bench {
    runtime: Runtime,
    /// The module and its store.
    rig: crate::bench::Bench,
    ids: SeqIds,
    now: i64,
}

impl Bench {
    fn new() -> Self {
        let rig = crate::bench::Bench::new(true);
        let now = FakeClock::START_MS;
        let module: Arc<dyn eos_runtime::module::Module> = rig.module.clone();
        let runtime = Runtime::build(Kernel::new(KernelOptions::default()), vec![module], Arc::new(AllPluginsOn))
            .expect("composes");
        assert_eq!(runtime.router.undeclared(), Vec::<String>::new());
        Self { runtime, rig, ids: SeqIds::new(), now }
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
        self.routine_made(origin, state, blueprints, self.now - 10 * DAY)
    }

    fn routine_made(
        &self,
        origin: &str,
        state: RoutineState,
        blueprints: &[Value],
        made: i64,
    ) -> (String, Vec<String>) {
        let id = self.ids.routine_id();
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
        self.rig
            .temp
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
        self.rig.temp.store.write_blocking(move |tx, _| tx.runs().insert(&run)).expect("writes");
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
async fn a_routine_that_waits_on_another_names_it_in_its_trigger_line() {
    let bench = Bench::new();
    let (upstream, _) = bench.routine("hand", RoutineState::Active, &[pr_review("Reviews.")]);
    let mut chained = pr_review("Follows up.");
    chained["when"] = json!({"on": [{"after": {"routine": upstream, "outcome": "done"}}]});
    let (id, _) = bench.routine("hand", RoutineState::Active, &[chained]);
    let (_, list) = bench.read("/api/routines").await;
    let row = list.as_array().expect("a list").iter().find(|row| row["id"] == id.as_str()).expect("its row");
    assert_eq!(row["triggerLine"], "After a run of PR Review finishes", "by name, not by id");
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
    assert_eq!(row["triggerLine"], "Every weekday at 05:00");
    assert_eq!(row["usual"], json!({"usd": 0.25, "ms": 60_000}), "its one finished run");
    assert!(row.get("pausedReason").is_none());
    assert_eq!(row["stats"]["runs7d"], 2, "the row's numbers");

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
    bench.rig.temp.exec(&format!("UPDATE routines SET deleted_at = {} WHERE id = '{recent}'", bench.now - DAY));
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

#[tokio::test(flavor = "multi_thread")]
async fn a_routine_row_carries_its_numbers() {
    let bench = Bench::new();
    let (id, _) = bench.routine("hand", RoutineState::Active, &[pr_review("Reviews.")]);
    bench.run(&id, 9 * DAY, RunState::Done);
    bench.run(&id, 2 * DAY, RunState::Done);
    bench.run(&id, DAY, RunState::Failed);
    let made = bench.now - 10 * DAY;
    // The first week: one of two sent as it was; this week: three of four.
    let outcomes = [
        (made + DAY, "sent_unedited"),
        (made + 2 * DAY, "sent_edited"),
        (made + 3 * DAY, "auto_clean"),
        (bench.now - 3 * DAY, "sent_unedited"),
        (bench.now - 2 * DAY, "sent_unedited"),
        (bench.now - 2 * DAY, "discarded"),
        (bench.now - DAY, "sent_unedited"),
        (bench.now - DAY, "expired"),
    ];
    let routine = id.clone();
    bench
        .rig
        .temp
        .store
        .write_blocking(move |tx, _| {
            for (at, outcome) in outcomes {
                tx.inbox_outcomes().insert(&eos_core::store::NewOutcome {
                    routine_id: routine.clone(),
                    run_id: "rn-x".into(),
                    item_id: None,
                    delivery_id: None,
                    outcome: outcome.into(),
                    rung: "draft".into(),
                    at,
                })?;
            }
            tx.routine_spend().add("2027-01-05", &routine, "architect", 1.25)?;
            tx.routine_spend().add("2027-01-06", &routine, "architect", 0.25)?;
            tx.routine_spend().add("2027-01-06", &routine, "run", 9.0)
        })
        .expect("writes");

    let (_, detail) = bench.read(&format!("/api/routines/{id}")).await;
    assert_eq!(
        detail["routine"]["stats"],
        json!({"sentUnedited7d": 0.75, "baselineFirstWeek": 0.5, "runs7d": 2, "cost7d": 0.5, "setupUsd": 1.5})
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_routine_row_carries_the_share_of_each_week_between_its_first_and_this_one() {
    let bench = Bench::new();
    let (id, _) = bench.routine_made("hand", RoutineState::Active, &[pr_review("Reviews.")], bench.now - 30 * DAY);
    // The week before this one: one of two; two weeks before: none judged;
    // three weeks before began inside the first week, so it is left out.
    let outcomes = [
        (bench.now - 8 * DAY, "sent_unedited"),
        (bench.now - 9 * DAY, "discarded"),
        (bench.now - 16 * DAY, "auto_sent"),
        (bench.now - 22 * DAY, "sent_unedited"),
    ];
    let routine = id.clone();
    bench
        .rig
        .temp
        .store
        .write_blocking(move |tx, _| {
            for (at, outcome) in outcomes {
                tx.inbox_outcomes().insert(&eos_core::store::NewOutcome {
                    routine_id: routine.clone(),
                    run_id: "rn-x".into(),
                    item_id: None,
                    delivery_id: None,
                    outcome: outcome.into(),
                    rung: "draft".into(),
                    at,
                })?;
            }
            Ok(())
        })
        .expect("writes");

    let (_, detail) = bench.read(&format!("/api/routines/{id}")).await;
    assert_eq!(detail["routine"]["stats"]["weeksBetween"], json!([null, 0.5]));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_runs_summary_counts_by_how_runs_ended_and_by_routine() {
    let bench = Bench::new();
    let (first, _) = bench.routine("hand", RoutineState::Active, &[pr_review("Reviews.")]);
    let (second, _) = bench.routine("hand", RoutineState::Active, &[pr_review("Reviews.")]);
    let ended = |routine: &str, ago: i64, state: RunState, outcome: Option<&str>| {
        let run = bench.run(routine, ago, state);
        let outcome = outcome.map_or("NULL".to_owned(), |word| format!("'{word}'"));
        bench
            .rig
            .temp
            .exec(&format!("UPDATE runs SET ended_at = {}, outcome = {outcome} WHERE id = '{run}'", bench.now - ago));
    };
    ended(&first, 3 * DAY, RunState::Done, Some("sent_unedited"));
    ended(&first, DAY, RunState::Done, Some("sent_unedited"));
    ended(&first, DAY, RunState::Failed, None);
    ended(&second, DAY, RunState::Done, Some("discarded"));
    ended(&second, 5 * DAY, RunState::Done, Some("shown"));
    bench.run(&second, DAY, RunState::Running);

    let since = bench.now - 4 * DAY;
    let (status, summary) = bench.read(&format!("/api/runs/summary?since={since}")).await;
    assert_eq!(status, 200, "{summary}");
    assert_eq!(summary["since"], since);
    assert_eq!(summary["byOutcome"], json!({"sent_unedited": 2, "failed": 1, "discarded": 1}));
    assert_eq!(summary["byRoutine"][&first], json!({"failed": 1, "sent_unedited": 2}));
    assert_eq!(summary["byRoutine"][&second], json!({"discarded": 1}));
    assert_eq!(bench.read("/api/runs/summary").await.0, 400, "since is required");
    assert_eq!(
        bench
            .get(Caller::Phone { grant: Tier::Read, mutate: false }, &format!("/api/runs/summary?since={since}"))
            .await
            .0,
        200
    );
}
