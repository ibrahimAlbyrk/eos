//! What `core/src/__tests__/sync-engine.test.ts` pins, plus the cases the
//! Rust engine adds (a failed conflict save, a stopped engine, paging).

#![allow(clippy::unwrap_used)]

mod support;

use eos_sync::PassResult;
use eos_testkit::vault::{VaultFault, VaultOp};
use serde_json::json;
use support::{Mac, VAULT, vault};

fn result(pulled: u64, pushed: u64, conflicts: u64) -> PassResult {
    PassResult { pulled, pushed, conflicts }
}

#[tokio::test]
async fn carries_a_new_record_from_one_computer_to_the_other() {
    let vault = vault();
    let (a, b) = (Mac::new(&vault, "air"), Mac::new(&vault, "pro"));
    a.domain.set("um-1", json!({ "text": "pnpm" }), Some(5.0));
    assert_eq!(a.engine.sync().await.unwrap(), result(0, 1, 0));
    assert_eq!(a.engine.position(), 1, "its own write is not something to come back for");
    assert_eq!(b.engine.sync().await.unwrap(), result(1, 0, 0));
    assert_eq!(b.domain.data("um-1"), Some(json!({ "text": "pnpm" })));
    assert_eq!(b.engine.counts().get("memory"), Some(&1));
    assert_eq!(b.engine.position(), 1);
}

#[tokio::test]
async fn the_envelope_is_todays() {
    let vault = vault();
    let a = Mac::new(&vault, "air");
    a.domain.set("um-1", json!({ "text": "pnpm" }), Some(5.0));
    a.domain.set("um-2", json!("plain"), None);
    a.engine.sync().await.unwrap();
    a.domain.delete("um-2");
    a.engine.sync().await.unwrap();
    let records: Vec<String> =
        vault.records(VAULT).into_iter().map(|entry| String::from_utf8(entry.data).unwrap()).collect();
    assert_eq!(
        records,
        [
            r#"{"v":1,"domain":"memory","id":"um-1","changedAt":5,"device":"air","data":{"text":"pnpm"}}"#,
            r#"{"v":1,"domain":"memory","id":"um-2","changedAt":1000,"device":"air","deleted":true}"#,
        ]
    );
}

#[tokio::test]
async fn does_not_push_back_what_it_just_applied() {
    let vault = vault();
    let (a, b) = (Mac::new(&vault, "air"), Mac::new(&vault, "pro"));
    a.domain.set("um-1", json!({ "text": "x" }), None);
    a.engine.sync().await.unwrap();
    b.engine.sync().await.unwrap();
    let head = vault.changes(VAULT, 0, 10).head;
    assert_eq!(b.engine.sync().await.unwrap(), result(0, 0, 0));
    assert_eq!(a.engine.sync().await.unwrap(), result(0, 0, 0));
    assert_eq!(vault.changes(VAULT, 0, 10).head, head);
}

#[tokio::test]
async fn propagates_edits_and_deletes() {
    let vault = vault();
    let (a, b) = (Mac::new(&vault, "air"), Mac::new(&vault, "pro"));
    a.domain.set("um-1", json!({ "text": "v1" }), None);
    a.engine.sync().await.unwrap();
    b.engine.sync().await.unwrap();
    b.domain.set("um-1", json!({ "text": "v2" }), None);
    b.engine.sync().await.unwrap();
    a.engine.sync().await.unwrap();
    assert_eq!(a.domain.data("um-1"), Some(json!({ "text": "v2" })));
    a.domain.delete("um-1");
    a.engine.sync().await.unwrap();
    b.engine.sync().await.unwrap();
    assert!(!b.domain.has("um-1"));
    assert_eq!(b.engine.counts().get("memory"), Some(&0));
}

#[tokio::test]
async fn a_computer_that_was_off_catches_up_from_the_vault_alone() {
    let vault = vault();
    let a = Mac::new(&vault, "air");
    for id in ["um-1", "um-2", "um-3"] {
        a.domain.set(id, json!({ "id": id }), None);
        a.engine.sync().await.unwrap();
    }
    a.domain.delete("um-2");
    a.engine.sync().await.unwrap();
    let b = Mac::new(&vault, "pro");
    // One record a page: the pass reads on until the vault says there is no more.
    b.client.set_page_limit(1);
    b.engine.sync().await.unwrap();
    assert_eq!(b.domain.ids(), ["um-1", "um-3"]);
}

