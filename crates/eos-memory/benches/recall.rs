//! Recall at full size: `cargo bench -p eos-memory --bench recall`.
//! 50,000 notes on 5,000 hooks, each note about two hooks and linked to one
//! more note, their vectors in memory. Prints p50 and p95 against 04 G5's
//! targets (on an M1: tool cues ≤ 10 ms, message cues ≤ 20 ms, pack ≤ 40 ms
//! at p95). The fake embedder stands in for the model, so a message cue's
//! time leaves out the model's own fraction of a millisecond.

use std::sync::Arc;
use std::time::{Duration, Instant};

use eos_core::store::{StoredHook, StoredLink};
use eos_domain::experience::cues::Cue;
use eos_domain::experience::{HookKind, Note, NoteBody, NoteKind, NoteState, Scope, Trust, hook_id};
use eos_memory::{Cues, Recall, Situation, chat_pack};
use eos_testkit::{FakeClock, FakeEmbedder, TempStore};

const NOTES: u64 = 50_000;
const HOOKS: u64 = 5_000;
const WORDS: u64 = 2_000;
const RUNS: usize = 200;

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

fn word(i: u64) -> String {
    format!("w{i}x")
}

fn hook_key(h: u64) -> String {
    format!("src/area{}/file{h}.rs", h % 50)
}

fn link(a: String, b: String, rel: &str) -> StoredLink {
    StoredLink { a, b, rel: rel.into(), weight: 1.0, co_uses: 0, updated_at: 0 }
}

fn seed(temp: &TempStore) {
    temp.store
        .write_blocking(|tx, _| {
            let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
            for h in 0..HOOKS {
                let key = hook_key(h);
                tx.mem_graph().add_hook(&StoredHook {
                    id: hook_id(HookKind::Path, &key),
                    kind: HookKind::Path,
                    key,
                    label: String::new(),
                    degree: 0,
                })?;
            }
            for n in 0..NOTES {
                let text: Vec<String> = (0..12).map(|_| word(rng.next() % WORDS)).collect();
                let id = format!("mn-{n:012x}");
                let note = Note {
                    id: id.clone(),
                    kind: NoteKind::Lesson,
                    text: text.join(" "),
                    body: NoteBody::None {},
                    trust: Trust::Did,
                    state: NoteState::Firm,
                    scope: Scope::everywhere(),
                    valid_from: 0,
                    valid_to: None,
                    replaced_by: None,
                    do_hooks: vec![],
                    avoid_hooks: vec![],
                    created_at: 0,
                    updated_at: 0,
                    device: "mac".into(),
                };
                tx.mem_notes().insert(&note, "")?;
                for _ in 0..2 {
                    let hook = hook_id(HookKind::Path, &hook_key(rng.next() % HOOKS));
                    tx.mem_graph().put_link(&link(id.clone(), hook, "about"))?;
                }
                let other = format!("mn-{:012x}", rng.next() % NOTES);
                tx.mem_graph().put_link(&link(id.clone(), other, "seen_together"))?;
            }
            Ok(())
        })
        .expect("seeds");
}

fn report(name: &str, mut times: Vec<Duration>, target_ms: u64) {
    times.sort();
    let p = |q: f64| times[((times.len() as f64 * q) as usize).min(times.len() - 1)];
    let p95 = p(0.95);
    let verdict = if p95 <= Duration::from_millis(target_ms) { "ok" } else { "OVER" };
    println!("{name:<14} p50 {:>10.2?}  p95 {:>10.2?}  target {target_ms} ms  {verdict}", p(0.5), p95);
}

fn main() {
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("runtime");
    let temp = TempStore::new();
    let started = Instant::now();
    seed(&temp);
    println!("seeded {NOTES} notes in {:.1?}", started.elapsed());
    let recall = Recall::new(temp.port(), Arc::new(FakeClock::new()));
    runtime.block_on(async {
        recall.with_meaning(Arc::new(FakeEmbedder::new())).await.expect("meaning");
        let started = Instant::now();
        while recall.embed_missing().await.expect("embeds") > 0 {}
        println!("embedded in {:.1?}", started.elapsed());

        let mut rng = Rng(42);
        let situation = Situation::default();
        let (mut tool, mut message, mut pack) = (Vec::new(), Vec::new(), Vec::new());
        for _ in 0..RUNS {
            let hooks = vec![Cue { kind: HookKind::Path, key: hook_key(rng.next() % HOOKS) }];
            let started = Instant::now();
            let got = recall.recall(&situation, &Cues { hooks: hooks.clone(), query: None }, 3).await.expect("recalls");
            tool.push(started.elapsed());
            std::hint::black_box(got);

            let query: Vec<String> = (0..8).map(|_| word(rng.next() % WORDS)).collect();
            let cues = Cues { hooks, query: Some(query.join(" ")) };
            let started = Instant::now();
            let got = recall.recall(&situation, &cues, 3).await.expect("recalls");
            message.push(started.elapsed());
            std::hint::black_box(got);

            let started = Instant::now();
            let got = recall.recall(&situation, &cues, 12).await.expect("recalls");
            std::hint::black_box(chat_pack(&got));
            pack.push(started.elapsed());
        }
        report("tool cue", tool, 10);
        report("message cue", message, 20);
        report("pack", pack, 40);
    });
}
