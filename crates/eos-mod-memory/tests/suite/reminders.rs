//! Notes in a chat: the epoch's pack, reminders that never repeat a note,
//! nothing for a withheld provider or with Reminders off, nothing from a
//! subagent's step.

use eos_contracts::{AgentEvent, CompactionTrigger, ExperienceSettings};
use eos_core::agent::{CompactionNotice, NoteTurn};
use eos_runtime::module::Module;
use serde_json::json;

use crate::rig::Rig;

const LINT: &str = "Pushing here: the pre-push hook rejects unlinted code; npm run lint passes it.";

fn turn(worker_id: &str, message: &str, start: bool) -> NoteTurn {
    NoteTurn { worker_id: worker_id.into(), message: Some(message.into()), start }
}

fn tool(command: &str, parent: Option<&str>) -> AgentEvent {
    serde_json::from_value(json!({"type": "activity", "kind": "tool_started", "callId": "c1", "toolName": "Bash",
        "input": {"command": command}, "parentCallId": parent}))
    .unwrap()
}

#[tokio::test]
async fn the_first_turn_gets_the_pack_and_later_turns_never_repeat_a_note() {
    let rig = Rig::new();
    rig.note_about("mn-000000000001", LINT, "npm run lint");
    let notes = rig.memory.turn_notes(&turn("w-1", "run npm run lint please", true)).await;
    assert_eq!(notes.len(), 1);
    assert!(
        notes[0].starts_with("<system-reminder>\nEos memory:") && notes[0].contains("(mn-000000000001)"),
        "{}",
        notes[0]
    );
    assert_eq!(rig.uses(), 1);
    let announced = rig.temp.announced.list();
    assert_eq!(announced.last().unwrap().0, "memory:recalled");
    assert!(announced.last().unwrap().1.contains(r#""how":"pack""#));

    assert!(rig.memory.turn_notes(&turn("w-1", "npm run lint again", false)).await.is_empty());
    rig.memory.on_agent_event("w-1", &tool("npm run lint", None));
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(rig.sink.0.lock().unwrap().is_empty(), "delivered in this epoch already");

    let done = CompactionNotice::Completed {
        trigger: CompactionTrigger::Auto,
        before_tokens: 100,
        after_tokens: 10,
        turns: 1,
        summary: String::new(),
        instructions: None,
        duration_ms: 1,
    };
    rig.memory.on_compaction("w-1", &done);
    let again = rig.memory.turn_notes(&turn("w-1", "npm run lint", false)).await;
    assert_eq!(again.len(), 1, "a new epoch packs again");
}

#[tokio::test]
async fn a_tool_call_that_matches_brings_a_reminder_but_a_subagent_s_does_not() {
    let rig = Rig::new();
    assert!(rig.memory.turn_notes(&turn("w-1", "hello", true)).await.is_empty());
    rig.note_about("mn-000000000001", LINT, "npm run lint");
    rig.memory.on_agent_event("w-1", &tool("npm run lint", Some("parent")));
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(rig.sink.0.lock().unwrap().is_empty());

    rig.memory.on_agent_event("w-1", &tool("npm run lint", None));
    let reminded = rig.reminded(1).await;
    assert_eq!(reminded.len(), 1);
    assert_eq!(reminded[0].0, "w-1");
    assert!(reminded[0].1.contains("Before this step:") && reminded[0].1.contains(LINT), "{}", reminded[0].1);
    assert_eq!(rig.uses(), 1);
}

#[tokio::test]
async fn a_withheld_provider_and_reminders_off_get_nothing() {
    let rig = Rig::new();
    rig.note_about("mn-000000000001", LINT, "npm run lint");
    rig.profile.0.lock().unwrap().sharing.withhold_from = vec!["openai".into()];
    assert!(rig.memory.turn_notes(&turn("w-gpt", "npm run lint", true)).await.is_empty());

    let off = ExperienceSettings { learning: true, reminders: false };
    rig.temp.port().write(move |tx, _| eos_memory::settings::write_in(tx, off)).await.unwrap();
    assert!(rig.memory.turn_notes(&turn("w-1", "npm run lint", true)).await.is_empty());
    assert_eq!(rig.uses(), 0);
}

#[tokio::test]
async fn an_agent_recalls_by_situation_and_a_withheld_provider_is_refused() {
    let rig = Rig::new();
    rig.note_about("mn-000000000001", LINT, "npm run lint");
    let search = rig.memory.experience_search();
    let found = search.search("w-1", "npm run lint", 5).await.unwrap();
    assert_eq!(found.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(), ["mn-000000000001"]);
    assert_eq!(rig.uses(), 1);
    assert!(rig.temp.announced.list().last().unwrap().1.contains(r#""how":"tool""#));

    rig.profile.0.lock().unwrap().sharing.withhold_from = vec!["claude".into()];
    let refused = search.search("w-1", "npm run lint", 5).await.unwrap_err();
    assert!(matches!(refused, eos_core::Error::PermissionDenied(_)), "{refused:?}");
}
