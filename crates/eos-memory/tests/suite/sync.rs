//! Memory's sync records between two Macs' stores: a note goes with its
//! hooks and evidence, a forgotten note goes as a tombstone that keeps it
//! from being learned again, each Mac's counters go only from that Mac, and
//! two Macs' changes of one note merge.

use eos_core::store::{StoredEvidence, Tx};
use eos_domain::experience::HookKind;
use eos_domain::sync::SyncItem;
use eos_memory::sync::{Travel, apply_in, counter_items_in, merge, note_ids_in, note_items_in, shard};
use eos_testkit::{FakeClock, TempStore};
use serde_json::json;

use crate::notes::{cue, note, project, put};

const NOW: i64 = FakeClock::START_MS;
const TRAVEL: Travel = Travel { now: NOW, drop_old_text: false };

fn items(temp: &TempStore, since: i64) -> Vec<SyncItem> {
    temp.store.read_blocking(move |tx| note_items_in(tx, since, TRAVEL)).unwrap()
}

fn apply(temp: &TempStore, device: &str, items: Vec<SyncItem>) {
    let device = device.to_owned();
    temp.store
        .write_blocking(move |tx, out| {
            for item in &items {
                apply_in(tx, out, &device, &item.id, &item.data)?;
            }
            Ok(())
        })
        .unwrap();
}

fn evidence(tx: &dyn Tx, id: &str, note_id: &str, at: i64) -> Result<(), eos_core::Error> {
    tx.mem_evidence().insert(&StoredEvidence {
        id: id.into(),
        note_id: note_id.into(),
        kind: "corrected".into(),
        summary: "You shortened the summary".into(),
        worker_id: Some("w-1".into()),
        row_from: Some(1),
        row_to: Some(2),
        run_id: None,
        at,
        device: "mac-a".into(),
    })
}

#[test]
fn a_note_reaches_the_other_mac_with_its_hooks_and_evidence_and_a_forgotten_one_as_a_tombstone() {
    let (a, b) = (TempStore::new(), TempStore::new());
    put(&a, note("mn-1", "Use pnpm here", project("acme/game")), &[cue(HookKind::Tool, "pnpm")]);
    a.store.write_blocking(|tx, _| evidence(tx, "me-1", "mn-1", NOW - 10)).unwrap();
    let sent = items(&a, 0);
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].id, "n-mn-1");
    assert_eq!(sent[0].data["evidence"][0]["summary"], "You shortened the summary");
    assert_eq!(sent[0].data["evidence"][0].get("workerId"), None, "where it was seen stays on its Mac");
    apply(&b, "mac-b", sent);
    let got = b.store.read_blocking(|tx| tx.mem_notes().find("mn-1")).unwrap().expect("the note came");
    assert_eq!((got.note.text.as_str(), got.cues.as_str()), ("Use pnpm here", "pnpm"));
    let hooks = b.store.read_blocking(|tx| tx.mem_graph().links(&["mn-1".to_owned()])).unwrap();
    assert!(hooks.iter().any(|link| link.rel == "about"));
    assert_eq!(b.store.read_blocking(|tx| tx.mem_evidence().of_note("mn-1", 10)).unwrap().len(), 1);

    a.store.write_blocking(|tx, out| eos_memory::forget::forget_in(tx, out, "mn-1", NOW).map(drop)).unwrap();
    let tomb = items(&a, NOW);
    assert_eq!(tomb.len(), 1, "a pass after the forget reads it");
    assert_eq!(tomb[0].data["forgotten"], true);
    assert_eq!(tomb[0].data.get("text"), None, "a tombstone carries only its fingerprint");
    assert!(!tomb[0].data["fingerprint"].to_string().contains("pnpm"), "and the fingerprint no text");
    apply(&b, "mac-b", tomb.clone());
    let got = b.store.read_blocking(|tx| tx.mem_notes().find("mn-1")).unwrap().expect("kept, forgotten");
    assert_eq!(got.forgotten_at, Some(NOW));
    assert!(b.store.read_blocking(|tx| tx.mem_book().forgotten("mn-1")).unwrap().is_some());

    let c = TempStore::new();
    apply(&c, "mac-c", tomb);
    assert!(c.store.read_blocking(|tx| tx.mem_notes().find("mn-1")).unwrap().is_none());
    assert!(c.store.read_blocking(|tx| tx.mem_book().forgotten("mn-1")).unwrap().is_some(), "not learned again");
    assert_eq!(c.store.read_blocking(note_ids_in).unwrap(), ["n-mn-1"]);
}

