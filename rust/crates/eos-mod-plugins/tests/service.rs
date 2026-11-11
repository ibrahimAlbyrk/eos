//! `PluginService` over in-memory ports: what `core/src/__tests__/PluginService.test.ts`
//! pins, and what the Rust service adds (single-flight under threads, settling, stopping).

use std::sync::Arc;
use std::time::Duration;

use eos_contracts::{PluginId, PluginManifest, PluginReportRequest, PluginSettingValue, PluginState};
use eos_core::plugin::PluginBuild;
use eos_mod_plugins::{PluginService, PluginServiceDeps, PluginServiceOptions};
use eos_runtime::bus::{Bus, BusOptions, EventReceiver, Filter};
use eos_runtime::ordered::Ordered;
use eos_testkit::FakeClock;
use eos_testkit::plugins::{FakePluginBuilder, FakePluginDataStore, FakePluginWorkspace};
use indexmap::IndexMap;
use serde_json::{Value, json};

fn manifest(id: &str, extra: Value) -> String {
    let mut all = json!({ "id": id, "name": id });
    if let (Some(all), Some(extra)) = (all.as_object_mut(), extra.as_object()) {
        all.extend(extra.clone());
    }
    all.to_string()
}

fn plain(id: &str) -> String {
    manifest(id, json!({}))
}

struct Setup {
    svc: Arc<PluginService>,
    workspace: Arc<FakePluginWorkspace>,
    builder: Arc<FakePluginBuilder>,
    clock: Arc<FakeClock>,
    bus: Bus,
    events: EventReceiver,
}

impl Setup {
    /// The next event: `(topic, payload)`.
    async fn next(&mut self) -> (String, Value) {
        let event = tokio::time::timeout(Duration::from_secs(5), self.events.recv())
            .await
            .expect("an event in time")
            .expect("an event");
        (event.topic.to_string(), event.payload_as().expect("JSON"))
    }

    /// Waits for `plugins:change` about `id`.
    async fn changed(&mut self, id: &str) {
        loop {
            if self.next().await == ("plugins:change".to_owned(), json!({ "id": id })) {
                return;
            }
        }
    }

    /// Everything published so far, oldest first.
    async fn published(&mut self) -> Vec<(String, Value)> {
        self.bus.flush().await;
        let mut seen = Vec::new();
        while let Ok(Ok(event)) = tokio::time::timeout(Duration::ZERO, self.events.recv()).await {
            seen.push((event.topic.to_string(), event.payload_as().expect("JSON")));
        }
        seen
    }
}

fn setup(folders: &[(&str, Option<String>, &[&str])], builtins: &[(&str, &str)]) -> Setup {
    let workspace = Arc::new(FakePluginWorkspace::new());
    for (id, text, files) in folders {
        workspace.put(id, text.as_deref(), files);
    }
    let builder = Arc::new(FakePluginBuilder::new());
    let clock = Arc::new(FakeClock::new());
    let bus = Bus::new(Ordered::new(), clock.clone(), BusOptions::default());
    let events = bus.subscribe(Filter::All, 256);
    let svc = PluginService::new(PluginServiceDeps {
        workspace: workspace.clone(),
        builder: builder.clone(),
        data: Arc::new(FakePluginDataStore::new()),
        clock: clock.clone(),
        bus: bus.clone(),
        builtins: builtins
            .iter()
            .map(|(id, name)| PluginManifest {
                id: PluginId((*id).to_owned()),
                name: (*name).to_owned(),
                description: None,
                version: None,
                icon: None,
                ui: None,
                settings: None,
                experimental: None,
            })
            .collect(),
        options: PluginServiceOptions { debounce: Duration::ZERO, settle_timeout: Duration::from_millis(200) },
    });
    Setup { svc, workspace, builder, clock, bus, events }
}

const UI: &[&str] = &["plugin.json", "ui.jsx"];

fn one(id: &str) -> Setup {
    setup(&[(id, Some(plain(id)), UI)], &[])
}

