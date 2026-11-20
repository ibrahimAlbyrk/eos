//! What the module is before it learns anything: its topics, the user's
//! switches and the meaning model it loads at start.

use std::sync::Arc;
use std::time::Duration;

use eos_contracts::ExperienceSettings;
use eos_core::experience::Embedder;
use eos_mod_memory::{EmbedderHealth, LoadEmbedder, MemoryModule};
use eos_runtime::module::Module;
use eos_testkit::{FakeEmbedder, FakeSleeper, TempStore};

fn module(temp: &TempStore, embedder: Option<LoadEmbedder>) -> MemoryModule {
    MemoryModule::new(crate::rig::parts(temp, Arc::new(FakeSleeper::default()), embedder))
}

async fn settled(module: &MemoryModule) -> EmbedderHealth {
    for _ in 0..200 {
        let health = module.embedder_health();
        if health != EmbedderHealth::Loading {
            return health;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    EmbedderHealth::Loading
}

#[tokio::test]
async fn it_announces_its_two_topics() {
    let temp = TempStore::new();
    let names: Vec<&str> = module(&temp, None).topics().iter().map(|t| t.name).collect();
    assert_eq!(names, ["memory:change", "memory:recalled"]);
}

#[tokio::test]
async fn learning_and_reminders_are_on_until_the_user_turns_one_off() {
    let temp = TempStore::new();
    let memory = module(&temp, None);
    assert_eq!(memory.settings().await.unwrap(), ExperienceSettings { learning: true, reminders: true });
    let off = ExperienceSettings { learning: false, reminders: true };
    temp.port().write(move |tx, _| eos_memory::settings::write_in(tx, off)).await.unwrap();
    assert_eq!(memory.settings().await.unwrap(), off);
}

#[tokio::test]
async fn the_meaning_model_loads_at_start_and_without_one_recall_stays_on_words() {
    let temp = TempStore::new();
    let none = module(&temp, None);
    none.start().await.unwrap();
    assert_eq!(none.embedder_health(), EmbedderHealth::Off);

    let load: LoadEmbedder = Box::new(|| Ok(Arc::new(FakeEmbedder::new()) as Arc<dyn Embedder>));
    let loaded = module(&temp, Some(load));
    assert_eq!(loaded.embedder_health(), EmbedderHealth::Loading);
    loaded.start().await.unwrap();
    assert_eq!(settled(&loaded).await, EmbedderHealth::Ready);
    loaded.stop().await;

    let broken = module(&temp, Some(Box::new(|| Err("no model.safetensors".into()))));
    broken.start().await.unwrap();
    assert_eq!(settled(&broken).await, EmbedderHealth::Off);
}

mod capture {
    use std::sync::Arc;
    use std::time::Duration;

    use eos_contracts::{AgentEvent, WorkerEventType};
    use eos_mod_memory::MemoryModule;
    use eos_runtime::idle::IdleHooks;
    use eos_runtime::module::Module;
    use eos_testkit::{FakeClock, FakeSleeper, TempStore};
    use serde_json::json;

    fn module(temp: &TempStore, sleeper: Arc<FakeSleeper>) -> MemoryModule {
        MemoryModule::new(crate::rig::parts(temp, sleeper, None))
    }

    fn correct(temp: &TempStore) {
        for (kind, payload) in [
            (WorkerEventType::UserMessage, json!({"text": "fix it", "msgId": "m-1"})),
            (
                WorkerEventType::AgentEvent,
                json!({"type": "message", "role": "assistant", "blocks": [{"type": "text", "text": "Done."}]}),
            ),
            (WorkerEventType::UserMessage, json!({"text": "No, that's wrong", "msgId": "m-2"})),
        ] {
            temp.store
                .write_blocking(move |tx, _| {
                    tx.events().append("w-1", FakeClock::START_MS, kind, Some(&payload.to_string())).map(drop)
                })
                .unwrap();
        }
    }

    async fn moments(temp: &TempStore, want: usize) -> usize {
        for _ in 0..200 {
            let n = temp.port().read(|tx| tx.mem_moments().count_pending()).await.unwrap() as usize;
            if n >= want {
                return n;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        0
    }

    #[tokio::test]
    async fn the_idle_edge_looks_without_taking_the_worker() {
        let temp = TempStore::new();
        correct(&temp);
        let memory = module(&temp, Arc::new(FakeSleeper::default()));
        let hooks = IdleHooks::new(memory.idle_hooks());
        hooks.run("w-1").await;
        assert_eq!(moments(&temp, 1).await, 1);
    }

    #[tokio::test]
    async fn a_worker_still_working_is_looked_at_every_ten_minutes() {
        let temp = TempStore::new();
        let sleeper = Arc::new(FakeSleeper::default());
        let memory = module(&temp, sleeper.clone());
        memory.start().await.unwrap();
        correct(&temp);
        memory.on_agent_event(
            "w-1",
            &serde_json::from_value::<AgentEvent>(json!({"type": "message", "role": "assistant", "blocks": []}))
                .unwrap(),
        );
        for _ in 0..200 {
            if sleeper.pending() == [10 * 60 * 1000] {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(sleeper.wake());
        assert_eq!(moments(&temp, 1).await, 1);
        memory.stop().await;
    }

    #[tokio::test]
    async fn a_session_that_ends_is_looked_at_once_more() {
        let temp = TempStore::new();
        correct(&temp);
        module(&temp, Arc::new(FakeSleeper::default())).on_session_exit("w-1");
        assert_eq!(moments(&temp, 1).await, 1);
    }

    #[tokio::test]
    async fn a_correction_at_the_idle_edge_settles_the_notes_recalled_as_a_surprise() {
        let temp = TempStore::new();
        let used = eos_core::store::StoredUse {
            id: "me-1".into(),
            note_id: "mn-1".into(),
            worker_id: Some("w-1".into()),
            run_id: None,
            how: "pack".into(),
            epoch: 0,
            at: 1,
            acted: true,
            outcome: None,
        };
        temp.store.write_blocking(move |tx, _| tx.mem_uses().insert(&used)).unwrap();
        correct(&temp);
        let memory = module(&temp, Arc::new(FakeSleeper::default()));
        IdleHooks::new(memory.idle_hooks()).run("w-1").await;
        assert_eq!(moments(&temp, 1).await, 1);
        for _ in 0..100 {
            if temp.count("SELECT COUNT(*) FROM mem_uses WHERE outcome = 'surprised'") == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(temp.count("SELECT COUNT(*) FROM mem_uses WHERE outcome = 'surprised'"), 1);
        assert_eq!(temp.count("SELECT COUNT(*) FROM mem_credit"), 0, "a surprise helps nothing");
    }
}

mod edits {
    use std::sync::Arc;
    use std::time::Duration;

    use eos_contracts::{EditOp, Part, PartEdit, ResultDoc};
    use eos_core::inbox::ResultEdit;
    use eos_mod_memory::{EditParts, MemoryModule};
    use eos_runtime::module::Module;
    use eos_runtime::{Kernel, KernelOptions};
    use eos_testkit::{FakeResultEdits, FakeSleeper, TempStore};

    fn edit(id: i64) -> ResultEdit {
        let part = |text: &str| Part {
            key: "summary".into(),
            role: "summary".into(),
            text: text.into(),
            meta: Default::default(),
        };
        let doc = |text: &str| ResultDoc {
            kind: "github.review".into(),
            channel: "github".into(),
            action: "post_review".into(),
            parts: vec![part(text)],
        };
        ResultEdit {
            id,
            item_id: "nd-1".into(),
            delivery_id: None,
            routine_id: "rt-1".into(),
            run_id: "rn-1".into(),
            before: doc("A long summary."),
            after: doc("Short."),
            ops: vec![PartEdit {
                key: "summary".into(),
                op: EditOp::Changed,
                before: Some(part("A long summary.")),
                after: Some(part("Short.")),
            }],
            derived_from_untrusted: false,
            at: 1,
        }
    }

    async fn moments(temp: &TempStore, want: i64) -> i64 {
        for _ in 0..200 {
            let n = temp.count("SELECT COUNT(*) FROM mem_moments WHERE source = 'edit'");
            if n >= want {
                return n;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        temp.count("SELECT COUNT(*) FROM mem_moments WHERE source = 'edit'")
    }

    #[tokio::test]
    async fn edits_are_read_at_start_and_after_each_change_in_needs_you() {
        let kernel = Kernel::new(KernelOptions::default());
        let temp = TempStore::on_bus(&kernel.bus);
        let edits = Arc::new(FakeResultEdits::new());
        edits.add(edit(1));
        let mut parts = crate::rig::parts(&temp, Arc::new(FakeSleeper::default()), None);
        parts.edits = Some(EditParts { bus: kernel.bus.clone(), edits: edits.clone() });
        let memory = MemoryModule::new(parts);
        memory.start().await.unwrap();
        assert_eq!(moments(&temp, 1).await, 1);
        edits.add(edit(2));
        let change: eos_runtime::bus::Topic<serde_json::Value> = eos_runtime::bus::Topic::new("inbox:change");
        kernel.bus.publish(&change, &serde_json::json!({}));
        assert_eq!(moments(&temp, 2).await, 2);
        memory.stop().await;
    }
}
