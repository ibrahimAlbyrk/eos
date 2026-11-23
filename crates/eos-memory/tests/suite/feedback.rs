//! Runs: the pack a run's lead reads (recorded unless a trial), credit by
//! how the run ended, a failed check kept as a moment, and a removed
//! routine's notes closed.

use std::sync::Arc;

use eos_contracts::WorkerEventType;
use eos_core::experience::{CheckVerdict, RunPackRequest};
use eos_domain::experience::{NoteState, Trust};
use eos_memory::{Credit, Feedback, Recall};
use eos_testkit::{FakeClock, SeqIds, TempStore};

use crate::notes::{note, put, routine};

fn feedback(temp: &TempStore) -> Feedback {
    let clock = Arc::new(FakeClock::new());
    let credit = Arc::new(Credit::new(temp.port(), clock.clone(), "mac-a".into()));
    let recall = Arc::new(Recall::new(temp.port(), clock.clone()));
    Feedback::new(temp.port(), clock, Arc::new(SeqIds::new()), recall, credit, "mac-a".into())
}

fn seed(temp: &TempStore) {
    let mut said = note("mn-1", "Review summaries stay under five lines.", routine("rt-1"));
    said.trust = Trust::Said;
    put(temp, said, &[]);
    put(temp, note("mn-2", "Review comments on generated files are skipped.", routine("rt-1")), &[]);
    put(temp, note("mn-3", "Review summaries for another routine.", routine("rt-2")), &[]);
}

fn request(trial: bool) -> RunPackRequest {
    RunPackRequest {
        run_id: "rn-1".into(),
        routine_id: "rt-1".into(),
        project: None,
        item_cues: vec![],
        item_text: "review summaries comments".into(),
        trial,
        playbook_candidate: None,
    }
}

#[tokio::test]
async fn a_run_gets_its_routine_s_notes_and_a_trial_records_nothing() {
    let temp = TempStore::new();
    seed(&temp);
    let feedback = feedback(&temp);
    let pack = feedback.for_run(request(true)).await.unwrap();
    assert!(pack.note_ids.contains(&"mn-1".to_owned()), "{pack:?}");
    assert!(!pack.note_ids.contains(&"mn-3".to_owned()), "another routine's note never comes");
    assert!(pack.text.starts_with("<system-reminder>\nEos memory:"));
    assert_eq!(temp.count("SELECT COUNT(*) FROM mem_uses"), 0, "a trial earns no credit");

    let pack = feedback.for_run(request(false)).await.unwrap();
    assert_eq!(
        temp.count("SELECT COUNT(*) FROM mem_uses WHERE run_id = 'rn-1' AND worker_id IS NULL"),
        pack.note_ids.len() as i64
    );
    assert!(temp.announced.list().iter().any(|(t, p)| *t == "memory:recalled" && p.contains("rn-1")));

    temp.exec("INSERT OR REPLACE INTO mem_settings (key, value) VALUES ('reminders', 'off')");
    assert!(feedback.for_run(request(false)).await.unwrap().text.is_empty(), "Reminders off");
}

#[tokio::test]
async fn a_run_sent_as_it_was_helps_its_notes_and_an_edited_one_only_uses_them() {
    let temp = TempStore::new();
    seed(&temp);
    let feedback = feedback(&temp);
    let pack = feedback.for_run(request(false)).await.unwrap();
    let n = pack.note_ids.len() as i64;
    feedback.run_ended("rn-1", "sent_unedited").await.unwrap();
    assert_eq!(temp.count("SELECT COUNT(*) FROM mem_credit WHERE helped = 1 AND used = 1"), n);
    feedback.run_ended("rn-1", "sent_unedited").await.unwrap();
    assert_eq!(temp.count("SELECT COUNT(*) FROM mem_credit WHERE helped = 1 AND used = 1"), n, "once per run");

    let edited = RunPackRequest { run_id: "rn-2".into(), ..request(false) };
    feedback.for_run(edited).await.unwrap();
    feedback.run_ended("rn-2", "sent_edited").await.unwrap();
    assert_eq!(temp.count("SELECT COUNT(*) FROM mem_credit WHERE helped = 1 AND used = 2"), n);
    let thrown = RunPackRequest { run_id: "rn-3".into(), ..request(false) };
    feedback.for_run(thrown).await.unwrap();
    feedback.run_ended("rn-3", "discarded").await.unwrap();
    assert_eq!(temp.count("SELECT COUNT(*) FROM mem_uses WHERE run_id = 'rn-3' AND outcome = 'discarded'"), n);
    assert_eq!(temp.count("SELECT COUNT(*) FROM mem_credit WHERE helped = 1 AND used = 2"), n, "nothing for a discard");
}

#[tokio::test]
async fn a_failed_check_is_a_moment_unless_learning_is_off() {
    let temp = TempStore::new();
    temp.store
        .write_blocking(|tx, _| {
            tx.events().append(
                "w-lead",
                1,
                WorkerEventType::AgentEvent,
                Some(r#"{"type":"message","role":"assistant","blocks":[]}"#),
            )
        })
        .unwrap();
    let feedback = feedback(&temp);
    let verdict = CheckVerdict { run_id: "rn-1".into(), routine_id: "rt-1".into(), worker_id: "w-lead".into() };
    assert!(feedback.check_failed(verdict.clone()).await.unwrap());
    assert_eq!(
        temp.count(
            "SELECT COUNT(*) FROM mem_moments WHERE signal = 'checker_disagrees' AND source = 'run' AND row_to > 0"
        ),
        1
    );
    temp.exec("INSERT OR REPLACE INTO mem_settings (key, value) VALUES ('learning', 'off')");
    assert!(!feedback.check_failed(verdict).await.unwrap());
}

#[tokio::test]
async fn a_routine_removed_for_good_closes_its_notes_only() {
    let temp = TempStore::new();
    seed(&temp);
    assert_eq!(feedback(&temp).routine_removed("rt-1").await.unwrap(), 2);
    assert_eq!(
        temp.count(&format!("SELECT COUNT(*) FROM mem_notes WHERE state = '{}'", NoteState::Closed.as_str())),
        2
    );
    assert_eq!(temp.count("SELECT COUNT(*) FROM mem_versions WHERE why = 'closed'"), 2);
    assert_eq!(temp.count("SELECT COUNT(*) FROM mem_notes WHERE id = 'mn-3' AND state != 'closed'"), 1);
}