#[tokio::test(flavor = "multi_thread")]
async fn builds_every_enabled_plugin_with_a_ui_entry_on_start() {
    let t =
        setup(&[("clock", Some(plain("clock")), UI), ("notes", Some(plain("notes")), &["plugin.json", "ui.tsx"])], &[]);
    t.svc.start().await;
    let mut builds = t.builder.builds();
    builds.sort();
    assert_eq!(builds, ["/p/clock/ui.jsx", "/p/notes/ui.tsx"]);
    let clock = t.svc.get("clock").expect("listed");
    assert_eq!(clock.state, PluginState::Active);
    assert!(clock.has_ui && !clock.has_css && !clock.builtin);
    assert_eq!(clock.dir, "/p/clock");
    let bundle = t.svc.bundle("clock", clock.rev).expect("the build");
    assert_eq!(&bundle.js[..], b"// /p/clock");
    assert!(t.workspace.is_watched(), "changes are followed from now on");
    assert_eq!(t.svc.list().iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["clock", "notes"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_file_change_rebuilds_under_a_new_revision_and_the_old_one_is_gone() {
    let mut t = one("clock");
    t.svc.start().await;
    let first = t.svc.get("clock").expect("listed").rev;
    t.published().await;
    t.workspace.change("clock");
    t.changed("clock").await;
    let second = t.svc.get("clock").expect("listed").rev;
    assert!(second > first);
    assert!(t.svc.bundle("clock", first).is_none());
    assert!(t.svc.bundle("clock", second).is_some());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_build_reports_why_and_keeps_the_last_good_build() {
    let t = one("clock");
    t.svc.start().await;
    let good = t.svc.get("clock").expect("listed").rev;
    t.builder.fail_next("ui.jsx:3:1: Unexpected end of file");
    t.svc.refresh("clock").await;
    let info = t.svc.get("clock").expect("listed");
    assert_eq!(info.state, PluginState::Error);
    assert_eq!(info.error.as_deref(), Some("ui.jsx:3:1: Unexpected end of file"));
    assert_eq!(info.rev, good);
    assert!(info.has_ui);
    assert!(t.svc.bundle("clock", good).is_some(), "the last good build still loads");

    // The next good build clears the error.
    t.svc.refresh("clock").await;
    let fixed = t.svc.get("clock").expect("listed");
    assert_eq!((fixed.state, fixed.error), (PluginState::Active, None));
    assert!(fixed.rev > good);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_bad_manifest_is_an_error_naming_the_problem_and_the_id_must_match_the_folder() {
    let t = setup(&[("a", Some("{nope".into()), UI), ("b", Some(plain("other")), UI), ("c", None, UI)], &[]);
    t.svc.start().await;
    let error = |id: &str| t.svc.get(id).expect("listed").error.unwrap_or_default();
    assert!(error("a").starts_with("plugin.json is not valid JSON"), "{}", error("a"));
    assert_eq!(error("b"), "plugin.json: id \"other\" must match the folder name \"b\"");
    assert_eq!(error("c"), "plugin.json is missing");
    assert_eq!(t.svc.get("c").expect("listed").manifest, None);
    assert!(t.builder.builds().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn experimental_plugins_start_off_and_turning_one_on_builds_it() {
    let t = setup(&[("lab", Some(manifest("lab", json!({ "experimental": true }))), UI)], &[]);
    t.svc.start().await;
    assert_eq!(t.svc.get("lab").expect("listed").state, PluginState::Disabled);
    assert!(t.builder.builds().is_empty());
    let on = t.svc.set_enabled("lab", true).await.expect("switches");
    assert_eq!(on.state, PluginState::Active);
    assert!(on.has_ui && on.enabled);
    let off = t.svc.set_enabled("lab", false).await.expect("switches");
    assert!(!off.has_ui);
    assert_eq!(off.rev, 0);
    assert_eq!(t.svc.set_enabled("nope", true).await.expect_err("unknown").to_string(), "plugin not found: nope");
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_fill_in_defaults_refuse_unknown_keys_and_announce_the_change() {
    let settings = json!({ "settings": {
        "seconds": { "type": "boolean", "title": "Seconds", "default": false },
        "tz": { "type": "select", "title": "Zone", "options": [{ "value": "utc", "label": "UTC" }], "default": "utc" },
    }});
    let mut t = setup(&[("clock", Some(manifest("clock", settings)), UI)], &[]);
    t.svc.start().await;
    let values = |info: eos_contracts::PluginInfo| serde_json::to_value(info.settings).expect("JSON");
    assert_eq!(values(t.svc.get("clock").expect("listed")), json!({ "seconds": false, "tz": "utc" }));
    t.published().await;

    let change = IndexMap::from([("seconds".to_owned(), PluginSettingValue::Flag(true))]);
    assert_eq!(values(t.svc.set_settings("clock", &change).expect("saves")), json!({ "seconds": true, "tz": "utc" }));
    assert_eq!(t.published().await, [("plugins:change".to_owned(), json!({ "id": "clock" }))]);

    let unknown = IndexMap::from([("nope".to_owned(), PluginSettingValue::Number(1.into()))]);
    assert_eq!(
        t.svc.set_settings("clock", &unknown).expect_err("refused").to_string(),
        "plugin \"clock\" has no setting \"nope\""
    );
    // A value of the wrong kind is dropped back to the default, as the listing does.
    let wrong = IndexMap::from([("seconds".to_owned(), PluginSettingValue::Text("yes".into()))]);
    assert_eq!(values(t.svc.set_settings("clock", &wrong).expect("saves")), json!({ "seconds": false, "tz": "utc" }));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stored_value_is_kept_and_announced_on_the_plugins_own_topic() {
    let mut t = one("notes");
    t.svc.start().await;
    t.published().await;
    t.svc.set_store_value("notes", "list", Some(json!([{ "text": "hi" }]))).expect("stores");
    assert_eq!(t.svc.store_value("notes", "list").expect("reads"), Some(json!([{ "text": "hi" }])));
    assert_eq!(t.published().await, [("plugin:notes:store".to_owned(), json!({ "key": "list" }))]);
    assert_eq!(t.svc.store_value("notes", "other").expect("reads"), None);
    assert!(t.svc.store_value("nope", "list").is_err() && t.svc.set_store_value("nope", "k", None).is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_deleted_folder_drops_the_plugin() {
    let mut t = one("clock");
    t.svc.start().await;
    t.svc.report("clock", PluginReportRequest { rev: 1, ok: true, error: None }).expect("reports");
    t.published().await;
    t.workspace.remove("clock");
    t.workspace.change("clock");
    t.changed("clock").await;
    assert!(t.svc.list().is_empty());
    assert_eq!(t.svc.get("clock").expect_err("gone").to_string(), "plugin not found: clock");
    assert_eq!(t.svc.last_report("clock"), None, "what the windows said goes with it");
}

#[tokio::test(flavor = "multi_thread")]
async fn changes_during_a_build_rebuild_once_more_after_it() {
    let mut t = one("clock");
    t.svc.start().await;
    t.builder.clear();
    t.published().await;

    t.builder.hold();
    let first = tokio::spawn({
        let svc = t.svc.clone();
        async move { svc.refresh("clock").await }
    });
    // The build is in flight; three more changes arrive.
    while t.builder.builds().is_empty() {
        tokio::task::yield_now().await;
    }
    for _ in 0..3 {
        let svc = t.svc.clone();
        tokio::spawn(async move { svc.refresh("clock").await });
    }
    while !t.svc.is_busy("clock") {
        tokio::task::yield_now().await;
    }
    tokio::task::yield_now().await;
    t.builder.release(8);
    first.await.expect("the first run");
    t.changed("clock").await;
    t.changed("clock").await;
    assert_eq!(t.builder.builds().len(), 2, "one build in flight, one more for everything that came meanwhile");
    assert!(!t.svc.is_busy("clock"));
}

#[tokio::test(flavor = "multi_thread")]
async fn built_ins_are_listed_without_a_folder_or_build_and_switch_on_and_off() {
    let mut t = setup(&[], &[("eos.pages", "Pages")]);
    t.svc.start().await;
    let pages = t.svc.get("eos.pages").expect("listed");
    assert!(pages.builtin && !pages.has_ui);
    assert_eq!((pages.state, pages.dir.as_str()), (PluginState::Active, ""));
    assert!(t.svc.disabled_builtins().is_empty());
    assert!(t.svc.is_feature_on("eos.pages"));
    assert_eq!(t.svc.builtin_name("eos.pages"), Some("Pages"));

    t.svc.set_enabled("eos.pages", false).await.expect("switches");
    assert!(!t.svc.is_enabled("eos.pages") && !t.svc.is_feature_on("eos.pages"));
    assert_eq!(t.svc.disabled_builtins(), ["eos.pages"]);
    assert!(t.builder.builds().is_empty());
    assert_eq!(t.published().await, [("plugins:change".to_owned(), json!({ "id": "eos.pages" }))]);

    // A built-in that is not listed switches nothing: its feature is always on.
    assert!(!t.svc.is_enabled("eos.archive"));
    assert!(t.svc.is_feature_on("eos.archive"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_folder_cannot_take_a_built_ins_eos_id() {
    let t = setup(&[("eos.clock", Some(plain("eos.clock")), UI)], &[]);
    t.svc.start().await;
    assert_eq!(
        t.svc.get("eos.clock").expect("listed").error.as_deref(),
        Some("the id \"eos.clock\" is reserved for Eos's built-in plugins — rename the folder (and the manifest id)")
    );
    assert!(t.builder.builds().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_plugin_that_loses_its_ui_entry_loses_its_build() {
    let t = one("clock");
    t.svc.start().await;
    let rev = t.svc.get("clock").expect("listed").rev;
    t.workspace.put("clock", Some(&plain("clock")), &["plugin.json"]);
    t.svc.refresh("clock").await;
    let info = t.svc.get("clock").expect("listed");
    assert_eq!((info.state, info.rev, info.has_ui), (PluginState::Active, 0, false));
    assert!(t.svc.bundle("clock", rev).is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stylesheet_is_served_beside_the_module() {
    let t = one("clock");
    t.builder.with_css(".clock{}");
    t.svc.start().await;
    let info = t.svc.get("clock").expect("listed");
    assert!(info.has_css);
    assert_eq!(t.svc.bundle("clock", info.rev).and_then(|b| b.css).as_deref(), Some(&b".clock{}"[..]));
    // Built by the fake as PluginBuild { js, css }: the shape the port promises.
    let _: PluginBuild = PluginBuild { js: String::new(), css: None };
}

#[tokio::test(flavor = "multi_thread")]
async fn a_window_report_is_kept_unless_it_is_older_news() {
    let t = one("clock");
    t.svc.start().await;
    let report = |rev, ok, error: Option<&str>| PluginReportRequest { rev, ok, error: error.map(str::to_owned) };
    t.svc.report("clock", report(2, false, Some("x is not defined"))).expect("reports");
    let at = eos_core::Clock::now_ms(t.clock.as_ref());
    assert_eq!(
        serde_json::to_value(t.svc.last_report("clock")).expect("JSON"),
        json!({ "rev": 2, "ok": false, "error": "x is not defined", "at": at })
    );
    // A late "loaded" for an old build doesn't hide a newer report.
    t.svc.report("clock", report(1, true, None)).expect("reports");
    assert_eq!(t.svc.last_report("clock").map(|r| r.rev), Some(2));
    // A crash after the build loaded stays the news until a newer build loads.
    t.svc.report("clock", report(2, true, None)).expect("reports");
    assert_eq!(t.svc.last_report("clock").map(|r| r.ok), Some(false));
    t.svc.report("clock", report(3, true, None)).expect("reports");
    assert_eq!(t.svc.last_report("clock").map(|r| (r.rev, r.ok)), Some((3, true)));
    assert_eq!(t.svc.report("nope", report(1, true, None)).expect_err("unknown").to_string(), "plugin not found: nope");
}

#[tokio::test(flavor = "multi_thread")]
async fn waiting_for_a_plugin_ends_when_a_window_has_loaded_its_build() {
    let t = one("clock");
    t.svc.start().await;
    let rev = t.svc.get("clock").expect("listed").rev;

    // Nothing has loaded the build yet: the wait is still on when the report arrives.
    let waiting = tokio::spawn({
        let svc = t.svc.clone();
        async move { svc.status("clock", true).await }
    });
    tokio::task::yield_now().await;
    t.svc.report("clock", PluginReportRequest { rev, ok: true, error: None }).expect("reports");
    let status = tokio::time::timeout(Duration::from_secs(5), waiting).await.expect("in time").expect("a task");
    let status = status.expect("a status");
    assert_eq!(status.report.map(|r| r.rev), Some(rev));
    assert!(!status.busy);

    // A plugin without a UI has nothing to wait for; an unknown one is waited for, then missing.
    let t = setup(&[("bare", Some(plain("bare")), &["plugin.json"])], &[]);
    t.svc.start().await;
    assert!(t.svc.status("bare", true).await.expect("a status").report.is_none());
    assert_eq!(t.svc.status("nope", true).await.expect_err("missing").to_string(), "plugin not found: nope");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_folder_written_while_someone_waits_is_seen() {
    let t = setup(&[], &[]);
    t.svc.start().await;
    let waiting = tokio::spawn({
        let svc = t.svc.clone();
        async move { svc.status("fresh", true).await }
    });
    tokio::task::yield_now().await;
    t.workspace.put("fresh", Some(&plain("fresh")), &["plugin.json"]);
    t.workspace.change("fresh");
    let status = tokio::time::timeout(Duration::from_secs(5), waiting).await.expect("in time").expect("a task");
    assert_eq!(status.expect("found").plugin.id, "fresh");
}

#[tokio::test(flavor = "multi_thread")]
async fn after_stop_changes_no_longer_rebuild() {
    let mut t = one("clock");
    t.svc.start().await;
    t.builder.clear();
    t.published().await;
    t.svc.stop();
    t.svc.stop();
    assert!(!t.workspace.is_watched(), "the watch ended with the service");
    t.workspace.change("clock");
    // A refresh asked for directly still works, and it is the only build.
    t.svc.refresh("clock").await;
    assert_eq!(t.builder.builds().len(), 1);
    assert!(!t.svc.is_busy("clock"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_change_waiting_out_its_quiet_window_is_dropped_by_stop() {
    let workspace = Arc::new(FakePluginWorkspace::new());
    workspace.put("clock", Some(&plain("clock")), UI);
    let builder = Arc::new(FakePluginBuilder::new());
    let clock = Arc::new(FakeClock::new());
    let svc = PluginService::new(PluginServiceDeps {
        workspace: workspace.clone(),
        builder: builder.clone(),
        data: Arc::new(FakePluginDataStore::new()),
        clock: clock.clone(),
        bus: Bus::new(Ordered::new(), clock, BusOptions::default()),
        builtins: Vec::new(),
        // Long enough that the timer is still waiting when the service stops.
        options: PluginServiceOptions {
            debounce: Duration::from_secs(3600),
            settle_timeout: Duration::from_millis(50),
        },
    });
    svc.start().await;
    builder.clear();
    workspace.change("clock");
    workspace.change("clock");
    assert!(svc.is_busy("clock"), "a rebuild is waiting");
    svc.stop();
    assert!(!svc.is_busy("clock"));
    assert!(builder.builds().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_build_that_panics_fails_alone() {
    struct Panics;
    impl eos_core::plugin::PluginBuilder for Panics {
        fn build<'a>(
            &'a self,
            _: &'a std::path::Path,
            _: &'a str,
        ) -> eos_core::BoxFuture<'a, Result<PluginBuild, eos_core::Error>> {
            Box::pin(async { panic!("builder bug") })
        }
    }
    let workspace = Arc::new(FakePluginWorkspace::new());
    workspace.put("clock", Some(&plain("clock")), UI);
    let clock = Arc::new(FakeClock::new());
    let svc = PluginService::new(PluginServiceDeps {
        workspace,
        builder: Arc::new(Panics),
        data: Arc::new(FakePluginDataStore::new()),
        clock: clock.clone(),
        bus: Bus::new(Ordered::new(), clock, BusOptions::default()),
        builtins: Vec::new(),
        options: PluginServiceOptions::default(),
    });
    // The run ends for everyone who waits on it, and the plugin is free for the next one.
    tokio::time::timeout(Duration::from_secs(5), svc.refresh("clock")).await.expect("the waiter is released");
    assert!(!svc.is_busy("clock"));
    assert!(svc.get("clock").is_ok());
}
