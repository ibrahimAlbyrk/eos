//! Start, install, rollback and remove: files first, rows second, removal
//! through the trash, secrets kept.

use std::sync::Arc;

use eos_core::Error;
use eos_core::capability::{CapabilityCalls, CapabilityRegistry, CapabilitySecrets, INSTALLED_MAX};
use eos_domain::capability::health::HealthState;
use eos_testkit::{FakeActionRunner, FakeBuiltin};
use serde_json::json;

use crate::rig::{GITHUB, Setup, agent_call, notes, rig};

#[tokio::test]
async fn start_sweeps_and_gives_each_built_in_its_row_once() {
    let rig = rig(Setup { builtins: vec![Arc::new(FakeBuiltin::new(GITHUB))], ..Setup::default() }).await;
    assert_eq!(rig.files.sweeps(), 1);
    let github = rig.service.get("github").await.expect("read").expect("its row");
    assert_eq!((github.origin.as_str(), github.version.as_deref()), ("builtin", None));
    assert_eq!(github.health.state, HealthState::NeedsSetup, "no token yet");
    assert_eq!(rig.changes(), [r#"{"id":"github","state":"needs_setup","stateCode":"secret_missing:token"}"#]);

    rig.service.start().await.expect("starts again");
    assert_eq!(rig.changes().len(), 1, "a row that exists is left as it is");
}

#[tokio::test]
async fn an_install_copies_the_files_then_writes_the_rows_and_announces() {
    let rig = rig(Setup::default()).await;
    rig.install(&notes("1.0.0"), "h-1").await;

    assert!(rig.files.dir("notes-db", "1.0.0").join("capability.toml").is_file());
    let installed = rig.service.get("notes-db").await.expect("read").expect("installed");
    assert_eq!((installed.origin.as_str(), installed.version.as_deref()), ("forge", Some("1.0.0")));
    assert_eq!(installed.health.state, HealthState::Ready);
    assert_eq!(rig.changes(), [r#"{"id":"notes-db","state":"ready","version":"1.0.0"}"#]);
    let version = "SELECT COUNT(*) FROM capability_versions WHERE capability_id = 'notes-db' AND version = '1.0.0' \
                   AND status = 'installed' AND hash = 'h-1' AND source = 'rn-0a1b2c3d4e5f'";
    assert_eq!(rig.temp.count(version), 1);

    let described = rig.service.describe("w-1", Some("notes-db")).await.expect("described");
    assert_eq!(described[0].instructions.as_deref(), Some("How to use notes-db-1.0.0."));
    assert!(described[0].actions.iter().all(|action| action.input.is_some() || action.name == "check"));
}

#[tokio::test]
async fn a_package_that_fails_its_check_or_claims_a_built_in_is_refused() {
    let rig = rig(Setup::default()).await;
    let broken = notes("1.0.0").replace("class = \"read\"\nrun = [\"/bin/sh\", \"list.sh\"]", "class = \"read\"");
    let parsed = eos_domain::capability::manifest::parse(&broken).expect("reads");
    let refused = rig
        .service
        .install(eos_capabilities::Install {
            package_dir: rig.package("broken", &broken),
            manifest: parsed,
            hash: "h".into(),
            origin: "forge".into(),
            source: "rn-1".into(),
        })
        .await;
    assert!(matches!(refused, Err(Error::Validation(_))), "{refused:?}");
    assert!(!rig.files.dir("notes-db", "1.0.0").exists(), "no files before the check passes");
}

#[tokio::test]
async fn a_rollback_makes_a_kept_version_active_again() {
    let rig = rig(Setup::default()).await;
    rig.install(&notes("1.0.0"), "h-1").await;
    rig.install(&notes("1.1.0"), "h-2").await;
    assert_eq!(rig.service.get("notes-db").await.expect("read").expect("there").version.as_deref(), Some("1.1.0"));
    assert_eq!(rig.runner.stopped(), ["notes-db"], "the old version's runs stop");

    rig.clock.advance(5_000);
    rig.service.rollback("notes-db", "1.0.0").await.expect("rolls back");
    assert_eq!(rig.service.get("notes-db").await.expect("read").expect("there").version.as_deref(), Some("1.0.0"));
    assert_eq!(
        rig.changes().last().map(String::as_str),
        Some(r#"{"id":"notes-db","state":"ready","version":"1.0.0"}"#)
    );
    rig.service.call(agent_call("notes-db", "list_notes", json!({}))).await.expect("calls the older version");
    assert_eq!(rig.runner.runs()[0].version, "1.0.0");

    let missing = rig.service.rollback("notes-db", "0.9.0").await;
    assert!(matches!(missing, Err(Error::NotFound { .. })), "{missing:?}");
    rig.files.tamper("notes-db", "1.1.0", "h-edited");
    let edited = rig.service.rollback("notes-db", "1.1.0").await;
    assert!(matches!(edited, Err(Error::Rule(_))), "changed files are not made active: {edited:?}");
}

#[tokio::test]
async fn removing_trashes_every_version_drops_the_row_and_keeps_the_secrets() {
    let rig = rig(Setup { builtins: vec![Arc::new(FakeBuiltin::new(GITHUB))], ..Setup::default() }).await;
    rig.install(&notes("1.0.0"), "h-1").await;
    rig.install(&notes("1.1.0"), "h-2").await;

    rig.service.remove("notes-db").await.expect("removes");
    let trashed = rig.trash.trashed();
    assert_eq!(trashed, [rig.files.dir("notes-db", "1.1.0"), rig.files.dir("notes-db", "1.0.0")]);
    assert_eq!(rig.service.get("notes-db").await.expect("read"), None);
    assert!(rig.secrets.has("notes-db", "api_key").await.expect("read"), "the key stays for a reinstall");
    assert_eq!(rig.changes().last().map(String::as_str), Some(r#"{"id":"notes-db","state":"ready"}"#));
    assert_eq!(
        rig.service.call(agent_call("notes-db", "list_notes", json!({}))).await,
        Err(eos_core::capability::ActionError::NotFound)
    );

    let builtin = rig.service.remove("github").await;
    assert!(matches!(builtin, Err(Error::Rule(_))), "{builtin:?}");
    rig.install(&notes("1.1.0"), "h-2").await;
    assert!(rig.service.get("notes-db").await.expect("read").is_some(), "the same version installs again");
}

#[tokio::test]
async fn installs_at_once_never_pass_the_limit() {
    let rig = rig(Setup::default()).await;
    for n in 1..INSTALLED_MAX {
        rig.install(&notes("1.0.0").replace("notes-db", &format!("notes-{n}")), "h-1").await;
    }
    let last = |id: &str| {
        let manifest = notes("1.0.0").replace("notes-db", id);
        eos_capabilities::Install {
            package_dir: rig.package(id, &manifest),
            manifest: eos_domain::capability::manifest::parse(&manifest).expect("reads"),
            hash: "h-1".into(),
            origin: "forge".into(),
            source: "rn-1".into(),
        }
    };
    let (a, b) = tokio::join!(rig.service.install(last("last-a")), rig.service.install(last("last-b")));

    let refused = [&a, &b].into_iter().filter(|out| matches!(out, Err(Error::LimitExceeded(_)))).count();
    assert_eq!((a.is_ok() || b.is_ok(), refused), (true, 1), "{a:?} {b:?}");
    let count = "SELECT COUNT(*) FROM capability_installs WHERE origin != 'builtin'";
    assert_eq!(rig.temp.count(count), INSTALLED_MAX as i64);
    let refused_id = if a.is_ok() { "last-b" } else { "last-a" };
    assert!(!rig.files.dir(refused_id, "1.0.0").exists(), "the refused install's files go");
}

#[tokio::test]
async fn a_removal_announces_the_state_the_row_had_when_it_went() {
    let rig = rig(Setup { runner: FakeActionRunner::new().holding_stops(), ..Setup::default() }).await;
    rig.install(&notes("1.0.0"), "h-1").await;

    let switch_off = async {
        while rig.runner.stopped().is_empty() {
            tokio::task::yield_now().await;
        }
        rig.service.disable("notes-db").await.expect("switches off");
        rig.runner.release();
    };
    let (removed, ()) = tokio::join!(rig.service.remove("notes-db"), switch_off);
    removed.expect("removes");

    assert_eq!(rig.service.get("notes-db").await.expect("read"), None);
    assert_eq!(rig.changes().last().map(String::as_str), Some(r#"{"id":"notes-db","state":"disabled"}"#));
}
