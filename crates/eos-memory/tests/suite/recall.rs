//! Recall: notes come back by their hooks, words and meaning, linked notes
//! by spreading, only where their scope applies, and a pack holds the best.

use std::sync::Arc;

use eos_domain::experience::HookKind;
use eos_domain::experience::Scope;
use eos_memory::{Cues, Recall, Situation, chat_pack};
use eos_testkit::{FakeClock, FakeEmbedder, TempStore};

use crate::notes::{cue, link, note, project, put, routine};

fn ids(recalled: &[eos_memory::Recalled]) -> Vec<String> {
    recalled.iter().map(|r| r.note.note.id.clone()).collect()
}

fn in_project(key: &str) -> Situation {
    Situation { project: Some(key.into()), ..Situation::default() }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn notes_come_back_by_their_hooks_and_their_words() {
    let temp = TempStore::new();
    put(
        &temp,
        note("mn-lint", "Run npm run lint before pushing.", project("game")),
        &[cue(HookKind::Command, "git push")],
    );
    put(
        &temp,
        note("mn-tpl", "Generated assets are rebuilt from templates.", Scope::everywhere()),
        &[cue(HookKind::Path, "Assets/Generated")],
    );
    let recall = Recall::new(temp.port(), Arc::new(FakeClock::new()));

    let by_hook = recall
        .recall(&in_project("game"), &Cues { hooks: vec![cue(HookKind::Command, "git push")], query: None }, 6)
        .await
        .expect("recalls");
    assert_eq!(ids(&by_hook), ["mn-lint"]);
    assert!(by_hook[0].score > 0.4);

    let by_words = recall
        .recall(&in_project("game"), &Cues { hooks: vec![], query: Some("templates".into()) }, 6)
        .await
        .expect("recalls");
    assert_eq!(ids(&by_words), ["mn-tpl"]);

    let nothing = recall.recall(&in_project("game"), &Cues::default(), 6).await.expect("recalls");
    assert!(nothing.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_note_applies_only_where_its_scope_does() {
    let temp = TempStore::new();
    let push = cue(HookKind::Command, "git push");
    put(&temp, note("mn-game", "game only", project("game")), std::slice::from_ref(&push));
    put(&temp, note("mn-review", "the PR review routine's own", routine("rt-review")), std::slice::from_ref(&push));
    put(&temp, note("mn-all", "everywhere", Scope::everywhere()), std::slice::from_ref(&push));
    let git = Scope { level: eos_domain::experience::ScopeLevel::Work, key: "git".into() };
    put(&temp, note("mn-git", "git work only", git), std::slice::from_ref(&push));
    let recall = Recall::new(temp.port(), Arc::new(FakeClock::new()));
    let cues = Cues { hooks: vec![push], query: None };

    let mut chat = ids(&recall.recall(&in_project("web"), &cues, 6).await.expect("recalls"));
    chat.sort();
    assert_eq!(chat, ["mn-all"], "another project's and a routine's notes stay out of a chat");
    let run = Situation { routine: Some("rt-review".into()), project: Some("game".into()), work_kind: None };
    let got = ids(&recall.recall(&run, &cues, 6).await.expect("recalls"));
    assert_eq!(got[0], "mn-review", "the narrowest scope ranks first");
    assert_eq!(got.len(), 3, "a kind of work's note stays out where the kind is not known");
    let at_git = Situation { work_kind: Some("git".into()), ..in_project("web") };
    let mut git_work = ids(&recall.recall(&at_git, &cues, 6).await.expect("recalls"));
    git_work.sort();
    assert_eq!(git_work, ["mn-all", "mn-git"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_linked_note_comes_back_by_spreading_and_forgotten_or_replaced_notes_never() {
    let temp = TempStore::new();
    put(&temp, note("mn-a", "Push needs a lint first.", Scope::everywhere()), &[cue(HookKind::Command, "git push")]);
    put(&temp, note("mn-b", "The linter config lives in .eslintrc.", Scope::everywhere()), &[]);
    let mut old = note("mn-old", "Push with --force.", Scope::everywhere());
    old.replaced_by = Some("mn-a".into());
    put(&temp, old, &[cue(HookKind::Command, "git push")]);
    put(&temp, note("mn-gone", "Forgotten.", Scope::everywhere()), &[cue(HookKind::Command, "git push")]);
    temp.store
        .write_blocking(|tx, _| {
            tx.mem_graph().put_link(&link("mn-a", "mn-b", "because"))?;
            tx.mem_notes().set_forgotten("mn-gone", Some(1))
        })
        .expect("writes");
    let recall = Recall::new(temp.port(), Arc::new(FakeClock::new()));
    let got = recall
        .recall(&Situation::default(), &Cues { hooks: vec![cue(HookKind::Command, "git push")], query: None }, 6)
        .await
        .expect("recalls");
    assert_eq!(ids(&got), ["mn-a", "mn-b"]);
    assert!(got[0].score > got[1].score, "matched beats reached");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_search_by_meaning_starts_once_a_model_is_there_and_embeds_what_waits() {
    let temp = TempStore::new();
    put(&temp, note("mn-pnpm", "Install packages with pnpm in this repository.", Scope::everywhere()), &[]);
    put(&temp, note("mn-other", "Commit messages are in English.", Scope::everywhere()), &[]);
    let recall = Recall::new(temp.port(), Arc::new(FakeClock::new()));
    // Words that are not in the note's text: only meaning finds it.
    let cues = Cues { hooks: vec![], query: Some("which packages tool pnpm".into()) };
    let embedder = Arc::new(FakeEmbedder::new());
    assert!(!recall.meaning_ready());
    recall.with_meaning(embedder.clone()).await.expect("on");
    assert_eq!(recall.embed_missing().await.expect("embeds"), 2);
    assert_eq!(recall.embed_missing().await.expect("embeds"), 0, "every note has its vector");
    let got = recall.recall(&Situation::default(), &cues, 1).await.expect("recalls");
    assert_eq!(ids(&got), ["mn-pnpm"]);

    // A fresh start reads the stored vectors: nothing is embedded again.
    let again = Recall::new(temp.port(), Arc::new(FakeClock::new()));
    again.with_meaning(embedder.clone()).await.expect("on");
    assert_eq!(again.embed_missing().await.expect("embeds"), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_chat_pack_holds_the_best_notes_within_its_budget() {
    let temp = TempStore::new();
    let push = cue(HookKind::Command, "git push");
    for i in 0..20 {
        let text = format!("Note number {i} about pushing, long enough to take its share of the pack budget here.");
        put(&temp, note(&format!("mn-{i:02}"), &text, Scope::everywhere()), std::slice::from_ref(&push));
    }
    let recall = Recall::new(temp.port(), Arc::new(FakeClock::new()));
    let got =
        recall.recall(&Situation::default(), &Cues { hooks: vec![push], query: None }, 20).await.expect("recalls");
    let pack = chat_pack(&got).expect("a pack");
    assert!(pack.note_ids.len() < 20 && !pack.note_ids.is_empty());
    assert!(pack.tokens <= 400 + 40, "about the budget: {}", pack.tokens);
    assert!(pack.text.starts_with("<system-reminder>\nEos memory:"));
    assert!(chat_pack(&[]).is_none(), "no notes, no pack");
}
