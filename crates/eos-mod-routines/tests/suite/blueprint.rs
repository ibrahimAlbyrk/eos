//! A routine's blueprint written by hand: made from a blueprint, a new
//! version kept from the head (409 on a stale base), its rules' errors and
//! warnings, its trust, an old version restored, a copy; the budgets for all
//! routines and who may call what.

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
async fn a_routine_made_by_hand_is_a_draft_with_the_default_limits_and_a_free_slug() {
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
    assert_eq!(kept["limits"]["perDayUsd"], json!(5));
    assert_eq!(kept["limits"]["perRunMinutes"], json!(30));
    assert_eq!(kept["limits"]["parallel"], json!(1));
    assert_eq!(kept["limits"]["perRunUsd"], json!(1), "three times a small estimate is under the dollar floor");
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
async fn the_budgets_read_their_defaults_change_through_their_own_route_and_today_s_raise_ends_at_midnight() {
    let routes = Routes::new();
    let (status, settings) = routes.get("/api/routines/settings").await;
    assert_eq!(status, 200);
    assert_eq!(settings, json!({"dayBudgetUsd": 20, "maxParallelRuns": 3, "planHeadroomPct": 80}));

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
