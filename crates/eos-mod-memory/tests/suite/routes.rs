//! Memory's routes over the composed router: the screen's head, a page of
//! notes and one note, the user's edits, forgetting and bringing back, "Not
//! right", what a chat was reminded of, and the switches.

use std::sync::Arc;

use eos_contracts::UserMemory;
use eos_core::store::{StoredEvidence, StoredHook, StoredLink, StoredStated, StoredUse};
use eos_domain::experience::{HookKind, Note, NoteBody, NoteKind, NoteState, Scope, ScopeLevel, Trust, hook_id};
use eos_mod_memory::MemoryModule;
use eos_runtime::access::Caller;
use eos_runtime::http::{Method, Request};
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_testkit::{FakeClock, FakeSleeper, TempStore};
use serde_json::{Value, json};

use crate::rig::{AboutYou, parts};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

struct Api {
    runtime: Runtime,
    temp: TempStore,
    clock: Arc<FakeClock>,
}

fn note(id: &str, text: &str, scope: Scope, kind: NoteKind) -> Note {
    Note {
        id: id.into(),
        kind,
        text: text.into(),
        body: NoteBody::Lesson {
            situation: "An agent is about to push.".into(),
            wrong: String::new(),
            instead: String::new(),
        },
        trust: Trust::Did,
        state: NoteState::Trying,
        scope,
        valid_from: 0,
        valid_to: None,
        replaced_by: None,
        do_hooks: vec![],
        avoid_hooks: vec![],
        created_at: FakeClock::START_MS - DAY_MS,
        updated_at: FakeClock::START_MS - DAY_MS,
        device: "mac-a".into(),
    }
}

impl Api {
    async fn new() -> Self {
        let kernel = Kernel::new(KernelOptions::default());
        let temp = TempStore::on_bus(&kernel.bus);
        let clock = Arc::new(FakeClock::new());
        let mut parts = parts(&temp, Arc::new(FakeSleeper::default()), None);
        parts.clock = clock.clone();
        let about: UserMemory = serde_json::from_value(json!({
            "id": "um-1", "text": "Prefers short reviews", "category": "work-style", "scope": {"kind": "global"},
            "tier": "always", "status": "active", "source": {"kind": "user"}, "rev": 1, "createdAt": 1, "updatedAt": 1
        }))
        .unwrap();
        parts.memories = Arc::new(AboutYou(std::sync::Mutex::new(vec![Arc::new(about)])));
        let runtime = Runtime::build(kernel, vec![Arc::new(MemoryModule::new(parts))], Arc::new(AllPluginsOn)).unwrap();
        assert_eq!(runtime.router.undeclared(), Vec::<String>::new());
        Self { runtime, temp, clock }
    }

