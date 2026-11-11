//! `PluginInstaller` over in-memory ports: what
//! `core/src/__tests__/PluginInstaller.test.ts` pins.

use std::sync::Arc;
use std::time::Duration;

use eos_contracts::{PluginSource, PluginSourceGit, PluginSourceNpm, StagedPluginReplaces};
use eos_core::Clock;
use eos_core::plugin::PluginInstallStore;
use eos_mod_plugins::{PluginInstaller, PluginInstallerDeps, PluginService, PluginServiceDeps, PluginServiceOptions};
use eos_runtime::bus::{Bus, BusOptions};
use eos_runtime::ordered::Ordered;
use eos_testkit::FakeClock;
use eos_testkit::plugins::{
    FakePluginBuilder, FakePluginDataStore, FakePluginFetcher, FakePluginInstallStore, FakePluginStaging,
    FakePluginWorkspace,
};
use serde_json::json;

fn npm() -> PluginSource {
    PluginSource::Npm(PluginSourceNpm { name: "eos-clock".into(), version: Some("1.0.0".into()) })
}

struct Harness {
    installer: Arc<PluginInstaller>,
    staging: Arc<FakePluginStaging>,
    fetcher: Arc<FakePluginFetcher>,
    records: Arc<FakePluginInstallStore>,
    builder: Arc<FakePluginBuilder>,
    workspace: Arc<FakePluginWorkspace>,
    clock: Arc<FakeClock>,
}

fn harness() -> Harness {
    let workspace = Arc::new(FakePluginWorkspace::new());
    let builder = Arc::new(FakePluginBuilder::new());
    let clock = Arc::new(FakeClock::at(42));
    let plugins = PluginService::new(PluginServiceDeps {
        workspace: workspace.clone(),
        builder: builder.clone(),
        data: Arc::new(FakePluginDataStore::new()),
        clock: clock.clone(),
        bus: Bus::new(Ordered::new(), clock.clone(), BusOptions::default()),
        builtins: Vec::new(),
        options: PluginServiceOptions::default(),
    });
    let staging = Arc::new(FakePluginStaging::new());
    let fetcher = Arc::new(FakePluginFetcher::new());
    let records = Arc::new(FakePluginInstallStore::new());
    let installer = PluginInstaller::new(PluginInstallerDeps {
        fetcher: fetcher.clone(),
        staging: staging.clone(),
        records: records.clone(),
        builder: builder.clone(),
        plugins,
        clock: clock.clone(),
    });
    Harness { installer, staging, fetcher, records, builder, workspace, clock }
}

