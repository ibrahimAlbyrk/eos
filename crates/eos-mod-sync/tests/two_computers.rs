//! Two computers, one relay: real services, real files, real crypto and the
//! vault over HTTP. What Eos learned travels too: memory's notes over real stores.

#![allow(clippy::unwrap_used)]

mod support;

use std::sync::Arc;
use std::time::Duration;

use eos_core::experience::ExperienceSync;
use eos_domain::experience::{Note, NoteBody, NoteKind, NoteState, Scope, ScopeLevel, Trust};
use eos_mod_memory::{MemoryModule, MemoryParts, NoteSink};
use eos_mod_sync::domains::ExperienceDomain;
use eos_runtime::module::Module;
use eos_testkit::{FakeClock, FakeSleeper, SeqIds, TempStore};

use eos_contracts::{PageAuthor, SyncPhase, UserMemoryCategory, UserMemoryScope, UserMemoryTier, UserProfilePatch};
use eos_mod_pages::NewPage;
use eos_mod_profile::{MemoryInput, MemoryPatch};
use eos_testkit::vault::{FakeVault, ServedVault, VaultLimits};
use serde_json::json;
use support::{Mac, PathKeys, fast, until};
use tokio::sync::Notify;

async fn relay() -> (Arc<FakeVault>, ServedVault) {
    let vault = FakeVault::new(VaultLimits::default());
    let served = vault.serve().await;
    (vault, served)
}

fn patch(value: serde_json::Value) -> UserProfilePatch {
    serde_json::from_value(value).unwrap()
}

fn memory(text: &str) -> MemoryInput {
    MemoryInput {
        text: text.into(),
        category: UserMemoryCategory::Stack,
        domain: None,
        scope: UserMemoryScope::Global,
        tier: UserMemoryTier::Always,
    }
}

