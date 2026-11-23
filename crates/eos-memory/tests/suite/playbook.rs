//! Playbooks: a night adds lines from a routine's notes and replays past
//! items with the candidate; a later night keeps it only when the replays
//! came closer to what the user sent by 0.02, and records the check either
//! way. A replay's pack carries the candidate and earns no credit.

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use eos_core::BoxFuture;
use eos_core::experience::RunPackRequest;
use eos_core::routine::{RunReplays, StartError};
use eos_domain::experience::{NoteKind, NoteState};
use eos_domain::redact::Scrubber;
use eos_memory::night::{GeneralizePrompt, Night, NightParts};
use eos_memory::playbook::{PlaybookParts, PlaybookPrompt};
use eos_memory::{Credit, Feedback, Gate, ModelGate, Recall};
use eos_testkit::{FakeClock, FakeTimeZone, ScriptedOneShot, SeqIds, TempStore};
use serde_json::json;

use crate::notes::{note, put, routine};

const DAY: i64 = 24 * 60 * 60 * 1000;

struct ModelAllowed;

impl ModelGate for ModelAllowed {
    fn gate(&self) -> BoxFuture<'_, Gate> {
        Box::pin(std::future::ready(Gate::Model))
    }
}

struct Prompt;

impl GeneralizePrompt for Prompt {
    fn render(&self, lessons: &str) -> Result<(String, String), eos_core::Error> {
        Ok(("SYSTEM".into(), lessons.to_owned()))
    }
}

impl PlaybookPrompt for Prompt {
    fn render(&self, playbook: &str, notes: &str) -> Result<(String, String), eos_core::Error> {
        Ok(("SYSTEM".into(), format!("{playbook}\n{notes}")))
    }
}

/// Replays as 01 starts them: one run a past run, named `rn-r<n>`.
#[derive(Default)]
struct Replays(Mutex<Vec<(String, String, Vec<String>)>>);

impl RunReplays for Replays {
    fn replay<'a>(
        &'a self,
        routine_id: &'a str,
        candidate: &'a str,
        run_ids: &'a [String],
    ) -> BoxFuture<'a, Result<Vec<String>, StartError>> {
        let mut calls = self.0.lock().unwrap();
        calls.push((routine_id.to_owned(), candidate.to_owned(), run_ids.to_vec()));
        let made = (1..=run_ids.len()).map(|n| format!("rn-r{n}")).collect();
        Box::pin(std::future::ready(Ok(made)))
    }
}

struct Rig {
    temp: TempStore,
    clock: Arc<FakeClock>,
    model: Arc<ScriptedOneShot>,
    replays: Arc<Replays>,
    night: Night,
}

fn rig() -> Rig {
    let temp = TempStore::new();
    let clock = Arc::new(FakeClock::new());
    let model = Arc::new(ScriptedOneShot::default());
    let replays = Arc::new(Replays::default());
    let night = Night::new(NightParts {
        store: temp.port(),
        clock: clock.clone(),
        ids: Arc::new(SeqIds::new()),
        zone: Arc::new(FakeTimeZone::new("UTC", 0)),
        one_shot: model.clone(),
        gate: Arc::new(ModelAllowed),
        prompt: Arc::new(Prompt),
        recall: Arc::new(Recall::new(temp.port(), clock.clone())),
        scrubber: Arc::new(Scrubber::new(None)),
        device: "mac-a".into(),
        playbooks: Some(PlaybookParts { prompt: Arc::new(Prompt), replays: replays.clone() }),
    });
    Rig { temp, clock, model, replays, night }
}

/// PR Review, active, with one past run whose result said "a b c d" and
/// which the user sent as "a b c x", and one lesson learned for it.
fn seed(temp: &TempStore) {
    temp.exec(
        "INSERT INTO routines (id, slug, name, kind, state, origin, created_at, updated_at, changed_at) \
         VALUES ('rt-1', 'pr-review', 'PR Review', 'standing', 'active', 'hand', 1, 1, 1)",
    );
    run(temp, "rn-1", "a b c d");
    let after = json!({"kind": "github.review", "channel": "github", "action": "review",
        "parts": [{"key": "summary", "role": "summary", "text": "a b c x"}]});
    temp.exec(&format!(
        "INSERT INTO inbox_edits (item_id, routine_id, run_id, result_kind, before, after, ops, changed, removed, \
         added, moved, derived_from_untrusted, at) VALUES ('in-1', 'rt-1', 'rn-1', 'github.review', '{{}}', '{after}', \
         '[]', 1, 0, 0, 0, 0, 1)"
    ));
    put(temp, note("mn-1", "Name the failing test.", routine("rt-1")), &[]);
}

/// A run of PR Review that ended with a result whose summary is `summary`.
fn run(temp: &TempStore, id: &str, summary: &str) {
    temp.exec(&format!(
        "INSERT INTO runs (id, routine_id, kind, origin, input, state, priority, device, created_at, updated_at) \
         VALUES ('{id}', 'rt-1', 'standing', 'hand', '{{}}', 'done', 0, 'mac-a', 1, 1)"
    ));
    temp.exec(&format!(
        "INSERT INTO run_results (run_id, attempt, kind, headline, body, created_at) \
         VALUES ('{id}', 1, 'github.review', 'h', '{{\"summary\": \"{summary}\"}}', 1)"
    ));
}

fn pack_request(candidate: Option<&str>) -> RunPackRequest {
    RunPackRequest {
        run_id: "rn-9".into(),
        routine_id: "rt-1".into(),
        project: None,
        item_cues: vec![],
        item_text: "review".into(),
        trial: candidate.is_some(),
        playbook_candidate: candidate.map(str::to_owned),
    }
}