#[tokio::test]
async fn on_a_concurrent_edit_the_newer_one_wins_and_the_other_is_kept_as_a_conflict() {
    let vault = vault();
    let (a, b) = (Mac::new(&vault, "air"), Mac::new(&vault, "pro"));
    a.domain.set("um-1", json!({ "text": "base" }), Some(10.0));
    a.engine.sync().await.unwrap();
    b.engine.sync().await.unwrap();
    a.domain.set("um-1", json!({ "text": "air edit", "at": 20 }), Some(20.0));
    b.domain.set("um-1", json!({ "text": "pro edit", "at": 30 }), Some(30.0));
    a.engine.sync().await.unwrap();
    let r = b.engine.sync().await.unwrap();
    assert_eq!(r.conflicts, 1);
    assert_eq!(b.domain.data("um-1"), Some(json!({ "text": "pro edit", "at": 30 })));
    assert_eq!(b.conflicts(), [("um-1".to_owned(), json!({ "text": "air edit", "at": 20 }))]);
    a.engine.sync().await.unwrap();
    assert_eq!(a.domain.data("um-1"), Some(json!({ "text": "pro edit", "at": 30 })));
}

#[tokio::test]
async fn an_older_local_edit_loses_to_the_vaults_newer_one() {
    let vault = vault();
    let (a, b) = (Mac::new(&vault, "air"), Mac::new(&vault, "pro"));
    a.domain.set("um-1", json!({ "text": "base" }), Some(10.0));
    a.engine.sync().await.unwrap();
    b.engine.sync().await.unwrap();
    b.domain.set("um-1", json!({ "text": "pro edit", "at": 20 }), Some(20.0));
    a.domain.set("um-1", json!({ "text": "air edit", "at": 30 }), Some(30.0));
    a.engine.sync().await.unwrap();
    b.engine.sync().await.unwrap();
    assert_eq!(b.domain.data("um-1"), Some(json!({ "text": "air edit", "at": 30 })));
    assert_eq!(b.conflicts(), [("um-1".to_owned(), json!({ "text": "pro edit", "at": 20 }))]);
}

#[tokio::test]
async fn joining_adopts_the_accounts_copy_and_keeps_this_computers_aside() {
    let vault = vault();
    let a = Mac::new(&vault, "air");
    a.domain.set("style", json!("terse"), Some(1.0));
    a.engine.sync().await.unwrap();
    let b = Mac::new(&vault, "pro");
    b.domain.set("style", json!("thorough"), Some(999.0));
    b.domain.set("um-9", json!({ "text": "only on pro" }), None);
    b.engine.sync().await.unwrap();
    assert_eq!(b.domain.data("style"), Some(json!("terse")));
    assert_eq!(b.conflicts(), [("style".to_owned(), json!("thorough"))]);
    a.engine.sync().await.unwrap();
    assert_eq!(a.domain.data("um-9"), Some(json!({ "text": "only on pro" })));
}

#[tokio::test]
async fn identical_content_on_both_sides_is_not_a_conflict() {
    let vault = vault();
    let a = Mac::new(&vault, "air");
    a.domain.set("style", json!("terse"), None);
    a.engine.sync().await.unwrap();
    let b = Mac::new(&vault, "pro");
    b.domain.set("style", json!("terse"), None);
    assert_eq!(b.engine.sync().await.unwrap(), result(0, 0, 0));
    assert!(b.conflicts().is_empty());
}

#[tokio::test]
async fn a_record_its_domain_refuses_is_kept_as_a_conflict_not_retried_forever() {
    use std::sync::atomic::Ordering;

    let vault = vault();
    let (a, b) = (Mac::new(&vault, "air"), Mac::new(&vault, "pro"));
    a.domain.set("um-1", json!({ "text": "x" }), None);
    a.engine.sync().await.unwrap();
    b.domain.fail_apply.store(true, Ordering::SeqCst);
    b.engine.sync().await.unwrap();
    assert_eq!(b.conflicts().len(), 1);
    b.domain.fail_apply.store(false, Ordering::SeqCst);
    assert_eq!(b.engine.sync().await.unwrap(), result(0, 0, 0));
}