fn user() -> PageAuthor {
    serde_json::from_value(json!({ "kind": "user", "agentId": null, "name": null })).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_joined_computer_gets_everything_and_edits_flow_both_ways_live() {
    let (_vault, served) = relay().await;
    let rang = Arc::new(Notify::new());
    let air = Mac::new(Some(served.relay_url()), "air", b'a', &rang).await;
    air.profile
        .update(&patch(json!({ "identity": { "fullName": "Ibrahim" }, "style": { "replies": "terse" } })), None)
        .unwrap();
    let kept = air.memories.create(memory("Prefers pnpm")).unwrap();
    air.pages
        .create(NewPage { title: "Plan".into(), body: "hello".into(), project: None, agent_id: None }, user())
        .unwrap();
    air.sync.create().unwrap();
    until(&rang, "air's first push", || {
        let status = air.sync.status();
        status.counts.get("memory") == Some(&1) && status.phase == SyncPhase::Idle
    })
    .await;

    let pro = Mac::new(None, "pro", b'b', &rang).await;
    pro.profile.update(&patch(json!({ "style": { "replies": "thorough" } })), None).unwrap();
    pro.memories.create(memory("Works on Unity")).unwrap();
    pro.sync.join(&air.sync.key().unwrap()).unwrap();
    until(&rang, "pro catching up", || pro.memories.list().len() == 2 && pro.pages.list(None, None).len() == 1).await;
    until(&rang, "pro's profile", || pro.profile.get().identity.full_name == "Ibrahim").await;
    let style = serde_json::to_value(&pro.profile.get().style).unwrap();
    assert_eq!(style["replies"], "terse", "joining adopts the account's profile");
    assert!(pro.home.join("sync/conflicts/profile").is_dir(), "pro's own style is kept aside");

    until(&rang, "air seeing pro's memory", || air.memories.list().len() == 2).await;

    air.clock.advance(1_000);
    let edit = MemoryPatch { text: Some("Prefers pnpm, never npm".into()), ..MemoryPatch::default() };
    air.memories.update(&kept.id.0, edit, None).unwrap();
    until(&rang, "the edit reaching pro", || {
        pro.memories.list().iter().any(|m| m.id == kept.id && m.text == "Prefers pnpm, never npm")
    })
    .await;

    pro.memories.remove(&kept.id.0).unwrap();
    until(&rang, "the delete reaching air", || !air.memories.list().iter().any(|m| m.id == kept.id)).await;

    // Nothing was applied twice or bounced back: both end idle with the same counts.
    until(&rang, "both settling", || {
        let (a, p) = (air.sync.status(), pro.sync.status());
        a.phase == SyncPhase::Idle && p.phase == SyncPhase::Idle && a.counts == p.counts
    })
    .await;
    assert_eq!(pro.sync.status().relay.as_deref(), Some(served.http_base().trim_start_matches("http://")));

    air.sync.stop();
    pro.sync.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_computer_that_was_off_catches_up_when_it_comes_back() {
    let (_vault, served) = relay().await;
    let rang = Arc::new(Notify::new());
    let air = Mac::new(Some(served.relay_url()), "air", b'a', &rang).await;
    air.sync.create().unwrap();
    let pro = Mac::new(None, "pro", b'b', &rang).await;
    pro.sync.join(&air.sync.key().unwrap()).unwrap();
    until(&rang, "both idle", || {
        air.sync.status().phase == SyncPhase::Idle && pro.sync.status().phase == SyncPhase::Idle
    })
    .await;
    pro.sync.stop();

    air.profile.update(&patch(json!({ "language": { "chat": "tr" } })), None).unwrap();
    air.home.write("workers/reviewer.md", "---\nname: reviewer\n---\nReview.\n");
    air.home.write("templates/review.md", "---\ndescription: d\n---\n\nbody\n");
    air.home.write("templates/assets/review/shot.png", [1u8, 2, 3]);
    air.sync.sync_now();
    until(&rang, "air pushing", || {
        let counts = air.sync.status().counts;
        counts.get("worker") == Some(&1) && counts.get("profile") == Some(&1) && counts.get("template") == Some(&1)
    })
    .await;
    air.sync.stop();

    // The app starts again: it resumes the account from its identity file.
    pro.sync.start();
    until(&rang, "pro catching up", || {
        pro.profile.get().language.chat.as_ref().is_some_and(|l| l.0 == "tr")
            && pro.home.join("workers/reviewer.md").exists()
    })
    .await;
    assert_eq!(pro.home.read("templates/review.md"), "---\ndescription: d\n---\n\nbody\n");
    assert_eq!(std::fs::read(pro.home.join("templates/assets/review/shot.png")).unwrap(), [1, 2, 3]);
    pro.sync.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_to_create_without_a_relay_and_to_join_with_a_bad_key_and_leaving_keeps_the_data() {
    let rang = Arc::new(Notify::new());
    let lone = Mac::new(None, "lone", b'c', &rang).await;
    assert_eq!(lone.sync.create().unwrap_err().to_string(), "set up a relay first (Settings › Remote)");
    assert_eq!(lone.sync.join("eos-sync1.nope.nope").unwrap_err().to_string(), "that isn't a sync key");
    assert_eq!(lone.sync.status().phase, SyncPhase::Off);

    let (_vault, served) = relay().await;
    let air = Mac::new(Some(served.relay_url()), "air", b'a', &rang).await;
    air.memories.create(memory("x")).unwrap();
    air.sync.create().unwrap();
    assert!(air.sync.key().is_some());
    assert!(air.home.join("sync/identity.json").is_file());
    until(&rang, "the first pass", || air.home.join("sync/state.json").is_file()).await;

    let status = air.sync.leave().unwrap();
    assert_eq!(status.phase, SyncPhase::Off);
    assert_eq!(
        serde_json::to_value(&status).unwrap(),
        json!({ "phase": "off", "relay": null, "lastSyncAt": null, "error": null, "counts": {} })
    );
    assert_eq!(air.sync.key(), None);
    assert_eq!(air.memories.list().len(), 1);
    assert!(!air.home.join("sync/identity.json").exists(), "the key is gone from this computer");
    assert!(!air.home.join("sync/state.json").exists(), "the next account starts from an empty index");
}

#[tokio::test(flavor = "multi_thread")]
async fn what_the_vault_holds_is_sealed() {
    let (vault, served) = relay().await;
    let rang = Arc::new(Notify::new());
    let air = Mac::new(Some(served.relay_url()), "air", b'a', &rang).await;
    air.memories.create(memory("Prefers pnpm")).unwrap();
    air.sync.create().unwrap();
    until(&rang, "the push", || air.sync.status().counts.get("memory") == Some(&1)).await;
    let identity = eos_domain::sync::parse_sync_key(&air.sync.key().unwrap()).unwrap();
    let keys = eos_domain::sync::SyncKeys::derive(&identity.secret);
    let records = vault.records(&keys.vault_id);
    assert_eq!(records.len(), 1);
    assert!(!String::from_utf8_lossy(&records[0].data).contains("pnpm"), "the relay sees no content");
    assert_eq!(records[0].key.len(), 64, "nor the record's id");
    // The same key opens it: the envelope a TypeScript computer would read.
    let envelope: serde_json::Value =
        serde_json::from_slice(&keys.open(&records[0].key, &records[0].data).unwrap()).unwrap();
    assert_eq!(envelope["v"], 1);
    assert_eq!(envelope["domain"], "memory");
    assert_eq!(envelope["device"], "air");
    assert_eq!(envelope["data"]["text"], "Prefers pnpm");
    assert_eq!(envelope["data"]["scope"], json!({ "kind": "global" }));
    assert!(envelope["data"].get("rev").is_none() && envelope["data"].get("id").is_none());
    air.sync.stop();
}

/// Reminders go nowhere: no chat runs here.
struct NoSink;

impl NoteSink for NoSink {
    fn note(&self, _worker_id: &str, _text: String) -> bool {
        false
    }
}

/// Memory on its own store, and the sync domain over it.
fn experience(mac: &Mac, temp: &TempStore, device: &str) -> Arc<ExperienceDomain> {
    let module = MemoryModule::new(MemoryParts {
        store: temp.port(),
        clock: Arc::new(FakeClock::new()),
        sleeper: Arc::new(FakeSleeper::default()),
        ids: Arc::new(SeqIds::new()),
        runs: None,
        replays: None,
        sink: Arc::new(NoSink),
        project_keys: Arc::new(PathKeys),
        profile: mac.profile.clone(),
        embedder: None,
        code: None,
        edits: None,
        learn: None,
        memories: mac.memories.clone(),
        home: None,
        device: device.into(),
        background_model_calls: false,
    });
    let handle = module.sync().remove(0).handle;
    let sync = handle.downcast::<Arc<dyn ExperienceSync>>().unwrap();
    Arc::new(ExperienceDomain::new((*sync).clone()))
}

fn lesson(text: &str, at: i64) -> Note {
    Note {
        id: "mn-push".into(),
        kind: NoteKind::Lesson,
        text: text.into(),
        body: NoteBody::None {},
        trust: Trust::Said,
        state: NoteState::Firm,
        scope: Scope { level: ScopeLevel::Routine, key: "rt-review".into() },
        valid_from: 0,
        valid_to: None,
        replaced_by: None,
        do_hooks: vec![],
        avoid_hooks: vec![],
        created_at: at,
        updated_at: at,
        device: "air".into(),
    }
}

fn text_of(temp: &TempStore) -> Option<String> {
    temp.store.read_blocking(|tx| tx.mem_notes().find("mn-push")).unwrap().map(|n| n.note.text)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_note_learned_on_one_computer_reaches_the_other_and_its_edit_comes_back() {
    let (_vault, served) = relay().await;
    let rang = Arc::new(Notify::new());
    // The experience domain is swept, not announced: sweep often.
    let timing = || eos_mod_sync::Timing { sweep: Duration::from_millis(100), ..fast() };
    let (air_store, pro_store) = (TempStore::new(), TempStore::new());
    // Memory reads About you from a computer of its own; the two that sync carry its domain.
    let air_shell = Mac::new(None, "air-shell", b'c', &rang).await;
    let pro_shell = Mac::new(None, "pro-shell", b'd', &rang).await;
    let air_domain = experience(&air_shell, &air_store, "air");
    let pro_domain = experience(&pro_shell, &pro_store, "pro");
    let air = Mac::with(Some(served.relay_url()), "air", b'a', &rang, timing(), vec![air_domain]).await;
    let start = FakeClock::START_MS;
    air_store
        .store
        .write_blocking(move |tx, _| tx.mem_notes().insert(&lesson("Keep the summary short.", start), "").map(drop))
        .unwrap();
    air.sync.create().unwrap();
    let pro = Mac::with(None, "pro", b'b', &rang, timing(), vec![pro_domain]).await;
    pro.sync.join(&air.sync.key().unwrap()).unwrap();

    let reached = || text_of(&pro_store).as_deref() == Some("Keep the summary short.");
    until(&rang, "the note reaching pro", reached).await;
    let arrived = pro_store.store.read_blocking(|tx| tx.mem_notes().find("mn-push")).unwrap().unwrap();
    assert_eq!(arrived.note.scope, Scope { level: ScopeLevel::Routine, key: "rt-review".into() });

    // Pro edits it later; air takes the newer text.
    let edited =
        Note { text: "Keep the summary to three lines.".into(), device: "pro".into(), ..lesson("", start + 60_000) };
    let rev = arrived.rev + 1;
    pro_store.store.write_blocking(move |tx, _| tx.mem_notes().update(&edited, "", rev)).unwrap();
    pro.sync.sync_now();
    let back = || text_of(&air_store).as_deref() == Some("Keep the summary to three lines.");
    until(&rang, "the edit reaching air", back).await;
    until(&rang, "both settling", || {
        air.sync.status().phase == SyncPhase::Idle && pro.sync.status().phase == SyncPhase::Idle
    })
    .await;
    assert_eq!(text_of(&pro_store), text_of(&air_store));
    air.sync.stop();
    pro.sync.stop();
}
