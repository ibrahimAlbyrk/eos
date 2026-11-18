//! The capability tables: installs and versions read back as written, a
//! capability's versions newest first, and the call prune keeps the newest
//! calls.

use eos_contracts::ActionClass;
use eos_core::store::{StoredCall, StoredCapabilityVersion, StoredInstall};
use eos_domain::capability::health::{Health, HealthState, StateCode};
use eos_testkit::TempStore;

fn install(id: &str, health: Health) -> StoredInstall {
    StoredInstall {
        id: id.into(),
        origin: "forge".into(),
        active_version: Some("1.0.0".into()),
        health,
        state_since: 10,
        settings_json: r#"{"phone_number":"+905550000000"}"#.into(),
        account_label: None,
        installed_at: 10,
        updated_at: 10,
    }
}

#[test]
fn installs_read_back_as_written_and_a_put_replaces_the_row() {
    let temp = TempStore::new();
    let signed_out =
        Health { state: HealthState::NeedsSetup, code: Some(StateCode::SecretMissing("api_key".into())), failures: 2 };
    let mut github = install("github", Health::ready());
    github.origin = "builtin".into();
    github.active_version = None;
    github.account_label = Some("octocat".into());
    let mut fixed = install("sms-messages", Health::ready());
    fixed.updated_at = 20;
    let (listed, found, missing) = temp
        .store
        .write_blocking({
            let (sms, github, fixed) = (install("sms-messages", signed_out.clone()), github.clone(), fixed.clone());
            move |tx, _| {
                let installs = tx.capability_installs();
                installs.put(&sms)?;
                installs.put(&github)?;
                let found = installs.find("sms-messages")?;
                installs.put(&fixed)?;
                Ok((installs.list()?, found, installs.find("mail")?))
            }
        })
        .expect("writes");
    assert_eq!(found, Some(install("sms-messages", signed_out)), "read back as written");
    assert_eq!(listed, [github, fixed], "by id, the second put in place of the first");
    assert_eq!(missing, None);
}

fn version(capability_id: &str, name: &str, created_at: i64) -> StoredCapabilityVersion {
    StoredCapabilityVersion {
        capability_id: capability_id.into(),
        version: name.into(),
        status: "installed".into(),
        hash: "9f1a".into(),
        manifest_json: r#"{"id":"sms-messages"}"#.into(),
        source: "rn-0a1b2c3d4e5f".into(),
        tests_json: Some(r#"{"offline":{"passed":3,"total":3}}"#.into()),
        review_json: None,
        created_at,
        activated_at: Some(created_at + 1),
        retired_at: None,
    }
}

#[test]
fn a_capabilitys_versions_come_newest_first_and_each_is_kept_once() {
    let temp = TempStore::new();
    let insert =
        |row: StoredCapabilityVersion| temp.store.write_blocking(move |tx, _| tx.capability_versions().insert(&row));
    insert(version("sms-messages", "1.0.0", 10)).expect("the first");
    insert(version("sms-messages", "1.1.0", 30)).expect("a later one");
    insert(version("sms-messages", "1.0.1", 20)).expect("one made between");
    insert(version("notes-db", "2.0.0", 40)).expect("another capability's");
    assert!(insert(version("sms-messages", "1.0.0", 50)).is_err(), "the same version twice is refused");
    let (listed, found) = temp
        .store
        .read_blocking(|tx| {
            let versions = tx.capability_versions();
            Ok((versions.of_capability("sms-messages")?, versions.find("sms-messages", "1.0.1")?))
        })
        .expect("reads");
    let names: Vec<&str> = listed.iter().map(|v| v.version.as_str()).collect();
    assert_eq!(names, ["1.1.0", "1.0.1", "1.0.0"], "by when each was made, newest first");
    assert_eq!(found, Some(version("sms-messages", "1.0.1", 20)), "read back as written");
}

fn call(id: &str, capability_id: &str, started_at: i64) -> StoredCall {
    StoredCall {
        id: id.into(),
        capability_id: capability_id.into(),
        action: "send_to_me".into(),
        class: ActionClass::TellUser,
        caller_kind: "delivery".into(),
        worker_id: None,
        run_id: Some("rn-1".into()),
        version: Some("1.0.0".into()),
        started_at,
        duration_ms: 840,
        outcome: "ok".into(),
        error_kind: None,
    }
}

#[test]
fn the_call_prune_drops_old_calls_then_keeps_only_the_newest() {
    let temp = TempStore::new();
    let calls = [
        call("c-old", "sms-messages", 5),
        call("c-1", "sms-messages", 30),
        call("c-2", "github", 40),
        call("c-3", "sms-messages", 50),
        call("c-4", "github", 60),
        call("c-5", "sms-messages", 70),
    ];
    let (recent, pruned, left) = temp
        .store
        .write_blocking(move |tx, _| {
            for row in &calls {
                tx.capability_calls().insert(row)?;
            }
            let recent = tx.capability_calls().recent("sms-messages", 2)?;
            let pruned = tx.capability_calls().prune(10, 3)?;
            Ok((recent, pruned, tx.capability_calls().recent("sms-messages", 10)?))
        })
        .expect("writes");
    assert_eq!(recent, [call("c-5", "sms-messages", 70), call("c-3", "sms-messages", 50)], "newest first");
    assert_eq!(pruned, 3, "one too old, then the oldest beyond three");
    let ids: Vec<&str> = left.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids, ["c-5", "c-3"]);
    assert_eq!(temp.count("SELECT COUNT(*) FROM capability_calls"), 3, "the three newest of every capability");
    assert_eq!(temp.count("SELECT COUNT(*) FROM capability_calls WHERE id IN ('c-3', 'c-4', 'c-5')"), 3);
}
