//! The Forge's own tests of a package in its build folder: the offline
//! tests under the audit with planted secrets, what the audit lets pass and
//! what fails it, and the live call the user starts.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use eos_capability_host::{Trial, judge};
use eos_core::capability::{ActionError, ConfineReport, Violation};
use eos_domain::capability::manifest::{Manifest, parse};
use eos_testkit::{FakeConfinement, SeqIds};
use serde_json::json;

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/capabilities").join(name)
}

fn manifest_of(dir: &Path) -> Manifest {
    parse(&std::fs::read_to_string(dir.join("capability.toml")).expect("read")).expect("a manifest")
}

fn trial(confinement: Arc<FakeConfinement>) -> Trial {
    let trees = eos_kit_proc::ProcessTrees::new(eos_platform::isolate_command, |pid| {
        eos_platform::kill_process_tree(pid).is_ok()
    });
    Trial::new(confinement, eos_kit_proc::Runner::new(trees), Arc::new(SeqIds::new()))
}

/// The echo package with `tests` as its offline tests, in a build folder.
fn echo_with_tests(home: &Path, tests: &str) -> PathBuf {
    let dir = home.join("package");
    std::fs::create_dir_all(dir.join("tests")).expect("made");
    std::fs::copy(fixture("echo-script").join("echo.sh"), dir.join("echo.sh")).expect("copied");
    let manifest = std::fs::read_to_string(fixture("echo-script").join("capability.toml")).expect("read");
    let manifest = manifest.replace("reach = {", "tests = { command = [\"/bin/sh\", \"tests/run.sh\"] }\nreach = {");
    std::fs::write(dir.join("capability.toml"), manifest).expect("written");
    std::fs::write(dir.join("tests/run.sh"), tests).expect("written");
    dir
}

#[tokio::test]
async fn the_sms_package_passes_its_offline_tests_under_the_audit() {
    let home = tempfile::tempdir().expect("a folder");
    let confinement = Arc::new(FakeConfinement::new());
    let package = fixture("sms-messages");
    let outcome = trial(confinement.clone()).offline(&package, &manifest_of(&package), home.path()).await;
    assert!(outcome.passed, "{:?}", outcome.failures);
    let spec = &confinement.specs()[0];
    assert!(spec.audit, "the offline tests run under the audit");
    assert_eq!((spec.cwd.as_path(), spec.package.as_path()), (package.as_path(), package.as_path()));
    assert!(spec.data.starts_with(home.path()) && spec.tmpdir.starts_with(home.path()));
    assert_eq!(std::fs::read_dir(home.path()).expect("listed").count(), 0, "its folders go after");
}

#[tokio::test]
async fn a_planted_secret_in_what_the_tests_print_or_write_fails_them() {
    for tests in ["printf %s \"$ECHO_TOKEN\" | base64\n", "echo \"$ECHO_TOKEN\" > \"$HOME/kept\"\n"] {
        let home = tempfile::tempdir().expect("a folder");
        let package = echo_with_tests(home.path(), tests);
        let confinement = Arc::new(FakeConfinement::new());
        let outcome =
            trial(confinement.clone()).offline(&package, &manifest_of(&package), &home.path().join("w")).await;
        assert!(!outcome.passed, "{tests}");
        assert_eq!(outcome.failures.len(), 1, "{:?}", outcome.failures);
        assert!(outcome.failures[0].contains("planted secret"));
        let planted = confinement.specs()[0].env.iter().find(|(name, _)| name == "ECHO_TOKEN").map(|(_, v)| v.clone());
        assert!(planted.is_some_and(|value| value.starts_with("eos-planted-")), "a fake, never a real secret");
    }
    let home = tempfile::tempdir().expect("a folder");
    let package = echo_with_tests(home.path(), "exit 3\n");
    let outcome = trial(Arc::new(FakeConfinement::new())).offline(&package, &manifest_of(&package), home.path()).await;
    assert_eq!(outcome.failures, ["its tests failed"]);
}

#[test]
fn the_audit_lets_only_system_preference_reads_and_declared_hosts_pass() {
    let mut manifest = manifest_of(&fixture("echo-script"));
    manifest.reach.hosts = vec!["api.example.com".into()];
    let report = |violations: Vec<Violation>| ConfineReport { violations, more: 0, watched: true };
    let read = |path: &str| Violation::FileRead { path: path.into() };
    let net = |target: &str| Violation::Network { target: target.into() };
    let clean = report(vec![
        read("/Library/Preferences/com.apple.networkd.plist"),
        read("/Users/someone/Library/Preferences/.GlobalPreferences.plist"),
        net("api.example.com:443"),
    ]);
    assert_eq!(judge(&clean, &manifest), (Vec::new(), 2));

    let cases = [
        (read("/Users/someone/.ssh/id_ed25519"), "it read files outside its package"),
        (read("/Library/Preferences/../Keychains/x"), "it read files outside its package"),
        (Violation::FileWrite { path: "/tmp/x".into() }, "it wrote outside its data and temp folders"),
        (Violation::Exec { path: "/usr/bin/security".into() }, "it started a program it may not"),
        (Violation::Mach { service: "com.apple.securityd".into() }, "it asked a system service it may not"),
        (Violation::AppleEvent { bundle_id: "com.apple.MobileSMS".into() }, "its offline tests asked another app"),
        (net("other.example.com:443"), "it reached a host its manifest does not declare"),
        (net("remote:*:443"), "it reached the network around Eos's proxy"),
    ];
    for (violation, why) in cases {
        assert_eq!(judge(&report(vec![violation]), &manifest).0, [why]);
    }
    let unwatched = ConfineReport { violations: Vec::new(), more: 0, watched: false };
    assert_eq!(judge(&unwatched, &manifest).0.len(), 1, "an audit that read no denials proves nothing");
    let cut = ConfineReport { violations: Vec::new(), more: 3, watched: true };
    assert_eq!(judge(&cut, &manifest).0.len(), 1);
}

#[tokio::test]
async fn a_violation_fails_the_tests_and_the_live_call_runs_only_a_declared_telling_action() {
    let home = tempfile::tempdir().expect("a folder");
    let package = echo_with_tests(home.path(), "exit 0\n");
    let manifest = manifest_of(&package);
    let violating = Arc::new(FakeConfinement::new().violating(vec![Violation::FileRead { path: "/etc/hosts".into() }]));
    let outcome = trial(violating).offline(&package, &manifest, home.path()).await;
    assert_eq!(outcome.failures, ["it read files outside its package"]);

    let refused =
        trial(Arc::new(FakeConfinement::new())).live(&package, &manifest, json!({}), Vec::new(), home.path()).await;
    assert_eq!(refused, Err(ActionError::NotFound), "no live test declared");

    let mut live = manifest.clone();
    live.tests.as_mut().expect("tests").live = Some("echo".into());
    let confinement = Arc::new(FakeConfinement::new());
    let answer = trial(confinement.clone()).live(&package, &live, json!({"text": "hi"}), Vec::new(), home.path()).await;
    assert_eq!(answer.expect("answers")["input"]["text"], "hi");
    assert!(!confinement.specs()[0].audit, "the live call has the reach it declares");

    live.actions[0].class = eos_contracts::ActionClass::Speak;
    let speaks =
        trial(Arc::new(FakeConfinement::new())).live(&package, &live, json!({}), Vec::new(), home.path()).await;
    assert!(matches!(speaks, Err(ActionError::Invalid(_))), "{speaks:?}");
}