#[test]
fn each_mac_sends_only_its_own_counters_by_shard() {
    let (a, b) = (TempStore::new(), TempStore::new());
    a.store.write_blocking(|tx, _| tx.mem_credit().add("mn-1", "mac-a", 2, 1, 3, Some(NOW))).unwrap();
    let counters = a.store.read_blocking(|tx| counter_items_in(tx, "mac-a")).unwrap();
    assert_eq!(counters.len(), 1);
    assert_eq!(counters[0].id, format!("c-mac-a-{}", shard("mn-1")));
    apply(&b, "mac-b", counters.clone());
    let sum = b.store.read_blocking(|tx| tx.mem_credit().sum("mn-1")).unwrap();
    assert_eq!((sum.helped, sum.hurt, sum.used), (2, 1, 3));
    apply(
        &a,
        "mac-a",
        vec![SyncItem { data: json!({"device": "mac-a", "counters": {"mn-1": {"helped": 9}}}), ..counters[0].clone() }],
    );
    assert_eq!(a.store.read_blocking(|tx| tx.mem_credit().sum("mn-1")).unwrap().helped, 2, "its own never come back");
    assert_eq!(merge(&counters[0].data, &counters[0].data), None);
}

#[test]
fn two_macs_changes_of_one_note_merge_and_a_forgotten_side_wins() {
    let ours = json!({"text": "old", "updatedAt": 5, "device": "mac-a",
        "evidence": [{"id": "me-1", "at": 1}], "links": [{"b": "mn-2", "rel": "because"}], "hooks": []});
    let theirs = json!({"text": "new", "updatedAt": 9, "device": "mac-b",
        "evidence": [{"id": "me-2", "at": 2}], "links": [], "hooks": [{"id": "mh-1"}]});
    let merged = merge(&ours, &theirs).unwrap();
    assert_eq!(merged["text"], "new");
    assert_eq!(merged["evidence"], json!([{"id": "me-2", "at": 2}, {"id": "me-1", "at": 1}]));
    assert_eq!(merged["links"], json!([{"b": "mn-2", "rel": "because"}]));
    assert_eq!(merged, merge(&theirs, &ours).unwrap(), "the same either way round");
    assert_eq!(merge(&merged, &merged).unwrap(), merged, "merging again changes nothing");
    let tomb = json!({"forgotten": true, "at": 3, "fingerprint": {}});
    assert_eq!(merge(&ours, &tomb), Some(tomb.clone()));
    assert_eq!(merge(&tomb, &theirs), Some(tomb));
}

#[test]
fn a_crowded_vault_sends_old_closed_episodes_without_their_text() {
    let a = TempStore::new();
    let mut old = note("mn-9", "What happened on the 3rd", project("acme/game"));
    old.kind = eos_domain::experience::NoteKind::Episode;
    old.state = eos_domain::experience::NoteState::Closed;
    old.updated_at = NOW - eos_memory::sync::OLD_EPISODE_MS - 1;
    put(&a, old, &[]);
    put(&a, note("mn-1", "Use pnpm here", project("acme/game")), &[]);
    let crowded = Travel { now: NOW, drop_old_text: true };
    let sent = a.store.read_blocking(move |tx| note_items_in(tx, 0, crowded)).unwrap();
    let text = |id: &str| sent.iter().find(|item| item.id == id).unwrap().data["text"].clone();
    assert_eq!((text("n-mn-9"), text("n-mn-1")), (json!(""), json!("Use pnpm here")));
    let b = TempStore::new();
    put(&b, note("mn-9", "kept here", project("acme/game")), &[]);
    apply(&b, "mac-b", sent);
    let kept = b.store.read_blocking(|tx| tx.mem_notes().find("mn-9")).unwrap().unwrap();
    assert_eq!(kept.note.text, "kept here", "a dropped text never replaces a Mac's own");
}
