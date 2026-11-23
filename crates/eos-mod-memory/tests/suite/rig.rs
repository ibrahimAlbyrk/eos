//! The module over the real store, with a chat `w-1` in `/repo`, fakes for
//! the sessions notes go to, project keys and the profile, and notes written
//! straight into the store.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use eos_contracts::{NameSource, UserMemory, UserProfile};
use eos_core::BoxFuture;
use eos_core::git::ProjectKeys;
use eos_core::profile::{UserMemoryReader, UserProfileReader};
use eos_core::store::{NewWorker, StoredHook, StoredLink};
use eos_domain::experience::{HookKind, Note, NoteBody, NoteKind, NoteState, Scope, ScopeLevel, Trust, hook_id};
use eos_domain::user_profile::empty_user_profile;
use eos_mod_memory::{LoadEmbedder, MemoryModule, MemoryParts, NoteSink};
use eos_testkit::{FakeClock, FakeSleeper, SeqIds, TempStore};

#[derive(Default)]
pub(crate) struct Sink(pub(crate) Mutex<Vec<(String, String)>>);

impl NoteSink for Sink {
    fn note(&self, worker_id: &str, text: String) -> bool {
        self.0.lock().unwrap().push((worker_id.to_owned(), text));
        true
    }
}

pub(crate) struct Keys;

impl ProjectKeys for Keys {
    fn to_key<'a>(&'a self, path: &'a str) -> BoxFuture<'a, String> {
        Box::pin(std::future::ready(format!("key:{path}")))
    }
    fn to_path<'a>(&'a self, _key: &'a str, hint: &'a str) -> BoxFuture<'a, String> {
        Box::pin(std::future::ready(hint.to_owned()))
    }
    fn find_path<'a>(&'a self, _key: &'a str) -> BoxFuture<'a, Option<String>> {
        Box::pin(std::future::ready(None))
    }
}

pub(crate) struct Profile(pub(crate) Mutex<UserProfile>);

impl UserProfileReader for Profile {
    fn get(&self) -> Arc<UserProfile> {
        Arc::new(self.0.lock().unwrap().clone())
    }
}

/// About you, as the test fills it.
#[derive(Default)]
pub(crate) struct AboutYou(pub(crate) Mutex<Vec<Arc<UserMemory>>>);

impl UserMemoryReader for AboutYou {
    fn list(&self) -> Vec<Arc<UserMemory>> {
        self.0.lock().unwrap().clone()
    }

    fn search(&self, _query: &str, _project: Option<&str>, _limit: usize) -> Vec<Arc<UserMemory>> {
        Vec::new()
    }
}

pub(crate) struct Rig {
    pub(crate) temp: TempStore,
    pub(crate) memory: MemoryModule,
    pub(crate) sink: Arc<Sink>,
    pub(crate) profile: Arc<Profile>,
}

fn worker(id: &str, backend_kind: &str) -> NewWorker {
    NewWorker {
        id: id.into(),
        prompt: "Work.".into(),
        cwd: Some("/repo".into()),
        worktree_from: None,
        branch: None,
        name: None,
        name_source: NameSource::Default,
        pid: None,
        port: 0,
        started_at: 1,
        parent_id: None,
        model: "sonnet".into(),
        effort: None,
        is_orchestrator: false,
        backend_kind: backend_kind.into(),
        backend_profile: None,
        agent_role: None,
        worker_definition: None,
        tool_scope: None,
        with_gateway: false,
        collaborate: false,
        worktree_dir: None,
        workspace_owner_id: None,
        workspace_ready: true,
        scratch: false,
    }
}

/// The module's parts over `temp`, with fakes for the rest.
pub(crate) fn parts(temp: &TempStore, sleeper: Arc<FakeSleeper>, embedder: Option<LoadEmbedder>) -> MemoryParts {
    MemoryParts {
        store: temp.port(),
        clock: Arc::new(FakeClock::new()),
        sleeper,
        ids: Arc::new(SeqIds::new()),
        runs: None,
        replays: None,
        sink: Arc::new(Sink::default()),
        project_keys: Arc::new(Keys),
        profile: Arc::new(Profile(Mutex::new(empty_user_profile()))),
        embedder,
        code: None,
        edits: None,
        learn: None,
        memories: Arc::new(AboutYou::default()),
        home: Some("/Users/someone".into()),
        device: "mac-a".into(),
        background_model_calls: false,
    }
}

impl Rig {
    pub(crate) fn new() -> Self {
        let temp = TempStore::new();
        temp.store
            .write_blocking(|tx, _| {
                tx.workers().insert(&worker("w-1", "claude"))?;
                tx.workers().insert(&worker("w-gpt", "openai"))
            })
            .unwrap();
        let sink = Arc::new(Sink::default());
        let profile = Arc::new(Profile(Mutex::new(empty_user_profile())));
        let mut parts = parts(&temp, Arc::new(FakeSleeper::default()), None);
        parts.sink = sink.clone();
        parts.profile = profile.clone();
        let memory = MemoryModule::new(parts);
        Self { temp, memory, sink, profile }
    }

    /// A firm note the user gave, in `/repo`'s project, about `command`.
    pub(crate) fn note_about(&self, id: &str, text: &str, command: &str) {
        let note = Note {
            id: id.into(),
            kind: NoteKind::Lesson,
            text: text.into(),
            body: NoteBody::None {},
            trust: Trust::Said,
            state: NoteState::Firm,
            scope: Scope { level: ScopeLevel::Project, key: "key:/repo".into() },
            valid_from: 0,
            valid_to: None,
            replaced_by: None,
            do_hooks: vec![],
            avoid_hooks: vec![],
            created_at: FakeClock::START_MS - 1_000,
            updated_at: FakeClock::START_MS - 1_000,
            device: "mac-a".into(),
        };
        let command = command.to_owned();
        self.temp
            .store
            .write_blocking(move |tx, _| {
                tx.mem_notes().insert(&note, &command)?;
                let hook = hook_id(HookKind::Command, &command);
                tx.mem_graph().add_hook(&StoredHook {
                    id: hook.clone(),
                    kind: HookKind::Command,
                    key: command.clone(),
                    label: String::new(),
                    degree: 0,
                })?;
                tx.mem_graph().put_link(&StoredLink {
                    a: note.id.clone(),
                    b: hook,
                    rel: "about".into(),
                    weight: 1.0,
                    co_uses: 0,
                    updated_at: 0,
                })
            })
            .unwrap();
    }

    pub(crate) fn uses(&self) -> i64 {
        self.temp.count("SELECT COUNT(*) FROM mem_uses")
    }

    /// The reminders handed to sessions, once at least `want` came.
    pub(crate) async fn reminded(&self, want: usize) -> Vec<(String, String)> {
        for _ in 0..200 {
            let got = self.sink.0.lock().unwrap().clone();
            if got.len() >= want {
                return got;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        self.sink.0.lock().unwrap().clone()
    }
}