    async fn ask(&self, method: Method, path: &str, body: Option<Value>) -> (u16, Value) {
        let mut request = Request::new(method, path, Caller::DASHBOARD);
        if let Some(body) = body {
            request = request.body(body.to_string());
        }
        let response = self.runtime.router.handle(request).await;
        let status = response.status;
        let bytes = response.body.collect().await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    /// A lint lesson in `/repo`'s project about `git push`, taught by an edit,
    /// and a fact for everywhere.
    fn seed(&self) {
        self.temp
            .store
            .write_blocking(|tx, _| {
                let project = Scope { level: ScopeLevel::Project, key: "key:/repo".into() };
                tx.mem_notes()
                    .insert(&note("mn-1", "Run lint before pushing.", project, NoteKind::Lesson), "git push")?;
                tx.mem_notes()
                    .insert(&note("mn-2", "sed -i needs an empty suffix.", Scope::everywhere(), NoteKind::Fact), "")?;
                let hook = hook_id(HookKind::Command, "git push");
                tx.mem_graph().add_hook(&StoredHook {
                    id: hook.clone(),
                    kind: HookKind::Command,
                    key: "git push".into(),
                    label: String::new(),
                    degree: 1,
                })?;
                let link = |a: &str, b: &str, rel: &str| StoredLink {
                    a: a.into(),
                    b: b.into(),
                    rel: rel.into(),
                    weight: 1.0,
                    co_uses: 0,
                    updated_at: 0,
                };
                tx.mem_graph().put_link(&link("mn-1", &hook, "about"))?;
                tx.mem_graph().put_link(&link("mn-1", "mn-2", "seen_together"))?;
                tx.mem_evidence().insert(&StoredEvidence {
                    id: "me-1".into(),
                    note_id: "mn-1".into(),
                    kind: "edits".into(),
                    summary: "A push failed, lint fixed it.".into(),
                    worker_id: Some("w-1".into()),
                    row_from: Some(1),
                    row_to: Some(2),
                    run_id: None,
                    at: 5,
                    device: "mac-a".into(),
                })?;
                tx.mem_uses().insert(&StoredUse {
                    id: "me-2".into(),
                    note_id: "mn-1".into(),
                    worker_id: Some("w-1".into()),
                    run_id: None,
                    how: "reminder".into(),
                    epoch: 0,
                    at: 7,
                    acted: false,
                    outcome: None,
                })?;
                tx.mem_book().put_stated(&StoredStated {
                    memory_id: "um-1".into(),
                    worker_id: "w-1".into(),
                    row_id: 3,
                    at: FakeClock::START_MS,
                })
            })
            .unwrap();
    }
}

#[tokio::test]
async fn the_summary_counts_about_you_what_was_learned_and_this_week() {
    let api = Api::new().await;
    api.seed();
    let (status, body) = api.ask(Method::Get, "/api/memory/summary", None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["aboutYou"], 1);
    assert_eq!(body["learned"], 2);
    assert_eq!(body["weekly"], 3, "two notes and one stated rule");
    assert_eq!(body["kinds"], json!({"fact": 1, "lesson": 1}));
    assert_eq!(body["scopes"].as_array().unwrap().len(), 2);
    assert_eq!(body["health"], json!({"embedder": "off", "pendingMoments": 0, "learning": true, "reminders": true}));
}

#[tokio::test]
async fn a_note_lists_and_opens_with_what_taught_it_and_what_it_is_about() {
    let api = Api::new().await;
    api.seed();
    let (status, page) = api.ask(Method::Get, "/api/memory/notes?scope=project&limit=10", None).await;
    assert_eq!(status, 200, "{page}");
    let rows = page["notes"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["why"], "A push failed, lint fixed it.");
    assert_eq!(rows[0]["source"], "edits");
    assert_eq!(rows[0]["scope"], json!({"level": "project", "key": "key:/repo", "label": "key:/repo"}));
    let (_, page) = api.ask(Method::Get, "/api/memory/notes?limit=1", None).await;
    assert!(page["nextCursor"].is_string());
    let (status, _) = api.ask(Method::Get, "/api/memory/notes?kind=nonsense", None).await;
    assert_eq!(status, 400);

    let (status, detail) = api.ask(Method::Get, "/api/memory/notes/mn-1", None).await;
    assert_eq!(status, 200, "{detail}");
    assert_eq!(detail["connectedTo"], json!([{"kind": "command", "label": "git push"}]));
    assert_eq!(detail["nextTo"][0]["id"], "mn-2");
    assert_eq!(detail["learnedFrom"], json!([{"at": 5, "text": "A push failed, lint fixed it."}]));
    assert_eq!(detail["comesBackWhen"]["situation"], "An agent is about to push.");
    assert_eq!(detail["help"]["recalled"], 1);
    assert_eq!(api.ask(Method::Get, "/api/memory/notes/mn-none", None).await.0, 404);
}

#[tokio::test]
async fn the_user_edits_a_note_on_its_revision_and_nothing_secret_is_kept() {
    let api = Api::new().await;
    api.seed();
    let (status, body) = api.ask(Method::Put, "/api/memory/notes/mn-1", Some(json!({"text": "x", "baseRev": 7}))).await;
    assert_eq!((status, body["error"].as_str()), (409, Some("changed")));
    let secret = json!({"text": "Use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 to push.", "baseRev": 1});
    assert_eq!(api.ask(Method::Put, "/api/memory/notes/mn-1", Some(secret)).await.0, 400);
    let edit = json!({"text": "Lint /Users/someone/repo first.", "scope": {"level": "everywhere"}, "baseRev": 1});
    let (status, body) = api.ask(Method::Put, "/api/memory/notes/mn-1", Some(edit)).await;
    assert_eq!(status, 200, "{body}");
    assert!(!body["note"]["text"].as_str().unwrap().contains("someone"), "{body}");
    assert_eq!(body["note"]["scope"]["level"], "everywhere");
    assert_eq!(body["note"]["rev"], 2);
    assert_eq!(body["versions"][0]["why"], "edited");
    assert!(api.temp.announced.list().iter().any(|(t, p)| *t == "memory:change" && p.contains("changed")));
}

#[tokio::test]
async fn a_forgotten_note_leaves_the_list_and_comes_back_within_thirty_days() {
    let api = Api::new().await;
    api.seed();
    let (status, body) = api.ask(Method::Delete, "/api/memory/notes/mn-1", None).await;
    assert_eq!(status, 200);
    assert!(body["note"]["forgottenAt"].is_number());
    let (_, page) = api.ask(Method::Get, "/api/memory/notes", None).await;
    assert!(page["notes"].as_array().unwrap().iter().all(|n| n["id"] != "mn-1"));
    let (_, forgotten) = api.ask(Method::Get, "/api/memory/notes?forgotten=true", None).await;
    assert!(forgotten["notes"].as_array().unwrap().iter().any(|n| n["id"] == "mn-1"));
    assert_eq!(api.temp.count("SELECT COUNT(*) FROM mem_forgotten"), 1);

    let (status, body) = api.ask(Method::Post, "/api/memory/notes/mn-1/restore", None).await;
    assert_eq!(status, 200, "{body}");
    assert!(body["note"]["forgottenAt"].is_null());
    assert_eq!(body["versions"][0]["why"], "restored");

    api.ask(Method::Delete, "/api/memory/notes/mn-1", None).await;
    api.clock.advance(31 * DAY_MS);
    let (status, body) = api.ask(Method::Post, "/api/memory/notes/mn-1/restore", None).await;
    assert_eq!((status, body["error"].as_str()), (409, Some("too_late")));
    assert_eq!(api.ask(Method::Post, "/api/memory/notes/mn-2/restore", None).await.0, 404, "not forgotten");
}

#[tokio::test]
async fn not_right_hurts_the_note_and_keeps_what_the_user_said() {
    let api = Api::new().await;
    api.seed();
    let said = json!({"workerId": "w-1", "note": "Lint is not set up here."});
    let (status, body) = api.ask(Method::Post, "/api/memory/notes/mn-1/not-right", Some(said)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["help"]["hurt"], 1);
    assert_eq!(api.temp.count("SELECT COUNT(*) FROM mem_evidence WHERE kind = 'not_right'"), 1);
    assert_eq!(api.ask(Method::Post, "/api/memory/notes/mn-none/not-right", None).await.0, 404);
}

#[tokio::test]
async fn what_a_chat_was_reminded_of_where_rules_were_said_and_the_switches() {
    let api = Api::new().await;
    api.seed();
    let (status, body) = api.ask(Method::Get, "/api/memory/recalled?workerId=w-1", None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["notes"][0]["row"]["id"], "mn-1");
    assert_eq!(body["notes"][0]["how"], "reminder");
    assert_eq!(api.ask(Method::Get, "/api/memory/recalled", None).await.0, 400);

    let (_, stated) = api.ask(Method::Get, "/api/memory/stated", None).await;
    assert_eq!(stated["rules"][0]["memoryId"], "um-1");

    let off = json!({"learning": false, "reminders": true});
    assert_eq!(api.ask(Method::Put, "/api/memory/settings", Some(off.clone())).await, (200, off.clone()));
    assert_eq!(api.ask(Method::Get, "/api/memory/settings", None).await, (200, off));
    let (status, _) = api.ask(Method::Post, "/api/memory/tidy", None).await;
    assert_eq!(status, 409, "no tidying where reflection is not composed");
}
