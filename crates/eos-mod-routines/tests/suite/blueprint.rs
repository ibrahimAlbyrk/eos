//! A routine's blueprint written by hand: made from a blueprint, a new
//! version kept from the head (409 on a stale base), its rules' errors and
//! warnings, its trust, an old version restored, a copy; what a new head
//! does to the routine's offers; the budgets for all routines and who may
//! call what.

use eos_contracts::{RoutineState, SettingValue};
use eos_core::capability::Capability;
use eos_core::store::StoredVersion;
use eos_domain::capability::health::Health;
use eos_domain::run_scope::Trust;
use eos_runtime::access::{Caller, Tier};
use eos_runtime::http::Method;
use eos_runtime::module::Module;
use eos_testkit::FakeCapabilityReads;
use serde_json::{Value, json};

use crate::bench::{Bench, blueprint};
use crate::run_routes::Routes;

/// A mail capability whose inbox read brings text from outside.
const MAIL: &str = r#"
id = "mail"
name = "Mail"
version = "1"
summary = "Reads mail."
form = "builtin"
works = "any_mac"

[[actions]]
name = "inbox"
summary = "The newest mail."
class = "read"
output = { type = "array", items = { type = "object", properties = { body = { type = "string", untrusted = true } } } }

[[actions]]
name = "poll"
summary = "Mail since the cursor."
class = "read"
output = { type = "object", properties = { items = { type = "array", items = { type = "object", properties = { key = { type = "string", untrusted = true }, facts = { type = "object", properties = { from = { type = "string", untrusted = true }, account = { type = "string" } } } } } } } }

[[sources]]
name = "received"
item = "mail.message"
action = "poll"
facts = { from = "string", account = "string" }
"#;

fn mail() -> Capability {
    let manifest = eos_domain::capability::manifest::parse(MAIL).expect("a manifest");
    Capability {
        id: manifest.id.clone(),
        origin: "builtin".into(),
        version: None,
        manifest,
        health: Health::ready(),
        settings: json!({}),
        account_label: None,
    }
}

/// A routine that tidies a folder: nothing it reads comes from outside.
fn folder(name: &str) -> Value {
    let mut folder = blueprint(1);
    folder["name"] = json!(name);
    folder["takes"] = json!({"kind": "folder", "label": "folder", "placeholder": "~/Downloads", "empty": "none",
                             "many": false});
    folder["when"] = json!({"on": [{"schedule": {"daily": "08:00", "days": "all", "zone": "Europe/Istanbul"}}]});
    folder.as_object_mut().expect("an object").remove("limits");
    folder
}

impl Routes {
    fn with_mail() -> Self {
        Self::over(Bench::with_reads(true, FakeCapabilityReads::new().listing(mail())))
    }

    async fn create(&self, blueprint: Value) -> (u16, Value) {
        self.post("/api/routines", json!({"blueprint": blueprint})).await
    }

    async fn keep(&self, routine: &str, base: &str, blueprint: Value) -> (u16, Value) {
        let body = json!({"baseVersionId": base, "blueprint": blueprint, "note": "tighter"});
        self.call(Method::Put, Caller::DASHBOARD, &format!("/api/routines/{routine}/blueprint"), Some(body)).await
    }

    pub(crate) fn versions(&self, routine: &str) -> Vec<StoredVersion> {
        let id = routine.to_owned();
        self.bench.temp.store.read_blocking(move |tx| tx.routine_versions().list(&id)).expect("reads")
    }

    fn routine_changes(&self) -> Vec<Value> {
        let announced = self.bench.temp.announced.list().into_iter().filter(|(topic, _)| *topic == "routine:change");
        announced.map(|(_, payload)| serde_json::from_str(&payload).expect("json")).collect()
    }
}

