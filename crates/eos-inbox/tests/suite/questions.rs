//! A run worker's questions wait in Needs you and their answer reaches the
//! asker; a chat's take the path they always took; an interrupted asker
//! takes its item back, except while the app shuts down.

use std::sync::Arc;
use std::time::Duration;

use eos_contracts::{InboxAnswer, UnknownRecord};
use eos_core::agent::UserQuestions;
use eos_core::routine::RoutineControl;
use eos_core::store::StoredItem;
use eos_domain::inbox::{ItemKind, ItemState};
use eos_inbox::{RunQuestionParts, RunQuestions};
use eos_testkit::{FakeUser, TempStore};
use serde_json::{Value, json};

use crate::rig::Rig;

struct Asking {
    rig: Rig,
    questions: RunQuestions,
    user: Arc<FakeUser>,
}

impl Asking {
    fn new() -> Self {
        Self::on(TempStore::new())
    }

    fn on(temp: TempStore) -> Self {
        let user = Arc::new(FakeUser::default());
        let questions = RunQuestions::new(RunQuestionParts {
            store: temp.port(),
            clock: Arc::new(eos_testkit::FakeClock::at(1_000_000)),
            ids: Arc::new(eos_testkit::SeqIds::new()),
            zone: Arc::new(eos_testkit::FakeTimeZone::new("Europe/Istanbul", 180)),
            wrapped: user.clone(),
        });
        let rig = Rig::with_waiters(temp, questions.waiters());
        let control: Arc<dyn RoutineControl> = rig.control.clone();
        questions.attach(&control);
        Self { rig, questions, user }
    }

    fn with_run(self) -> Self {
        self.rig.temp.exec(
            "INSERT INTO runs (id, routine_id, version_id, kind, origin, input, state, priority, device, created_at, \
             updated_at) VALUES ('rn-1', 'rt-1', 'rv-1', 'trial', 'trial', '{}', 'running', 0, 'd', 1, 1); \
             INSERT INTO routine_sessions (worker_id, routine_id, run_id, role, created_at) \
             VALUES ('w-run', 'rt-1', 'rn-1', 'solo', 1);",
        );
        self
    }

    fn ask(&self, worker: &str) -> tokio::task::JoinHandle<Option<UnknownRecord>> {
        let (questions, worker) = (self.questions.clone(), worker.to_owned());
        tokio::spawn(async move { questions.ask(&worker, Some("call-1"), asked()).await })
    }

    /// The run's question item, once it is open.
    async fn item(&self) -> StoredItem {
        for _ in 0..200 {
            let found = self.rig.temp.port().read(|tx| tx.inbox_items().waiting(10)).await.expect("reads");
            if let Some(item) = found.into_iter().find(|item| item.kind == ItemKind::Question) {
                return item;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("no question item opened");
    }

    async fn state_becomes(&self, id: &str, state: ItemState) {
        for _ in 0..200 {
            if self.rig.find(id).await.state == state {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("the item never became {}", state.as_str());
    }
}

fn asked() -> Vec<UnknownRecord> {
    let question = json!({
        "question": "Which branch?",
        "header": "Branch",
        "multiSelect": false,
        "options": [{"label": "main", "description": "The default"}, {"label": "dev"}],
    });
    vec![serde_json::from_value(question).expect("a question")]
}

fn choose(answer: &str) -> InboxAnswer {
    serde_json::from_value(json!({"kind": "question", "answers": {"Which branch?": answer}})).expect("an answer")
}

#[tokio::test]
async fn a_run_question_waits_in_needs_you_and_its_answer_reaches_the_asker() {
    let asking = Asking::new().with_run();
    let asker = asking.ask("w-run");
    let item = asking.item().await;
    assert_eq!((item.producer.as_str(), item.run_id.as_deref()), ("routines", Some("rn-1")));
    assert_eq!(item.title, "Which branch?");
    let payload: Value = serde_json::from_str(&item.payload).expect("json");
    assert_eq!(
        payload,
        json!({"questions": [{"question": "Which branch?", "options": [{"label": "main"}, {"label": "dev"}]}]})
    );
    assert!(asking.user.asked.lock().expect("asked").is_empty(), "the chat's path is not taken");

    asking.rig.items.answer(&item.id, item.rev, &choose("dev"), "phone").await.expect("answers");
    let heard = asker.await.expect("the asker ends").expect("answers");
    assert_eq!(heard.get("Which branch?"), Some(&Value::String("dev".into())));
    // The asker heard it: nothing is left for the routines to act on.
    assert!(asking.rig.items.unconsumed("routines").await.expect("reads").is_empty());
}

#[tokio::test]
async fn a_chats_question_takes_the_path_it_always_took() {
    let asking = Asking::new().with_run();
    *asking.user.answers.lock().expect("answers") =
        Some(UnknownRecord::from([("Which branch?".into(), json!("main"))]));
    let heard = asking.ask("w-chat").await.expect("the asker ends").expect("answers");
    assert_eq!(heard.get("Which branch?"), Some(&json!("main")));
    assert_eq!(asking.user.calls.lock().expect("calls").as_slice(), [Some("call-1".to_owned())]);
    assert_eq!(asking.rig.temp.count("SELECT COUNT(*) FROM inbox_items"), 0);
}

#[tokio::test]
async fn an_interrupted_asker_takes_its_question_back() {
    let asking = Asking::new().with_run();
    let asker = asking.ask("w-run");
    let item = asking.item().await;
    asker.abort();
    asking.state_becomes(&item.id, ItemState::Withdrawn).await;
}

#[tokio::test]
async fn at_shutdown_the_question_stays_and_its_later_answer_waits_for_the_routines() {
    let asking = Asking::new().with_run();
    let asker = asking.ask("w-run");
    let item = asking.item().await;
    asking.questions.close();
    asker.abort();
    let _ = asker.await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(asking.rig.find(&item.id).await.state, ItemState::Open);

    // The app starts again; the user answers a question nobody waits on.
    let Asking { rig: Rig { temp: TempStore { store, home, .. }, .. }, .. } = asking;
    drop(store);
    let asking = Asking::on(TempStore::in_home(home));
    asking.rig.items.answer(&item.id, item.rev, &choose("main"), "dashboard").await.expect("answers");
    let handed = asking.rig.items.unconsumed("routines").await.expect("reads");
    assert_eq!(handed.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(), [item.id.as_str()]);
}
