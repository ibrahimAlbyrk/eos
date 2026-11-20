//! Capture: moments come from the rows after a worker's cursor, once each,
//! hold row ranges and cues but never text, and nothing is kept while
//! Learning is off or from a trial.

use std::path::PathBuf;
use std::sync::Arc;

use eos_contracts::{ExperienceSettings, WorkerEventType};
use eos_core::routine::RunRef;
use eos_core::store::NewPending;
use eos_domain::pending::SWEPT_ON_EXIT;
use eos_domain::run_scope::{RunRole, Trust};
use eos_memory::Capture;
use eos_testkit::{FakeClock, SeqIds, TempStore};
use serde_json::{Value, json};

const SECRET_WORDS: &str = "the launch code is swordfish";

fn capture(temp: &TempStore) -> Capture {
    Capture::new(temp.port(), Arc::new(FakeClock::new()), Arc::new(SeqIds::new()))
}

fn append(temp: &TempStore, kind: WorkerEventType, payload: Value) {
    temp.store
        .write_blocking(move |tx, _| {
            tx.events().append("w-1", FakeClock::START_MS, kind, Some(&payload.to_string())).map(drop)
        })
        .unwrap();
}

/// The agent answers, and the user says it is wrong.
fn correction(temp: &TempStore) {
    append(temp, WorkerEventType::UserMessage, json!({"text": "fix the build", "msgId": "m-1"}));
    append(
        temp,
        WorkerEventType::AgentEvent,
        json!({"type": "message", "role": "assistant", "blocks": [{"type": "text", "text": "Done."}]}),
    );
    append(
        temp,
        WorkerEventType::UserMessage,
        json!({"text": format!("No, that's wrong: {SECRET_WORDS}"), "msgId": "m-2"}),
    );
}

fn run(kind: &str, origin: &str) -> RunRef {
    RunRef {
        run_id: "rn-1".into(),
        routine_id: "rt-1".into(),
        version_id: "rv-1".into(),
        kind: kind.into(),
        role: RunRole::Solo,
        agent_key: None,
        trust: Trust::Trusted,
        origin: origin.into(),
        started_at: FakeClock::START_MS,
        output_dir: PathBuf::from("/tmp/run"),
    }
}

#[tokio::test]
async fn a_correction_becomes_one_moment_without_its_words() {
    let temp = TempStore::new();
    correction(&temp);
    let capture = capture(&temp);
    let first = capture.look("w-1", None).await.unwrap();
    assert_eq!(first.stored.len(), 1);
    let moment = &first.stored[0];
    assert_eq!(
        (moment.signal.as_str(), moment.source.as_str(), moment.state.as_str()),
        ("says_wrong", "agent", "pending")
    );
    assert!(moment.id.starts_with("mm-"));
    let stored = format!("{moment:?}");
    assert!(!stored.contains("swordfish") && !stored.contains("wrong:"), "{stored}");

    assert!(capture.look("w-1", None).await.unwrap().stored.is_empty(), "the cursor moved past it");
    let pending = temp.port().read(|tx| tx.mem_moments().pending(10)).await.unwrap();
    assert_eq!(pending.len(), 1);
}

#[tokio::test]
async fn with_learning_off_the_cursor_moves_and_nothing_is_kept() {
    let temp = TempStore::new();
    let off = ExperienceSettings { learning: false, reminders: true };
    temp.port().write(move |tx, _| eos_memory::settings::write_in(tx, off)).await.unwrap();
    correction(&temp);
    let capture = capture(&temp);
    assert!(capture.look("w-1", None).await.unwrap().stored.is_empty());
    let on = ExperienceSettings { learning: true, reminders: true };
    temp.port().write(move |tx, _| eos_memory::settings::write_in(tx, on)).await.unwrap();
    assert!(capture.look("w-1", None).await.unwrap().stored.is_empty(), "what was said while off never teaches");
}

#[tokio::test]
async fn a_run_s_moment_names_its_run_and_a_trial_teaches_nothing() {
    let temp = TempStore::new();
    correction(&temp);
    let moments = capture(&temp).look("w-1", Some(run("standing", "trigger"))).await.unwrap().stored;
    assert_eq!((moments[0].source.as_str(), moments[0].run_id.as_deref()), ("run", Some("rn-1")));

    let temp = TempStore::new();
    correction(&temp);
    assert!(capture(&temp).look("w-1", Some(run("standing", "trial"))).await.unwrap().stored.is_empty());
}

#[tokio::test]
async fn the_user_s_denials_count_and_the_app_s_own_do_not() {
    let temp = TempStore::new();
    temp.store
        .write_blocking(|tx, _| {
            for (id, reason) in [("p-1", "denied by human"), ("p-2", SWEPT_ON_EXIT)] {
                tx.pending().insert(&NewPending {
                    id: id.into(),
                    worker_id: "w-1".into(),
                    tool_name: "Bash".into(),
                    input: "{}".into(),
                    tool_use_id: None,
                    created_at: FakeClock::START_MS,
                    expires_at: FakeClock::START_MS + 1,
                })?;
                tx.pending().resolve(id, "deny", Some(reason), None)?;
            }
            Ok(())
        })
        .unwrap();
    let capture = capture(&temp);
    let moments = capture.look("w-1", None).await.unwrap().stored;
    let signals: Vec<&str> = moments.iter().map(|m| m.signal.as_str()).collect();
    assert_eq!(signals, ["denies"]);
    assert_eq!(moments[0].cues, r#"[{"kind":"tool","key":"Bash"}]"#);
    assert!(capture.look("w-1", None).await.unwrap().stored.is_empty());
}