#[tokio::test]
async fn picks_up_where_it_left_off_after_a_restart() {
    let vault = vault();
    let (a, mut b) = (Mac::new(&vault, "air"), Mac::new(&vault, "pro"));
    a.domain.set("um-1", json!({ "text": "x" }), None);
    a.engine.sync().await.unwrap();
    b.engine.sync().await.unwrap();
    b.restart();
    assert_eq!(b.engine.sync().await.unwrap(), result(0, 0, 0));
}

#[tokio::test]
async fn concurrent_callers_share_one_pass_and_a_late_ask_runs_once_more() {
    use std::sync::atomic::Ordering;

    let vault = vault();
    let a = Mac::new(&vault, "air");
    a.domain.yields.store(true, Ordering::SeqCst);
    a.domain.set("um-1", json!(1), None);
    let first = tokio::spawn({
        let engine = a.engine.clone();
        async move { engine.sync().await }
    });
    // The first pass is under way (waiting on its domain) when the second asks.
    tokio::task::yield_now().await;
    a.domain.set("um-2", json!(2), None);
    let second = a.engine.sync().await.unwrap();
    assert_eq!(first.await.unwrap().unwrap(), second, "one pass, one answer");
    assert_eq!(second, result(0, 2, 0));
    assert_eq!(vault.records(VAULT).len(), 2);
}

// ---- beyond the TypeScript suite -----------------------------------------------

#[tokio::test]
async fn nothing_local_is_overwritten_when_the_losing_side_cannot_be_kept() {
    use std::sync::atomic::Ordering;

    let vault = vault();
    let a = Mac::new(&vault, "air");
    a.domain.set("style", json!("terse"), Some(1.0));
    a.engine.sync().await.unwrap();
    let b = Mac::new(&vault, "pro");
    b.domain.set("style", json!("thorough"), Some(999.0));
    b.state.fail_conflicts.store(true, Ordering::SeqCst);
    assert!(b.engine.sync().await.is_err(), "the pass fails instead of dropping the local copy");
    assert_eq!(b.domain.data("style"), Some(json!("thorough")));
    // Once the folder can be written, the same pass goes through.
    b.state.fail_conflicts.store(false, Ordering::SeqCst);
    b.engine.sync().await.unwrap();
    assert_eq!(b.domain.data("style"), Some(json!("terse")));
    assert_eq!(b.conflicts(), [("style".to_owned(), json!("thorough"))]);
}

#[tokio::test]
async fn a_write_whose_answer_was_lost_is_recognized_on_the_next_pass() {
    let vault = vault();
    let (a, b) = (Mac::new(&vault, "air"), Mac::new(&vault, "pro"));
    a.domain.set("um-1", json!({ "text": "x" }), Some(5.0));
    a.client.set_fault(|op| (op == VaultOp::Put).then_some(VaultFault::LoseAnswer));
    assert!(a.engine.sync().await.is_err());
    a.client.clear_fault();
    // The record is in the vault already: no second write, no conflict.
    assert_eq!(a.engine.sync().await.unwrap(), result(0, 0, 0));
    assert_eq!(vault.records(VAULT).len(), 1);
    assert_eq!(b.engine.sync().await.unwrap(), result(1, 0, 0));
    assert!(a.conflicts().is_empty());
}

#[tokio::test]
async fn an_unreadable_record_is_skipped_and_replaced_by_ours() {
    use eos_testkit::vault::StorePut;

    let vault = vault();
    let a = Mac::new(&vault, "air");
    // Another program wrote garbage under this record's name.
    a.client.set_page_limit(10);
    a.engine.sync().await.unwrap();
    assert_eq!(vault.put(VAULT, "memory/um-1", 0, b"not an envelope"), StorePut::Stored { seq: 1 });
    a.domain.set("um-1", json!({ "text": "ours" }), Some(5.0));
    assert_eq!(a.engine.sync().await.unwrap(), result(0, 1, 0));
    let records = vault.records(VAULT);
    assert_eq!(records.len(), 1);
    assert!(String::from_utf8_lossy(&records[0].data).contains("ours"));
}