fn id_of(saved: &Value) -> String {
    saved["row"]["id"].as_str().expect("a routine").to_owned()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_routine_made_by_hand_is_a_draft_with_the_default_limits_no_spend_cap_and_a_free_slug() {
    let routes = Routes::new();
    let (status, saved) = routes.create(folder("Tidy Downloads")).await;
    assert_eq!(status, 201, "{saved}");
    let routine = id_of(&saved);
    assert_eq!(
        (saved["row"]["state"].as_str(), saved["row"]["slug"].as_str()),
        (Some("draft"), Some("tidy-downloads"))
    );
    assert_eq!(saved["warnings"], json!([]));
    let versions = routes.versions(&routine);
    assert_eq!(versions.len(), 1);
    let version = &versions[0];
    assert_eq!(saved["versionId"].as_str(), Some(version.id.as_str()));
    assert_eq!(
        (version.status, version.author, version.trust),
        (eos_contracts::VersionStatus::Draft, eos_contracts::VersionAuthor::User, Trust::Trusted)
    );
    let kept: Value = serde_json::from_str(&version.blueprint).expect("json");
    assert_eq!(kept["limits"], json!({"perRunMinutes": 30, "parallel": 1}), "no dollar cap unless one is set");
    let changes = routes.routine_changes();
    assert_eq!((changes.len(), changes[0]["reason"].as_str()), (1, Some("created")));
    assert_eq!(changes[0]["row"]["id"].as_str(), Some(routine.as_str()));

    let (_, second) = routes.create(folder("Tidy Downloads")).await;
    assert_eq!(second["row"]["slug"].as_str(), Some("tidy-downloads-2"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_blueprint_that_breaks_its_rules_is_refused_with_every_finding() {
    let routes = Routes::new();
    let mut broken = folder("Tidy");
    broken["when"]["on"][0]["schedule"]["zone"] = json!("Mars/Olympus");
    broken["limits"] = json!({"parallel": 9});
    let (status, refused) = routes.create(broken).await;
    assert_eq!(status, 400, "{refused}");
    let paths: Vec<String> = refused["issues"]
        .as_array()
        .expect("issues")
        .iter()
        .map(|issue| {
            assert_eq!(issue["severity"], json!("error"));
            issue["path"].as_array().expect("a path").iter().filter_map(Value::as_str).collect::<Vec<_>>().join(".")
        })
        .collect();
    assert!(paths.iter().any(|path| path.starts_with("when.on.0.schedule")), "{paths:?}");
    assert!(paths.contains(&"limits.parallel".to_owned()), "{paths:?}");
    let (status, refused) = routes.create(json!({"format": 1, "name": "half"})).await;
    assert_eq!((status, refused["issues"].as_array().map(|issues| !issues.is_empty())), (400, Some(true)));
    assert!(routes.routine_changes().is_empty(), "nothing was written");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_version_is_kept_from_the_head_and_a_stale_base_is_refused() {
    let routes = Routes::new();
    let routine = routes.bench.routine(RoutineState::Active, blueprint(1));
    let head = routes.versions(&routine)[0].id.clone();
    let mut edited = blueprint(2);
    edited["name"] = json!("PR Review, careful");

    let (status, saved) = routes.keep(&routine, &head, edited.clone()).await;
    assert_eq!(status, 200, "{saved}");
    assert_eq!(saved["row"]["name"].as_str(), Some("PR Review, careful"));
    let versions = routes.versions(&routine);
    let kept = versions.last().expect("a new version");
    assert_eq!(saved["versionId"].as_str(), Some(kept.id.as_str()));
    assert_eq!((kept.parent_id.as_deref(), kept.note.as_deref()), (Some(head.as_str()), Some("tighter")));
    assert_eq!(kept.status, eos_contracts::VersionStatus::Kept);
    assert_eq!(kept.trust, Trust::Untrusted, "a pull request trigger brings outside text");
    let id = routine.clone();
    let row = routes.bench.temp.store.read_blocking(move |tx| tx.routines().find(&id)).expect("reads").expect("one");
    assert_eq!(row.head_version_id.as_deref(), Some(kept.id.as_str()));
    assert_eq!(versions[0].blueprint, routes.versions(&routine)[0].blueprint, "a version never changes");
    assert_eq!(routes.routine_changes().last().map(|change| change["reason"].clone()), Some(json!("version")));

    let (status, _) = routes.keep(&routine, &head, edited).await;
    assert_eq!(status, 409, "the head moved on since");
    assert_eq!(routes.versions(&routine).len(), 2);
    assert_eq!(routes.keep("rt-missing", &head, blueprint(1)).await.0, 404);

    let mut project = blueprint(2);
    project["kind"] = json!("project");
    project["takes"] = json!({"kind": "none", "label": "nothing", "placeholder": "", "empty": "none", "many": false});
    project["when"] = json!({"on": []});
    project["makes"] = json!({"kind": "report", "description": "What was built."});
    project["project"] = json!({"repo": "/tmp/game", "baseBranch": "main", "brief": "Build the game's app.",
        "milestones": [{"key": "login", "title": "The login screen", "doneWhen": "a user can sign in"}]});
    let head = routes.versions(&routine).last().expect("the head").id.clone();
    let (status, saved) = routes.keep(&routine, &head, project).await;
    assert_eq!((status, saved["row"]["kind"].as_str()), (200, Some("project")), "{saved}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_version_reads_outside_text_through_a_trigger_its_takes_or_a_needed_read() {
    let routes = Routes::with_mail();
    let (_, plain) = routes.create(folder("Tidy")).await;
    let mut mailed = folder("Mail digest");
    mailed["needs"] = json!(["mail"]);
    let (_, needs) = routes.create(mailed).await;
    let mut taking = folder("From pulls");
    taking["takes"]["source"] = json!("github.pulls");
    let (_, takes) = routes.create(taking).await;
    let (_, pulls) = routes.create(blueprint(1)).await;
    let trust = |saved: &Value| routes.versions(&id_of(saved))[0].trust;
    assert_eq!(trust(&plain), Trust::Trusted, "a folder routine");
    assert_eq!(trust(&needs), Trust::Untrusted, "the mail it needs reads outside text");
    assert_eq!(trust(&takes), Trust::Untrusted);
    assert_eq!(trust(&pulls), Trust::Untrusted, "PR Review");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_grant_or_bound_on_a_fact_the_sender_writes_is_refused_when_saved() {
    let routes = Routes::with_mail();
    let mut mailed = folder("Answer the boss");
    mailed["takes"]["source"] = json!("mail.received");
    mailed["freedom"] = json!({"rung": "draft", "grants": [
        {"id": "g1", "when": {"fact": "account", "is": "work"}, "rung": "on_its_own"},
        {"id": "g2", "when": {"not": {"fact": "from", "glob": "*@acme.dev"}}, "rung": "on_its_own"}]});
    mailed["goesTo"] = json!([{"id": "sender", "kind": "item_place", "channel": "mail",
                               "bound": {"fact": "key", "contains": "acme"}}]);
    let (status, refused) = routes.create(mailed.clone()).await;
    assert_eq!(status, 400, "{refused}");
    let paths: Vec<String> = refused["issues"]
        .as_array()
        .expect("issues")
        .iter()
        .map(|issue| {
            issue["path"].as_array().expect("a path").iter().filter_map(Value::as_str).collect::<Vec<_>>().join(".")
        })
        .collect();
    assert_eq!(paths, ["freedom.grants.1.when", "goesTo.0.bound"], "only the grant on a trusted fact stays");

    mailed["freedom"]["grants"].as_array_mut().expect("grants").truncate(1);
    mailed["goesTo"][0]["bound"] = json!({"fact": "account", "is": "work"});
    let (status, saved) = routes.create(mailed).await;
    assert_eq!(status, 201, "{saved}");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_old_version_comes_back_as_a_new_head_and_a_copy_is_a_draft_of_its_own() {
    let routes = Routes::new();
    let routine = routes.bench.routine(RoutineState::Active, blueprint(1));
    let first = routes.versions(&routine)[0].clone();
    routes.keep(&routine, &first.id, blueprint(2)).await;

    let path = format!("/api/routines/{routine}/versions/{}/restore", first.id);
    let (status, saved) = routes.post(&path, json!({})).await;
    assert_eq!(status, 200, "{saved}");
    let versions = routes.versions(&routine);
    let restored = versions.last().expect("a third version");
    assert_eq!((versions.len(), restored.author), (3, eos_contracts::VersionAuthor::Restore));
    assert_eq!(
        (restored.hash.as_str(), restored.parent_id.as_deref()),
        (first.hash.as_str(), Some(versions[1].id.as_str()))
    );
    assert_ne!(restored.id, first.id);
    let missing = format!("/api/routines/{routine}/versions/rv-missing/restore");
    assert_eq!(routes.post(&missing, json!({})).await.0, 404);

    let (status, copy) = routes.post(&format!("/api/routines/{routine}/copy"), json!({})).await;
    assert_eq!(status, 201, "{copy}");
    let copied = id_of(&copy);
    assert_ne!(copied, routine);
    assert_eq!((copy["row"]["state"].as_str(), copy["row"]["name"].as_str()), (Some("draft"), Some("PR Review")));
    let id = copied.clone();
    let row = routes.bench.temp.store.read_blocking(move |tx| tx.routines().find(&id)).expect("reads").expect("one");
    assert_eq!((row.origin.as_str(), row.head_version_id), ("copy", None));
    assert_eq!(routes.versions(&copied)[0].hash, restored.hash, "the blueprint the routine shows");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_budgets_read_their_defaults_change_through_their_own_route_and_today_s_raise_ends_at_midnight_and_null_takes_the_day_budget_away()
 {
    let routes = Routes::new();
    let (status, settings) = routes.get("/api/routines/settings").await;
    assert_eq!(status, 200);
    assert_eq!(settings, json!({"maxParallelRuns": 3, "planHeadroomPct": 80}), "no day budget by default");

    // The fake clock stands at 2027-01-15 11:00 in Istanbul.
    let patch = json!({"dayBudgetUsd": 12.5, "maxParallelRuns": 2, "raisedToday": {"day": "2027-01-15", "usd": 30}});
    let put = |body: Value| routes.call(Method::Put, Caller::DASHBOARD, "/api/routines/settings", Some(body));
    let (status, settings) = put(patch).await;
    assert_eq!(status, 200, "{settings}");
    let expected = json!({"dayBudgetUsd": 12.5, "maxParallelRuns": 2, "planHeadroomPct": 80,
                          "raisedToday": {"day": "2027-01-15", "usd": 30}});
    assert_eq!(settings, expected);
    assert_eq!(routes.get("/api/routines/settings").await.1, expected);
    let stored = routes.bench.settings.0.lock().expect("settings").clone();
    assert!(matches!(stored.get("routines.maxParallelRuns"), Some(SettingValue::Number(_))));
    assert_eq!(put(json!({"maxParallelRuns": 4})).await.0, 400);

    routes.bench.clock.advance(24 * crate::bench::HOUR);
    let (_, settings) = routes.get("/api/routines/settings").await;
    assert_eq!(settings.get("raisedToday"), None, "a raise ends at local midnight");
    let (status, settings) = put(json!({"dayBudgetUsd": null})).await;
    assert_eq!(status, 200, "{settings}");
    assert_eq!(settings, json!({"maxParallelRuns": 2, "planHeadroomPct": 80}), "null takes the day budget away");

    // The flat settings route refuses the keys and names this one.
    let protected = routes.bench.module.protected_settings().expect("protected keys");
    let refusal = protected.refusal(["routines.dayBudgetUsd", "theme"]).expect("refused");
    assert_eq!(refusal, "routines.dayBudgetUsd is set only through PUT /api/routines/settings");
    assert_eq!(protected.keys.len(), 4);
}

#[tokio::test(flavor = "multi_thread")]
async fn only_the_users_dashboard_writes_a_blueprint_or_the_budgets_and_anyone_reads_the_budgets() {
    let routes = Routes::new();
    let routine = routes.bench.routine(RoutineState::Active, blueprint(1));
    let head = routes.versions(&routine)[0].id.clone();
    let low = Caller::Phone { grant: Tier::Low, mutate: true };
    for (method, path) in [
        (Method::Post, "/api/routines".to_owned()),
        (Method::Put, format!("/api/routines/{routine}/blueprint")),
        (Method::Post, format!("/api/routines/{routine}/versions/{head}/restore")),
        (Method::Post, format!("/api/routines/{routine}/copy")),
        (Method::Put, "/api/routines/settings".to_owned()),
    ] {
        assert_eq!(routes.call(method, Caller::UNTRUSTED, &path, Some(json!({}))).await.0, 403, "{path}");
        assert_eq!(routes.call(method, low.clone(), &path, Some(json!({}))).await.0, 403, "{path}");
    }
    let (status, _) = routes.call(Method::Get, Caller::UNTRUSTED, "/api/routines/settings", None).await;
    assert_eq!(status, 200, "the literal path wins over /api/routines/{{id}}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_head_whose_freedom_the_user_changed_lifts_never_and_one_with_other_work_resets_the_streak() {
    let routes = Routes::new();
    let routine = routes.bench.routine(RoutineState::Active, blueprint(1));
    let (offers, outcomes) = (routine.clone(), routine.clone());
    routes
        .bench
        .temp
        .exec(&format!("INSERT INTO inbox_offers (routine_id, state, updated_at) VALUES ('{offers}', 'never', 1)"));
    for _ in 0..3 {
        routes.bench.temp.exec(&format!(
            "INSERT INTO inbox_outcomes (routine_id, run_id, outcome, rung, at) \
             VALUES ('{outcomes}', 'rn-old', 'sent_unedited', 'draft', 1)"
        ));
    }
    let offer = |routes: &Routes| {
        let id = routine.clone();
        let row = routes.bench.temp.store.read_blocking(move |tx| tx.inbox_offers().find(&id)).expect("reads");
        let row = row.expect("an offer row");
        (row.state, row.streak_at)
    };
    let head = |routes: &Routes| routes.versions(&routine).last().expect("a head").id.clone();

    let mut renamed = blueprint(1);
    renamed["name"] = json!("PR Review, renamed");
    assert_eq!(routes.keep(&routine, &head(&routes), renamed.clone()).await.0, 200);
    assert_eq!(offer(&routes), ("never".to_owned(), None), "neither Freedom nor the work changed");

    let mut freer = renamed.clone();
    freer["freedom"] = json!({"rung": "ask"});
    assert_eq!(routes.keep(&routine, &head(&routes), freer.clone()).await.0, 200);
    assert_eq!(offer(&routes), ("none".to_owned(), None), "a hand change of Freedom lifts never");

    let mut deeper = freer;
    deeper["how"]["steps"] = json!(["Read every changed file."]);
    assert_eq!(routes.keep(&routine, &head(&routes), deeper).await.0, 200);
    let (state, streak_at) = offer(&routes);
    assert_eq!(state, "none");
    assert!(streak_at.is_some(), "the streak counts from the new head");
}

fn watching(name: &str, paths: &[String]) -> Value {
    let mut watching = folder(name);
    let on: Vec<Value> = paths.iter().map(|path| json!({"folder": {"path": path, "events": ["added"]}})).collect();
    watching["when"] = json!({"on": on});
    watching
}

#[tokio::test(flavor = "multi_thread")]
async fn a_folder_past_its_limits_is_refused_when_saved() {
    let routes = Routes::new();
    let home = routes.bench.temp.home.path();
    let full = home.join("full");
    std::fs::create_dir_all(&full).expect("a folder");
    for n in 0..=5_000 {
        std::fs::write(full.join(format!("{n}.txt")), "").expect("a file");
    }
    let (status, refused) = routes.create(watching("Full", &[full.to_string_lossy().into_owned()])).await;
    assert_eq!(status, 400, "{refused}");
    assert_eq!(refused["issues"][0]["path"], json!(["when", "on", "0", "folder", "path"]), "{refused}");
    assert_eq!(refused["issues"][0]["message"], "Holds more than 5000 entries");

    let folders: Vec<String> = (0..20).map(|n| format!("/Users/me/watched-{n}")).collect();
    let mut twenty = blueprint(1);
    twenty["when"] = watching("Twenty", &folders)["when"].clone();
    routes.bench.routine(RoutineState::Active, twenty);
    let (status, saved) = routes.create(watching("Same", &folders[..1])).await;
    assert_eq!(status, 201, "a folder watched already adds none: {saved}");
    let (status, refused) = routes.create(watching("One more", &["/Users/me/another".to_owned()])).await;
    assert_eq!(status, 400, "{refused}");
    assert_eq!(refused["issues"][0]["message"], "Would watch more than 20 folders at once", "{refused}");
}
