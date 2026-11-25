//! The Forge's own stations end to end, with the routines' part played by
//! the test: the builder's echo package is tested under the sandbox,
//! reviewed, proposed in Needs you, installed only on the user's yes from
//! this computer's dashboard, and rolled back when its health fails.

use eos_core::capability::{ActionError, CapabilityRegistry, CapabilitySecrets, FailureKind};
use eos_core::forge::ForgeStage;
use eos_core::routine::StepResult;
use eos_mod_forge::{PROPOSE_STEP, TEST_STEP};
use eos_runtime::access::{Caller, Tier};
use eos_runtime::http::Method;
use eos_testkit::FakeActionRunner;
use serde_json::{Value, json};

use crate::rig::Rig;

const ECHO: &str = "../../fixtures/capabilities/echo-script";

/// The echo package at `version` in `run`'s build folder, with offline
/// tests that pass and `extra` lines in its manifest.
fn package(rig: &Rig, run: &str, version: &str, extra: &str) {
    let dir = rig.folder(run).join("package");
    std::fs::create_dir_all(dir.join("tests")).expect("made");
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(ECHO);
    std::fs::copy(fixture.join("echo.sh"), dir.join("echo.sh")).expect("copied");
    let manifest = std::fs::read_to_string(fixture.join("capability.toml")).expect("read");
    let manifest = manifest.replace("version = \"1.0.0\"", &format!("version = \"{version}\"")).replace(
        "reach = {",
        &format!("{extra}tests = {{ command = [\"/bin/sh\", \"tests/run.sh\"]{} }}\nreach = {{", live_of(extra)),
    );
    std::fs::write(dir.join("capability.toml"), manifest).expect("written");
    std::fs::write(dir.join("tests/run.sh"), "exit 0\n").expect("written");
}

/// `extra` asks for a live test with the word `live`.
fn live_of(extra: &str) -> &'static str {
    if extra.contains("#live") { ", live = \"echo\"" } else { "" }
}

/// The builder's report, Eos's tests, the reviewer's pass and the proposal.
async fn through_review(rig: &Rig, run: &str, version: &str) -> StepResult {
    through_review_of(rig, run, version, None).await
}

/// `through_review` of a run that repairs `repair`, when one is named.
async fn through_review_of(rig: &Rig, run: &str, version: &str, repair: Option<&str>) -> StepResult {
    let (builder, reviewer) = (format!("w-build-{run}"), format!("w-review-{run}"));
    rig.session_of(run, &builder, "forge-builder");
    rig.session_of(run, &reviewer, "forge-reviewer");
    let build = json!({"package": "package", "capabilityId": "echo-script", "version": version, "summary": "Echo."});
    rig.forge.report(&builder, ForgeStage::Build, build).await.expect("built");
    let tested = rig.step(run, TEST_STEP).await;
    assert!(matches!(tested, StepResult::Done(_)), "{tested:?}");
    rig.forge.report(&reviewer, ForgeStage::Review, json!({"verdict": "pass", "findings": []})).await.expect("passed");
    rig.step_of(run, PROPOSE_STEP, repair).await
}

async fn answer(rig: &Rig, run: &str, choice: &str) -> (u16, Value) {
    let body = json!({"choice": choice}).to_string();
    rig.ask(Method::Post, &format!("/api/forge/proposals/{run}/answer"), Some(&body)).await
}

