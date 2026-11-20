//! What the module is before it learns anything: its topics, the user's
//! switches and the meaning model it loads at start.

use std::sync::Arc;
use std::time::Duration;

use eos_contracts::ExperienceSettings;
use eos_core::experience::Embedder;
use eos_mod_memory::{EmbedderHealth, LoadEmbedder, MemoryModule, MemoryParts};
use eos_runtime::module::Module;
use eos_testkit::{FakeClock, FakeEmbedder, TempStore};

fn module(temp: &TempStore, embedder: Option<LoadEmbedder>) -> MemoryModule {
    MemoryModule::new(MemoryParts {
        store: temp.port(),
        clock: Arc::new(FakeClock::new()),
        embedder,
        background_model_calls: false,
    })
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
