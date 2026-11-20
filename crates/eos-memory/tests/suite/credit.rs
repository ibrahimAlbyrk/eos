//! Credit: acting on a note counts it used, a good end helps every note
//! recalled once, a surprise gives nothing, "Not right" hurts, and the
//! counters move the note's state.

use std::sync::Arc;

use eos_core::store::StoredUse;
use eos_domain::experience::{NoteState, Trust};
use eos_memory::{ChatOutcome, Credit};
use eos_testkit::{FakeClock, TempStore};

use crate::notes::{note, project, put};

fn credit(temp: &TempStore) -> Credit {
    Credit::new(temp.port(), Arc::new(FakeClock::new()), "mac-a".into())
}

fn trying(temp: &TempStore, id: &str) {
    let mut n = note(id, "Use pnpm here.", project("key:/repo"));
    n.state = NoteState::Trying;
    n.trust = Trust::Did;
    put(temp, n, &[]);
}

fn used(temp: &TempStore, id: &str, note_id: &str, worker_id: &str) {
    let used = StoredUse {
        id: id.into(),
        note_id: note_id.into(),
        worker_id: Some(worker_id.into()),
        run_id: None,
        how: "pack".into(),
        epoch: 10,
        at: FakeClock::START_MS,
        acted: false,
        outcome: None,
    };
    temp.store.write_blocking(move |tx, _| tx.mem_uses().insert(&used)).unwrap();
}

async fn counters(temp: &TempStore, id: &str) -> (i64, i64, i64, String) {
    let id = id.to_owned();
    let n = temp.port().read(move |tx| tx.mem_notes().find(&id)).await.unwrap().unwrap();
    (n.counters.helped, n.counters.hurt, n.counters.used, n.note.state.as_str().to_owned())
}

#[tokio::test]
async fn acting_on_a_note_counts_it_used_once() {
    let temp = TempStore::new();
    trying(&temp, "mn-1");
    used(&temp, "me-1", "mn-1", "w-1");
    let credit = credit(&temp);
    credit.acted("w-1", 10, vec!["mn-1".into()]).await.unwrap();
    credit.acted("w-1", 10, vec!["mn-1".into()]).await.unwrap();
    assert_eq!(counters(&temp, "mn-1").await, (0, 0, 1, "trying".into()));
    assert_eq!(temp.count("SELECT COUNT(*) FROM mem_uses WHERE acted = 1"), 1);
    assert!(temp.announced.list().iter().any(|(t, p)| *t == "memory:change" && p.contains(r#""action":"counts""#)));
}

#[tokio::test]
async fn a_good_end_helps_each_recalled_note_once_and_three_make_it_firm() {
    let temp = TempStore::new();
    trying(&temp, "mn-1");
    let credit = credit(&temp);
    for chat in 0..3 {
        let worker = format!("w-{chat}");
        used(&temp, &format!("me-{chat}a"), "mn-1", &worker);
        used(&temp, &format!("me-{chat}b"), "mn-1", &worker);
        assert_eq!(credit.chat_ended(&worker, ChatOutcome::Good).await.unwrap(), 1);
        assert_eq!(credit.chat_ended(&worker, ChatOutcome::Good).await.unwrap(), 0, "settled already");
    }
    assert_eq!(counters(&temp, "mn-1").await, (3, 0, 0, "firm".into()));
    assert_eq!(temp.count("SELECT COUNT(*) FROM mem_uses WHERE outcome = 'helped'"), 6);
}

#[tokio::test]
async fn a_surprise_gives_nothing_and_settles_the_uses() {
    let temp = TempStore::new();
    trying(&temp, "mn-1");
    used(&temp, "me-1", "mn-1", "w-1");
    let credit = credit(&temp);
    assert_eq!(credit.chat_ended("w-1", ChatOutcome::Surprised).await.unwrap(), 0);
    assert_eq!(credit.chat_ended("w-1", ChatOutcome::Good).await.unwrap(), 0);
    assert_eq!(counters(&temp, "mn-1").await, (0, 0, 0, "trying".into()));
    assert_eq!(temp.count("SELECT COUNT(*) FROM mem_uses WHERE outcome = 'surprised'"), 1);
}

#[tokio::test]
async fn not_right_hurts_until_the_note_closes() {
    let temp = TempStore::new();
    trying(&temp, "mn-1");
    let credit = credit(&temp);
    assert_eq!(credit.not_right("mn-1").await.unwrap(), Some(NoteState::Trying));
    assert_eq!(credit.not_right("mn-1").await.unwrap(), Some(NoteState::Trying), "strength 0.25 is not below");
    assert_eq!(credit.not_right("mn-1").await.unwrap(), Some(NoteState::Closed));
    assert_eq!(counters(&temp, "mn-1").await, (0, 3, 0, "closed".into()));
    assert_eq!(credit.not_right("mn-unknown").await.unwrap(), None);
}