fn status_of(rig: &Rig, version: &str) -> String {
    let rows = rig.temp.count(&format!(
        "SELECT COUNT(*) FROM capability_versions WHERE version = '{version}' AND status = 'installed'"
    ));
    if rows == 1 { "installed".into() } else { "other".into() }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_tested_and_reviewed_package_is_proposed_and_installed_only_on_the_dashboards_yes() {
    let rig = Rig::ready().await;
    package(&rig, "rn-1", "1.0.0", "");
    let proposed = through_review(&rig, "rn-1", "1.0.0").await;
    assert!(matches!(proposed, StepResult::Done(_)), "{proposed:?}");
    assert!(rig.confinement.specs().iter().all(|spec| spec.audit), "Eos's tests ran under the audit");

    let (status, state) = rig.ask(Method::Get, "/api/forge/proposals/rn-1", None).await;
    assert_eq!((status, state["state"].as_str()), (200, Some("open")), "{state}");
    let proposal = &state["proposal"];
    assert_eq!((proposal["capabilityId"].as_str(), proposal["version"].as_str()), (Some("echo-script"), Some("1.0.0")));
    assert_eq!(proposal["actions"][0], json!({"name": "echo", "summary": "Answer the input back.", "class": "read"}));
    assert_eq!(proposal["secrets"][0]["name"], "token");
    assert!(proposal["limits"].as_array().is_some_and(|limits| !limits.is_empty()), "what is not guaranteed is said");
    let proposed_rows = "SELECT COUNT(*) FROM capability_versions WHERE status = 'proposed'";
    assert_eq!(rig.temp.count(proposed_rows), 1);
    assert!(rig.service.get("echo-script").await.expect("read").is_none(), "nothing installs before the yes");

    let body = json!({"choice": "install"}).to_string();
    for caller in
        [Caller::Phone { grant: Tier::Low, mutate: true }, Caller::Peer { device: "AB:CD".into(), human: true }]
    {
        let (status, _) = rig.ask_as(caller, Method::Post, "/api/forge/proposals/rn-1/answer", Some(&body)).await;
        assert_ne!(status, 200, "only this computer's dashboard installs");
    }
    assert!(rig.service.get("echo-script").await.expect("read").is_none());

    let (status, state) = answer(&rig, "rn-1", "install").await;
    assert_eq!((status, state["state"].as_str()), (200, Some("answered")), "{state}");
    let installed = rig.service.get("echo-script").await.expect("read").expect("installed");
    assert_eq!((installed.origin.as_str(), installed.version.as_deref()), ("forge", Some("1.0.0")));
    assert_eq!(status_of(&rig, "1.0.0"), "installed");
    assert_ne!(answer(&rig, "rn-1", "install").await.0, 200, "a proposal is answered once");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_package_that_changed_after_its_review_or_its_proposal_is_never_installed() {
    let rig = Rig::ready().await;
    package(&rig, "rn-1", "1.0.0", "");
    let echo = rig.folder("rn-1").join("package/echo.sh");
    let (builder, reviewer) = ("w-build", "w-review");
    rig.session(builder, "forge-builder");
    rig.session(reviewer, "forge-reviewer");
    let build = json!({"package": "package", "capabilityId": "echo-script", "version": "1.0.0", "summary": "Echo."});
    rig.forge.report(builder, ForgeStage::Build, build).await.expect("built");
    assert!(matches!(rig.step("rn-1", TEST_STEP).await, StepResult::Done(_)));
    rig.forge.report(reviewer, ForgeStage::Review, json!({"verdict": "pass"})).await.expect("passed");
    std::fs::write(&echo, "#!/bin/sh\ncurl https://example.com\n").expect("edited");
    let refused = rig.step("rn-1", PROPOSE_STEP).await;
    assert!(
        matches!(&refused, StepResult::Failed { reason } if reason.contains("changed after its review")),
        "{refused:?}"
    );

    rig.forge.report(reviewer, ForgeStage::Review, json!({"verdict": "pass"})).await.expect("passed again");
    assert!(matches!(rig.step("rn-1", PROPOSE_STEP).await, StepResult::Done(_)), "reviewed files are tested again");
    std::fs::write(&echo, "#!/bin/sh\necho changed\n").expect("edited");
    let (status, _) = answer(&rig, "rn-1", "install").await;
    assert_eq!(status, 409);
    assert!(rig.service.get("echo-script").await.expect("read").is_none(), "nothing installed");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failing_test_fails_the_station_and_a_declined_proposal_is_rejected_with_its_secrets() {
    let rig = Rig::ready().await;
    package(&rig, "rn-1", "1.0.0", "");
    std::fs::write(rig.folder("rn-1").join("package/tests/run.sh"), "exit 1\n").expect("written");
    rig.session("w-build", "forge-builder");
    let build = json!({"package": "package", "capabilityId": "echo-script", "version": "1.0.0", "summary": "Echo."});
    rig.forge.report("w-build", ForgeStage::Build, build).await.expect("built");
    let failed = rig.step("rn-1", TEST_STEP).await;
    assert!(matches!(&failed, StepResult::Failed { reason } if reason.contains("its tests failed")), "{failed:?}");

    package(&rig, "rn-3", "1.0.0", "");
    assert!(matches!(through_review(&rig, "rn-3", "1.0.0").await, StepResult::Done(_)));
    rig.secrets.write("echo-script", "token", "tok_typed_for_it_9".to_owned().into()).await.expect("kept");
    let (status, state) = answer(&rig, "rn-3", "decline").await;
    assert_eq!((status, state["state"].as_str()), (200, Some("answered")));
    assert_eq!(rig.temp.count("SELECT COUNT(*) FROM capability_versions WHERE status = 'rejected'"), 1);
    assert!(!rig.secrets.has("echo-script", "token").await.expect("read"), "its secret goes with it");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_live_test_runs_only_when_the_user_starts_it_and_install_waits_for_their_word() {
    let rig = Rig::ready().await;
    package(&rig, "rn-1", "1.0.0", "#live\n");
    assert!(matches!(through_review(&rig, "rn-1", "1.0.0").await, StepResult::Done(_)));
    let audits = rig.confinement.specs().len();
    assert_eq!(answer(&rig, "rn-1", "install").await.0, 409, "not before the live test");
    assert_eq!(answer(&rig, "rn-1", "alerted").await.0, 409, "no word on a test not sent");

    rig.prompt.answer(Some("tok_typed_in_prompt_3"));
    let (status, live) = rig.ask(Method::Post, "/api/forge/proposals/rn-1/live-test", Some("{}")).await;
    assert_eq!((status, live["state"].as_str()), (200, Some("sent")), "{live}");
    let spec = &rig.confinement.specs()[audits];
    assert!(!spec.audit, "the live call has the reach it declares");
    assert_eq!(rig.prompt.asked().len(), 1, "its secret was asked in the app's prompt");
    assert!(rig.secrets.has("echo-script", "token").await.expect("read"));
    assert!(!live.to_string().contains("tok_typed"), "no secret on the wire");

    assert_eq!(answer(&rig, "rn-1", "not_alerted").await.0, 200);
    assert_eq!(answer(&rig, "rn-1", "install").await.0, 409, "not while it did not reach the user");
    assert_eq!(answer(&rig, "rn-1", "alerted").await.0, 200);
    let (status, state) = answer(&rig, "rn-1", "install").await;
    assert_eq!((status, state["proposal"]["liveTest"]["state"].as_str()), (200, Some("alerted")), "{state}");
    assert_eq!(status_of(&rig, "1.0.0"), "installed");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_version_whose_health_fails_goes_back_to_the_one_before_and_the_user_is_told() {
    let failing = Err(ActionError::Failed { kind: FailureKind::Code });
    let rig = Rig::with_runner(FakeActionRunner::new().answering("echo-script", "echo", failing)).await;
    package(&rig, "rn-1", "1.0.0", "");
    assert!(matches!(through_review(&rig, "rn-1", "1.0.0").await, StepResult::Done(_)));
    assert_eq!(answer(&rig, "rn-1", "install").await.0, 200);
    rig.secrets.write("echo-script", "token", "tok_for_the_check_4".to_owned().into()).await.expect("kept");

    package(&rig, "rn-2", "1.1.0", "health = { action = \"echo\" }\n");
    assert!(matches!(through_review_of(&rig, "rn-2", "1.1.0", Some("echo-script")).await, StepResult::Done(_)));
    assert_eq!(answer(&rig, "rn-2", "install").await.0, 200);
    let after = rig.service.get("echo-script").await.expect("read").expect("there");
    assert_eq!(after.version.as_deref(), Some("1.0.0"), "back to the version before");
    let notice = "SELECT COUNT(*) FROM inbox_items WHERE kind = 'notice' AND producer = 'forge' \
                  AND title LIKE '%went back to version 1.0.0'";
    assert_eq!(rig.temp.count(notice), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_package_takes_an_installed_capabilitys_id_only_as_its_repair_and_never_its_stored_secret_before_install() {
    let rig = Rig::ready().await;
    package(&rig, "rn-1", "1.0.0", "");
    assert!(matches!(through_review(&rig, "rn-1", "1.0.0").await, StepResult::Done(_)));
    assert_eq!(answer(&rig, "rn-1", "install").await.0, 200);
    rig.secrets.write("echo-script", "token", "tok_installed_one_1".to_owned().into()).await.expect("kept");

    package(&rig, "rn-2", "2.0.0", "#live\n");
    let manifest = rig.folder("rn-2").join("package/capability.toml");
    let text = std::fs::read_to_string(&manifest).expect("read").replace("hosts = []", "hosts = [\"api.example.com\"]");
    std::fs::write(&manifest, text).expect("written");
    let refused = through_review(&rig, "rn-2", "2.0.0").await;
    assert!(
        matches!(&refused, StepResult::Failed { reason } if reason.contains("a capability you have already")),
        "{refused:?}"
    );
    let proposed = rig.step_of("rn-2", PROPOSE_STEP, Some("echo-script")).await;
    assert!(matches!(proposed, StepResult::Done(_)), "{proposed:?}");
    let (_, state) = rig.ask(Method::Get, "/api/forge/proposals/rn-2", None).await;
    assert_eq!(state["proposal"]["replaces"], json!({"version": "1.0.0", "widens": ["Reaches api.example.com"]}));

    let audits = rig.confinement.specs().len();
    rig.prompt.answer(Some("tok_typed_for_two_2"));
    let (status, _) = rig.ask(Method::Post, "/api/forge/proposals/rn-2/live-test", Some("{}")).await;
    assert_eq!(status, 200);
    assert_eq!(rig.prompt.asked().len(), 1, "a repair asks its secret again");
    let env = &rig.confinement.specs()[audits].env;
    assert!(env.iter().any(|(_, value)| value == "tok_typed_for_two_2"), "the live call has the typed secret");
    assert!(!env.iter().any(|(_, value)| value.contains("tok_installed")), "never the installed version's");
    let kept = rig.secrets.read("echo-script", "token").await.expect("read").expect("kept");
    assert_eq!(kept.as_str(), "tok_installed_one_1", "nothing overwritten before Install");
}

/// A way that runs Acme's published server, pinned.
fn published_way() -> Value {
    json!({"options": [{
        "key": "acme", "title": "Acme's server", "how": "Acme's own MCP server.", "cost": "free",
        "setup": "An Acme account", "works": "any_mac", "reach": ["api.acme.com"], "source": "community",
        "package": {"registry": "npm", "name": "acme-echo", "version": "2.1.0",
                    "integrity": format!("sha512-{}==", "A".repeat(86)), "server": "io.github.acme/echo"},
    }]})
}

/// The package's lock file, installing acme-echo `version`.
fn lock(rig: &Rig, run: &str, version: &str) {
    let dir = rig.folder(run).join("package");
    let integrity = format!("sha512-{}==", "A".repeat(86));
    let entry = json!({"version": version, "resolved": "https://registry.npmjs.org/acme-echo/-/acme-echo.tgz",
                       "integrity": integrity, "hasInstallScript": true});
    let lock = json!({"lockfileVersion": 3, "packages": {"": {}, "node_modules/acme-echo": entry}});
    std::fs::write(dir.join("package-lock.json"), lock.to_string()).expect("lock");
    std::fs::create_dir_all(dir.join("node_modules/acme-echo")).expect("made");
    let installed = json!({"version": version}).to_string();
    std::fs::write(dir.join("node_modules/acme-echo/package.json"), installed).expect("installed");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_published_server_is_tested_only_once_it_holds_to_its_pin_and_its_proposal_names_it() {
    let rig = Rig::ready().await;
    rig.session_of("rn-1", "w-research", "forge-researcher");
    rig.forge.report("w-research", ForgeStage::Research, published_way()).await.expect("researched");
    package(&rig, "rn-1", "1.0.0", "");
    lock(&rig, "rn-1", "2.0.9");
    rig.session_of("rn-1", "w-build-first", "forge-builder");
    let build = json!({"package": "package", "capabilityId": "echo-script", "version": "1.0.0", "summary": "Echo."});
    rig.forge.report("w-build-first", ForgeStage::Build, build).await.expect("built");
    let StepResult::Failed { reason } = rig.step("rn-1", TEST_STEP).await else { panic!("another version passed") };
    assert!(reason.contains("does not hold to its pin"), "{reason}");
    assert!(rig.confinement.specs().is_empty(), "nothing of it ran");

    lock(&rig, "rn-1", "2.1.0");
    let proposed = through_review(&rig, "rn-1", "1.0.0").await;
    assert!(matches!(proposed, StepResult::Done(_)), "{proposed:?}");
    let (_, state) = rig.ask(Method::Get, "/api/forge/proposals/rn-1", None).await;
    let source = &state["proposal"]["source"];
    assert_eq!(source["community"], true);
    assert_eq!(source["dependencies"], json!(["acme-echo@2.1.0"]));
    assert_eq!(source["installScripts"], json!(["acme-echo@2.1.0"]));
    let limits = state["proposal"]["limits"].to_string();
    assert!(limits.contains("not its publisher") && limits.contains("install scripts"), "{limits}");
    let pinned = format!(
        "SELECT COUNT(*) FROM capability_versions WHERE source = 'npm:acme-echo@2.1.0#sha512-{}=='",
        "A".repeat(86)
    );
    assert_eq!(rig.temp.count(&pinned), 1, "the version names its pin as its source");
}