#[tokio::test]
async fn a_blob_moved_under_another_records_name_is_not_applied() {
    let vault = vault();
    let a = Mac::new(&vault, "air");
    a.domain.set("um-1", json!({ "text": "x" }), Some(5.0));
    a.engine.sync().await.unwrap();
    let blob = vault.records(VAULT).remove(0).data;
    vault.put(VAULT, "memory/um-2", 0, &blob);
    let b = Mac::new(&vault, "pro");
    b.engine.sync().await.unwrap();
    assert_eq!(b.domain.ids(), ["um-1"]);
}

#[tokio::test]
async fn a_write_made_after_someone_elses_leaves_theirs_to_be_read() {
    let vault = vault();
    let (a, b) = (Mac::new(&vault, "air"), Mac::new(&vault, "pro"));
    a.domain.set("um-1", json!(1), None);
    a.engine.sync().await.unwrap();
    b.engine.sync().await.unwrap();
    // Air writes again; pro, not having read that, writes another record.
    a.domain.set("um-1", json!(2), None);
    a.engine.sync().await.unwrap();
    b.domain.yields.store(true, std::sync::atomic::Ordering::SeqCst);
    b.domain.set("um-2", json!("pro"), None);
    // Pro's pass reads air's write (seq 2) and pushes its own (seq 3): caught up.
    assert_eq!(b.engine.sync().await.unwrap(), result(1, 1, 0));
    assert_eq!(b.engine.position(), 3);
    // Air's next pass reads pro's record first, then its own write lands right after.
    a.domain.set("um-3", json!("air"), None);
    assert_eq!(a.engine.sync().await.unwrap(), result(1, 1, 0));
    assert_eq!(a.domain.data("um-2"), Some(json!("pro")));
    assert_eq!(a.engine.position(), 4);
}

#[tokio::test]
async fn the_cursor_does_not_jump_over_a_write_it_has_not_read() {
    use eos_testkit::vault::StorePut;

    let vault = vault();
    let a = Mac::new(&vault, "air");
    a.domain.yields.store(true, std::sync::atomic::Ordering::SeqCst);
    a.domain.set("um-1", json!(1), None);
    // While air's pass is listing its records, another computer writes one.
    let pass = tokio::spawn({
        let engine = a.engine.clone();
        async move { engine.sync().await }
    });
    tokio::task::yield_now().await;
    let theirs = br#"{"v":1,"domain":"memory","id":"um-9","changedAt":5,"device":"pro","data":"theirs"}"#;
    assert_eq!(vault.put(VAULT, "memory/um-9", 0, theirs), StorePut::Stored { seq: 1 });
    assert_eq!(pass.await.unwrap().unwrap(), result(0, 1, 0));
    // Air's write got seq 2, not cursor + 1: the cursor stays, and the next pass reads theirs.
    assert_eq!(a.engine.position(), 0);
    assert_eq!(a.engine.sync().await.unwrap(), result(1, 0, 0));
    assert_eq!(a.domain.data("um-9"), Some(json!("theirs")));
}

#[tokio::test]
async fn a_stopped_engine_ends_its_pass_and_saves_nothing() {
    let vault = vault();
    let a = Mac::new(&vault, "air");
    a.domain.set("um-1", json!(1), None);
    a.engine.stop();
    assert!(a.engine.sync().await.is_err());
    assert!(vault.records(VAULT).is_empty());
    assert_eq!(a.state.saved.lock().unwrap().cursor, 0);
}

#[tokio::test]
async fn a_caller_whose_pass_is_dropped_does_not_strand_the_next_one() {
    use std::sync::atomic::Ordering;

    let vault = vault();
    let a = Mac::new(&vault, "air");
    a.domain.yields.store(true, Ordering::SeqCst);
    a.domain.set("um-1", json!(1), None);
    let first = tokio::spawn({
        let engine = a.engine.clone();
        async move { engine.sync().await }
    });
    tokio::task::yield_now().await;
    first.abort();
    let _ = first.await;
    assert_eq!(a.engine.sync().await.unwrap(), result(0, 1, 0));
}
