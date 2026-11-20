//! Night tidying: the rules' steps always (states read again, the same
//! lesson kept once, forgotten text erased once it cannot come back), and
//! the general notes only where a model may be asked, within the day's
//! calls and while Learning is on.

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use eos_contracts::ExperienceSettings;
use eos_core::BoxFuture;
use eos_core::store::DailyCall;
use eos_domain::experience::{HookKind, NoteState, ScopeLevel};
use eos_domain::redact::Scrubber;
use eos_memory::night::{GeneralizePrompt, NIGHT_CALLS_PER_DAY, Night, NightParts};
use eos_memory::{Gate, ModelGate, Recall};
use eos_testkit::{FakeClock, FakeTimeZone, ScriptedOneShot, SeqIds, TempStore};
use serde_json::json;

use crate::notes::{cue, note, project, put};

const DAY: i64 = 24 * 60 * 60 * 1000;

struct FixedGate(Gate);

impl ModelGate for FixedGate {
    fn gate(&self) -> BoxFuture<'_, Gate> {
        Box::pin(std::future::ready(self.0))
    }
}

#[derive(Default)]
struct Prompt(Mutex<Vec<String>>);

impl GeneralizePrompt for Prompt {
    fn render(&self, lessons: &str) -> Result<(String, String), eos_core::Error> {
        self.0.lock().unwrap().push(lessons.to_owned());
        Ok(("SYSTEM".into(), lessons.to_owned()))
    }
}

fn night(temp: &TempStore, gate: Gate, model: &Arc<ScriptedOneShot>) -> Night {
    let clock = Arc::new(FakeClock::new());
    Night::new(NightParts {
        store: temp.port(),
        clock: clock.clone(),
        ids: Arc::new(SeqIds::new()),
        zone: Arc::new(FakeTimeZone::new("UTC", 0)),
        one_shot: model.clone(),
        gate: Arc::new(FixedGate(gate)),
        prompt: Arc::new(Prompt::default()),
        recall: Arc::new(Recall::new(temp.port(), clock)),
        scrubber: Arc::new(Scrubber::new(None)),
        device: "mac-a".into(),
    })
}

fn find(temp: &TempStore, id: &'static str) -> Option<eos_core::store::StoredNote> {
    temp.store.read_blocking(move |tx| tx.mem_notes().find(id)).unwrap()
}

/// Three lessons on the same command in three projects.
fn three_lessons(temp: &TempStore) {
    for (id, key) in [("mn-1", "p"), ("mn-2", "q"), ("mn-3", "r")] {
        put(
            temp,
            note(id, &format!("Run the linter first in {key}."), project(key)),
            &[cue(HookKind::Command, "cargo clippy")],
        );
    }
}

#[tokio::test]
async fn the_rules_cool_dedupe_and_erase_and_ask_no_model() {
    let temp = TempStore::new();
    let hooks = [cue(HookKind::Path, "src/app.rs")];
    put(&temp, note("mn-b", "Keep the app module small.", project("p")), &hooks);
    put(&temp, note("mn-a", "Keep the app module small.", project("p")), &hooks);
    put(&temp, note("mn-c", "Keep the app module small.", project("q")), &hooks);
    let mut old = note("mn-old", "Use the old build script.", project("p"));
    old.created_at = FakeClock::START_MS - 31 * DAY;
    put(&temp, old, &[cue(HookKind::Command, "make")]);
    put(&temp, note("mn-gone", "A forgotten lesson.", project("p")), &[]);
    temp.store
        .write_blocking(|tx, _| tx.mem_notes().set_forgotten("mn-gone", Some(FakeClock::START_MS - 31 * DAY)))
        .unwrap();
    three_lessons(&temp);
    let model = Arc::new(ScriptedOneShot::default());

    let tidied = night(&temp, Gate::RulesOnly, &model).tidy(&AtomicBool::new(false)).await.unwrap();

    let b = find(&temp, "mn-b").unwrap();
    assert_eq!(
        (b.note.state, b.note.replaced_by.as_deref()),
        (NoteState::Closed, Some("mn-a")),
        "the smaller id stays"
    );
    assert_eq!(find(&temp, "mn-a").unwrap().note.state, NoteState::Firm);
    assert_eq!(find(&temp, "mn-c").unwrap().note.state, NoteState::Firm, "another project's lesson is another lesson");
    assert_eq!(find(&temp, "mn-old").unwrap().note.state, NoteState::Cooling, "unused for a month");
    assert!(find(&temp, "mn-gone").is_none(), "its text goes once it cannot come back");
    assert!(model.asked().is_empty(), "no model without leave to ask one");
    assert_eq!((tidied.deduped, tidied.erased, tidied.generalized), (1, 1, 0));
}

#[tokio::test]
async fn three_lessons_on_one_thing_become_one_general_note_where_a_model_may_be_asked() {
    let temp = TempStore::new();
    three_lessons(&temp);
    let model = Arc::new(ScriptedOneShot::default());
    model.data(json!({"skip": false, "text": "Run cargo clippy before committing."}));

    let tidied = night(&temp, Gate::Model, &model).tidy(&AtomicBool::new(false)).await.unwrap();

    assert_eq!(tidied.generalized, 1);
    assert_eq!(model.asked().len(), 1);
    let general = find(&temp, "mn-1").unwrap().note.replaced_by.expect("replaced by the general note");
    let id = general.clone();
    let stored = temp.store.read_blocking(move |tx| tx.mem_notes().find(&id)).unwrap().unwrap();
    assert_eq!(stored.note.text, "Run cargo clippy before committing.");
    assert_eq!(stored.note.scope.level, ScopeLevel::Everywhere, "learned in three projects");
    for id in ["mn-2", "mn-3"] {
        assert_eq!(find(&temp, id).unwrap().note.replaced_by.as_deref(), Some(general.as_str()));
    }
}

#[tokio::test]
async fn the_day_s_calls_and_the_learning_switch_hold_the_model_steps() {
    let temp = TempStore::new();
    three_lessons(&temp);
    let model = Arc::new(ScriptedOneShot::default());
    let spent = night(&temp, Gate::Model, &model);
    let today: String = eos_domain::time::iso_from_ms(FakeClock::START_MS).chars().take(10).collect();
    temp.store
        .write_blocking(move |tx, _| {
            for _ in 0..NIGHT_CALLS_PER_DAY {
                tx.mem_book().count_call(&today, DailyCall::Night)?;
            }
            Ok(())
        })
        .unwrap();
    assert_eq!(spent.tidy(&AtomicBool::new(false)).await.unwrap().generalized, 0);
    assert!(model.asked().is_empty(), "thirty a day at most");

    let fresh = TempStore::new();
    three_lessons(&fresh);
    fresh
        .store
        .write_blocking(|tx, _| {
            eos_memory::settings::write_in(tx, ExperienceSettings { learning: false, reminders: true })
        })
        .unwrap();
    assert_eq!(night(&fresh, Gate::Model, &model).tidy(&AtomicBool::new(false)).await.unwrap().generalized, 0);
    assert!(model.asked().is_empty(), "Learning off stops the model steps");
}
