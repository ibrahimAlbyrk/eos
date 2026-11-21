//! The recall eval: 300 invented situations over 117 notes of four projects, two routines
//! and everywhere (`tests/data/recall_eval.json`, no user data). Each names the note it
//! should bring back; recall by hooks and words alone must have it in its first three for at
//! least 80% of them. The same eval runs with meaning search on, over the fake embedder and,
//! when `EOS_EMBED_MODEL_DIR` names its folder, the shipped model.

use std::sync::Arc;

use eos_core::experience::Embedder;
use eos_domain::experience::cues::Cue;
use eos_domain::experience::{HookKind, Scope, ScopeLevel};
use eos_memory::{Cues, Recall, Situation};
use eos_testkit::{FakeClock, FakeEmbedder, TempStore, real_embedder};
use serde_json::Value;

use crate::notes::{note, put};

const CORPUS: &str = include_str!("../data/recall_eval.json");
const RECALL_AT_3: f64 = 0.8;

fn cues(list: &Value) -> Vec<Cue> {
    let parse = |hook: &Value| {
        let kind = HookKind::parse(hook["kind"].as_str()?)?;
        Some(Cue { kind, key: hook["key"].as_str()?.to_owned() })
    };
    list.as_array().into_iter().flatten().filter_map(parse).collect()
}

/// recall@3 over the corpus, with meaning search on when an embedder is given, and the
/// expected notes it missed.
async fn recall_at_3(meaning: Option<Arc<dyn Embedder>>) -> (f64, Vec<String>) {
    let corpus: Value = serde_json::from_str(CORPUS).expect("the corpus");
    let temp = TempStore::new();
    for n in corpus["notes"].as_array().expect("notes") {
        let level = ScopeLevel::parse(n["scope"]["level"].as_str().expect("a level")).expect("a known level");
        let scope = Scope { level, key: n["scope"]["key"].as_str().unwrap_or_default().to_owned() };
        let text = n["text"].as_str().expect("a text");
        put(&temp, note(n["id"].as_str().expect("an id"), text, scope), &cues(&n["hooks"]));
    }
    let recall = Recall::new(temp.port(), Arc::new(FakeClock::new()));
    if let Some(embedder) = meaning {
        recall.with_meaning(embedder).await.expect("meaning on");
        while recall.embed_missing().await.expect("embeds") > 0 {}
    }
    let situations = corpus["situations"].as_array().expect("situations");
    let mut found = 0;
    let mut missed = Vec::new();
    for s in situations {
        let place = &s["situation"];
        let situation = Situation {
            project: place["project"].as_str().map(str::to_owned),
            routine: place["routine"].as_str().map(str::to_owned),
            work_kind: None,
        };
        let asked = Cues { hooks: cues(&s["hooks"]), query: s["query"].as_str().map(str::to_owned) };
        let recalled = recall.recall(&situation, &asked, 3).await.expect("recalls");
        let expected = s["expect"].as_str().expect("an expected note");
        if recalled.iter().any(|r| r.note.note.id == expected) {
            found += 1;
        } else {
            missed.push(expected.to_owned());
        }
    }
    (f64::from(found) / situations.len() as f64, missed)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recall_brings_back_the_expected_note_in_its_first_three_for_four_in_five_situations() {
    let (at_3, missed) = recall_at_3(None).await;
    eprintln!("recall@3: {at_3:.3}");
    assert!(at_3 >= RECALL_AT_3, "recall@3 is {at_3:.3}; missed {missed:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recall_with_meaning_search_on_the_fake_embedder_keeps_four_in_five() {
    let (at_3, missed) = recall_at_3(Some(Arc::new(FakeEmbedder::new()))).await;
    eprintln!("recall@3 with the fake embedder: {at_3:.3}");
    assert!(at_3 >= RECALL_AT_3, "recall@3 is {at_3:.3}; missed {missed:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recall_with_meaning_search_on_the_shipped_model_keeps_four_in_five() {
    let Some(embedder) = real_embedder() else {
        eprintln!("skipped: no model folder named");
        return;
    };
    let (at_3, missed) = recall_at_3(Some(embedder)).await;
    eprintln!("recall@3 with the shipped model: {at_3:.3}");
    assert!(at_3 >= RECALL_AT_3, "recall@3 is {at_3:.3}; missed {missed:?}");
}