fn feedback(rig: &Rig) -> Feedback {
    let credit = Arc::new(Credit::new(rig.temp.port(), rig.clock.clone(), "mac-a".into()));
    let recall = Arc::new(Recall::new(rig.temp.port(), rig.clock.clone()));
    Feedback::new(rig.temp.port(), rig.clock.clone(), Arc::new(SeqIds::new()), recall, credit, "mac-a".into())
}

/// The first night: one candidate with the model's line, replayed on rn-1.
async fn first_night(rig: &Rig) -> String {
    seed(&rig.temp);
    rig.model
        .data(json!({"skip": false, "lines": [{"text": "Each finding names its test.", "from": ["mn-1", "mn-x"]}]}));
    let tidied = rig.night.tidy(&AtomicBool::new(false)).await.unwrap();
    assert_eq!(tidied.playbooks.tried, 1);
    let calls = rig.replays.0.lock().unwrap().clone();
    assert_eq!(calls.len(), 1);
    let (routine_id, candidate, runs) = calls[0].clone();
    assert_eq!((routine_id.as_str(), runs), ("rt-1", vec!["rn-1".to_owned()]));
    assert!(rig.model.asked().last().unwrap().prompt.contains("[mn-1] Name the failing test."));
    candidate
}

#[tokio::test]
async fn a_rewrite_is_kept_only_after_its_replays_come_closer() {
    let rig = rig();
    let candidate = first_night(&rig).await;

    // A replay reads the candidate first, and nothing is credited.
    let pack = feedback(&rig).for_run(pack_request(Some(&candidate))).await.unwrap();
    assert!(pack.text.contains("Each finding names its test."), "{}", pack.text);
    assert_eq!(rig.temp.count("SELECT COUNT(*) FROM mem_uses"), 0, "a replay earns no credit");
    let plain = feedback(&rig).for_run(pack_request(None)).await.unwrap();
    assert!(!plain.text.contains("Each finding names its test."), "not kept yet");

    run(&rig.temp, "rn-r1", "a b c x");
    rig.clock.advance(DAY);
    let tidied = rig.night.tidy(&AtomicBool::new(false)).await.unwrap();
    assert_eq!((tidied.playbooks.scored, tidied.playbooks.kept, tidied.playbooks.tried), (1, 1, 0));
    let row = rig.temp.store.read_blocking(|tx| tx.mem_book().replays("rt-1")).unwrap();
    assert_eq!(row.len(), 1);
    assert_eq!(
        (row[0].items, row[0].old_score, row[0].new_score, row[0].kept, row[0].version),
        (1, 0.75, 1.0, true, 1)
    );

    let playbook = rig.temp.store.read_blocking(|tx| eos_memory::playbook::playbook_in(tx, "rt-1")).unwrap();
    let playbook = playbook.expect("kept");
    assert_eq!((playbook.note.kind, playbook.note.state), (NoteKind::Playbook, NoteState::Firm));
    assert_eq!(playbook.note.text, "Each finding names its test.");
    let id = playbook.note.id.clone();
    let versions = rig.temp.store.read_blocking(move |tx| tx.mem_versions().of_note(&id)).unwrap();
    assert_eq!(versions.iter().map(|v| (v.rev, v.why.as_str())).collect::<Vec<_>>(), [(1, "rewritten")]);
    let pack = feedback(&rig).for_run(pack_request(None)).await.unwrap();
    assert!(pack.text.contains("Each finding names its test."), "every run reads it now");
}

#[tokio::test]
async fn a_rewrite_that_does_not_come_closer_is_discarded() {
    let rig = rig();
    first_night(&rig).await;
    run(&rig.temp, "rn-r1", "a b c d");
    rig.clock.advance(DAY);
    let tidied = rig.night.tidy(&AtomicBool::new(false)).await.unwrap();
    assert_eq!((tidied.playbooks.scored, tidied.playbooks.kept), (1, 0));
    let row = rig.temp.store.read_blocking(|tx| tx.mem_book().replays("rt-1")).unwrap();
    assert_eq!((row[0].old_score, row[0].new_score, row[0].kept, row[0].version), (0.75, 0.75, false, 0));
    assert!(rig.temp.store.read_blocking(|tx| eos_memory::playbook::playbook_in(tx, "rt-1")).unwrap().is_none());
    assert_eq!(rig.temp.count("SELECT COUNT(*) FROM mem_notes WHERE kind = 'playbook'"), 0);
}

#[tokio::test]
async fn a_candidate_waits_for_its_replays_then_a_day_at_most() {
    let rig = rig();
    first_night(&rig).await;
    rig.temp.exec(
        "INSERT INTO runs (id, routine_id, kind, origin, input, state, priority, device, created_at, updated_at) \
         VALUES ('rn-r1', 'rt-1', 'trial', 'replay', '{}', 'running', 0, 'mac-a', 1, 1)",
    );
    let tidied = rig.night.tidy(&AtomicBool::new(false)).await.unwrap();
    assert_eq!((tidied.playbooks.scored, tidied.playbooks.tried), (0, 0), "still replaying, and not rewritten again");
    rig.clock.advance(DAY);
    let tidied = rig.night.tidy(&AtomicBool::new(false)).await.unwrap();
    assert_eq!((tidied.playbooks.scored, tidied.playbooks.kept), (1, 0), "no result: nothing to keep");
    let row = rig.temp.store.read_blocking(|tx| tx.mem_book().replays("rt-1")).unwrap();
    assert_eq!(row[0].items, 0);
}