impl Harness {
    /// The staged plugin moves in: from now on its folder is there to read.
    fn folder_appears(&self) {
        self.workspace.put("clock", Some(r#"{"id":"clock","name":"Clock","version":"1.0.0"}"#), &["plugin.json"]);
    }

    async fn install(&self, source: PluginSource) {
        let staged = self.installer.stage(source).await.expect("stages");
        self.folder_appears();
        self.installer.commit(&staged.staging_id).await.expect("installs");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn stages_a_fetched_plugin_after_checking_its_manifest_and_test_building_it() {
    let h = harness();
    let staged = h.installer.stage(npm()).await.expect("stages");
    assert_eq!(staged.manifest.id.0, "clock");
    assert_eq!(staged.integrity.as_deref(), Some("sha512-abc"));
    assert_eq!(staged.resolved, "https://r/eos-clock-1.0.0.tgz");
    assert_eq!((staged.files, staged.bytes), (2, 300));
    assert_eq!(staged.replaces, None);
    assert_eq!(h.builder.builds(), [format!("/stage/{}/ui.jsx", staged.staging_id)]);
    assert!(h.staging.calls().is_empty(), "nothing moved yet");
}

#[tokio::test(flavor = "multi_thread")]
async fn installs_only_what_was_staged_records_where_it_came_from_and_reloads_it() {
    let h = harness();
    let staged = h.installer.stage(npm()).await.expect("stages");
    h.folder_appears();
    let info = h.installer.commit(&staged.staging_id).await.expect("installs");
    assert_eq!(info.id, "clock");
    assert_eq!(h.staging.calls(), [format!("promote:{}->clock", staged.staging_id)]);
    assert_eq!(
        serde_json::to_value(h.records.get("clock")).expect("JSON"),
        json!({
            "source": { "kind": "npm", "name": "eos-clock", "version": "1.0.0" },
            "resolved": "https://r/eos-clock-1.0.0.tgz",
            "integrity": "sha512-abc",
            "version": "1.0.0",
            "installedAt": h.clock.now_ms(),
        })
    );
    assert_eq!(h.installer.installs().keys().collect::<Vec<_>>(), ["clock"]);
    let again = h.installer.commit(&staged.staging_id).await.expect_err("only once");
    assert_eq!(again.to_string(), format!("staged plugin not found: {}", staged.staging_id));
    assert!(h.installer.commit("st-never").await.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_a_bad_manifest_a_reserved_id_and_a_plugin_that_does_not_build_and_drops_the_stage() {
    let h = harness();
    h.staging.staged(Some(r#"{"name":"no id"}"#));
    assert_eq!(
        h.installer.stage(npm()).await.expect_err("refused").to_string(),
        "not an Eos plugin — plugin.json: id — Required"
    );
    h.staging.staged(None);
    assert_eq!(
        h.installer.stage(npm()).await.expect_err("refused").to_string(),
        "not an Eos plugin — plugin.json is missing"
    );
    h.staging.staged(Some(r#"{"id":"eos.pages","name":"x"}"#));
    assert_eq!(
        h.installer.stage(npm()).await.expect_err("refused").to_string(),
        "the id \"eos.pages\" is reserved for Eos's built-in plugins"
    );
    assert!(h.builder.builds().is_empty(), "none of those got as far as a build");

    let h = harness();
    h.builder.fail_next("Could not resolve \"lodash\"");
    assert_eq!(
        h.installer.stage(npm()).await.expect_err("refused").to_string(),
        "the plugin doesn't build: Could not resolve \"lodash\""
    );
    assert_eq!(h.staging.calls(), ["discard:st-00000001"]);

    let h = harness();
    h.fetcher.fail(eos_core::Error::Validation("eos-clock isn't on npm".into()));
    assert_eq!(h.installer.stage(npm()).await.expect_err("refused").to_string(), "eos-clock isn't on npm");
    assert_eq!(h.staging.calls(), ["discard:st-00000001"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn says_what_a_stage_would_replace_an_installed_version_or_a_plugin_made_here() {
    let mine = harness();
    mine.staging.existing("clock");
    assert_eq!(
        mine.installer.stage(npm()).await.expect("stages").replaces,
        Some(StagedPluginReplaces { version: None, installed: false })
    );

    let h = harness();
    h.install(npm()).await;
    assert_eq!(
        h.installer.stage(npm()).await.expect("stages").replaces,
        Some(StagedPluginReplaces { version: Some("1.0.0".into()), installed: true })
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn updates_from_the_same_tag_and_moves_a_pinned_npm_version_to_latest() {
    let h = harness();
    h.install(npm()).await;
    h.installer.stage_update("clock").await.expect("stages");
    assert_eq!(
        h.fetcher.fetched().last(),
        Some(&PluginSource::Npm(PluginSourceNpm { name: "eos-clock".into(), version: None }))
    );

    // A tag is followed as it is.
    let tagged = harness();
    let beta = PluginSource::Npm(PluginSourceNpm { name: "eos-clock".into(), version: Some("beta".into()) });
    tagged.install(beta.clone()).await;
    tagged.installer.stage_update("clock").await.expect("stages");
    assert_eq!(tagged.fetcher.fetched().last(), Some(&beta));

    let g = harness();
    let git =
        PluginSource::Git(PluginSourceGit { url: "https://example.com/clock.git".into(), r#ref: Some("main".into()) });
    g.install(git.clone()).await;
    g.installer.stage_update("clock").await.expect("stages");
    assert_eq!(g.fetcher.fetched().last(), Some(&git));

    let made_here = harness();
    made_here.staging.existing("clock");
    assert_eq!(
        made_here.installer.stage_update("clock").await.expect_err("nothing to update from").to_string(),
        "\"clock\" wasn't installed from npm, git or a folder — there's nothing to update it from"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn removes_a_plugin_to_the_trash_and_forgets_where_it_came_from() {
    let h = harness();
    h.install(npm()).await;
    h.workspace.remove("clock");
    h.installer.remove("clock").await.expect("removes");
    assert_eq!(h.records.get("clock"), None);
    assert_eq!(h.staging.calls().last().map(String::as_str), Some("trash:clock"));
    assert_eq!(h.installer.remove("clock").await.expect_err("gone").to_string(), "plugin not found: clock");
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_only_the_newest_few_stages_waiting_for_review() {
    let h = harness();
    let mut stages = Vec::new();
    for _ in 0..5 {
        stages.push(h.installer.stage(npm()).await.expect("stages").staging_id);
    }
    assert_eq!(h.staging.calls(), [format!("discard:{}", stages[0])]);
    assert!(h.installer.commit(&stages[0]).await.is_err(), "the oldest was dropped");
    h.installer.discard(&stages[1]).await;
    assert!(h.installer.commit(&stages[1]).await.is_err(), "a discarded stage cannot be installed");
    h.folder_appears();
    assert!(h.installer.commit(&stages[4]).await.is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stage_finishes_even_when_the_caller_stops_waiting() {
    let h = harness();
    h.builder.hold();
    let staging = h.installer.stage(npm());
    // The caller goes away while the test build is still running.
    assert!(tokio::time::timeout(Duration::from_millis(20), staging).await.is_err());
    h.builder.release(2);
    // The stage is kept for review all the same: the next one is the second.
    let next = h.installer.stage(npm()).await.expect("stages");
    assert_eq!(next.staging_id, "st-00000002");
    h.folder_appears();
    assert!(h.installer.commit("st-00000001").await.is_ok(), "the abandoned stage was completed, not left half-made");
}

#[tokio::test(flavor = "multi_thread")]
async fn stages_left_from_before_are_cleared_at_start() {
    let h = harness();
    h.installer.start().await;
    assert_eq!(h.staging.calls(), ["clear"]);
}
