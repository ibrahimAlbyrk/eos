//! Memory: notes learned from the user's corrections and the work's
//! outcomes, brought back to agents by situation (`eos_memory`).
//!
//! - Topics: `memory:change` (notes learned, changed, forgotten, or their
//!   counts moved) and `memory:recalled` (notes put in front of a model).
//! - The user's Learning and Reminders switches are read from
//!   `mem_settings` ([`eos_memory::settings`]).
//! - `start` loads the meaning model off the async threads: until it is
//!   loaded, or when there is none (a test, a dev run without
//!   `EOS_EMBED_MODEL_DIR`), recall seeds by hooks and words only.
//! - Capture reads a worker's conversation for moments at its idle edge
//!   (idle hook `memory`, order 90, never taking the worker), every ten
//!   minutes while it keeps working, and when its session ends. A Code-view
//!   pane's conversation is read from its Claude Code transcript once it has
//!   been quiet for a minute, and when the pane exits.
//! - Notes reach agents ([`reminders`]): a pack at the first turn of each
//!   epoch of a chat, and reminders when a message, a tool call or an error
//!   matches what was learned.
//! - Moments become notes ([`reflection`]): the small model where the host
//!   allows model calls, the user has a Claude plan and usage is under their
//!   line; the rules elsewhere.
//! - Model work nobody asked for (reflection, night tidying) runs only when
//!   the host lets it ([`MemoryParts::background_model_calls`]).
//!
//! Note text, cues and hook keys are the user's: logged by id, kind and
//! count only.

mod code;
mod hooks;
mod reflection;
mod reminders;

use std::sync::{Arc, Mutex, PoisonError};

use eos_contracts::{AgentEvent, ExperienceChange, ExperienceRecalledEvent, ExperienceSettings};
use std::path::PathBuf;

use eos_core::accounts::PlanAccess;
use eos_core::agent::{CompactionNotice, NoteTurn, OneShot};
use eos_core::experience::{Embedder, ExperienceSearch, FoundNote};
use eos_core::git::ProjectKeys;
use eos_core::os::TimeZone;
use eos_core::profile::{UserMemoryKeeper, UserProfileReader};
use eos_core::routine::RunLookup;
use eos_core::store::Store;
use eos_core::terminal::ClaudeTranscripts;
use eos_core::{BoxFuture, Clock, Error, Ids, Sleeper};
use eos_domain::redact::Scrubber;
use eos_memory::{Capture, Recall, ReflectParts, Reflector};
use eos_prompts::PromptService;
use eos_runtime::bus::{Bus, Topic, TopicDecl};
use eos_runtime::idle::IdleHook;
use eos_runtime::module::{Module, ModuleError};
use tokio::sync::Notify;

use crate::code::CodePanes;
use crate::hooks::Capturer;
use crate::reflection::{LibraryPrompt, Moments, PlanGate, Reflecting};
pub use crate::reminders::NoteSink;
use crate::reminders::Reminders;

pub const MEMORY_CHANGE: Topic<ExperienceChange> = Topic::new("memory:change");
pub const MEMORY_RECALLED: Topic<ExperienceRecalledEvent> = Topic::new(eos_memory::deliver::MEMORY_RECALLED);

/// Loads the meaning model: slow (about 130 MB read), so it runs on a
/// blocking thread.
pub type LoadEmbedder = Box<dyn FnOnce() -> Result<Arc<dyn Embedder>, String> + Send>;

/// Where the meaning model stands, as the Memory screen's health shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbedderHealth {
    Ready,
    Loading,
    Off,
}

impl EmbedderHealth {
    pub fn word(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Loading => "loading",
            Self::Off => "off",
        }
    }
}

/// What Code-view panes are read through: the terminals' events and the
/// user's Claude Code transcripts.
pub struct CodeParts {
    pub bus: Bus,
    pub transcripts: Arc<dyn ClaudeTranscripts>,
}

impl std::fmt::Debug for CodeParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CodeParts").finish_non_exhaustive()
    }
}

/// What reflection asks the model with.
pub struct LearnParts {
    pub one_shot: Arc<dyn OneShot>,
    /// The user's plan sign-ins and how much of the plan is spent.
    pub plan: Arc<dyn PlanAccess>,
    /// The prompt library, for the reflection prompt.
    pub prompts: Arc<PromptService>,
    pub zone: Arc<dyn TimeZone>,
    /// The user's home folder, cut from what is stored.
    pub home: Option<PathBuf>,
    /// This Mac, as notes name the device that wrote them.
    pub device: String,
    /// Where a rule the user states in a chat is kept (About you).
    pub keeper: Arc<dyn UserMemoryKeeper>,
}

impl std::fmt::Debug for LearnParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LearnParts").finish_non_exhaustive()
    }
}

/// What the module is built from.
pub struct MemoryParts {
    pub store: Arc<dyn Store>,
    pub clock: Arc<dyn Clock>,
    pub sleeper: Arc<dyn Sleeper>,
    pub ids: Arc<dyn Ids>,
    /// Which run a worker belongs to, when routines are composed.
    pub runs: Option<Arc<dyn RunLookup>>,
    /// Where reminders are handed to live sessions.
    pub sink: Arc<dyn NoteSink>,
    /// How a project folder is named in notes' scopes.
    pub project_keys: Arc<dyn ProjectKeys>,
    /// The profile, for the backend kinds the user withholds it from.
    pub profile: Arc<dyn UserProfileReader>,
    /// The meaning model, when the host has one.
    pub embedder: Option<LoadEmbedder>,
    /// Code-view panes, when terminals are composed.
    pub code: Option<CodeParts>,
    /// Reflection: without it, moments are captured and wait.
    pub learn: Option<LearnParts>,
    /// Whether model calls nobody asked for may run: only in the installed
    /// app on the user's own data folder.
    pub background_model_calls: bool,
}

impl std::fmt::Debug for MemoryParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MemoryParts").finish_non_exhaustive()
    }
}

pub struct MemoryModule {
    store: Arc<dyn Store>,
    recall: Arc<Recall>,
    capturer: Arc<Capturer>,
    code: Option<Arc<CodePanes>>,
    reflecting: Option<Arc<Reflecting>>,
    reminders: Arc<Reminders>,
    sleeper: Arc<dyn Sleeper>,
    embedder: Mutex<Option<LoadEmbedder>>,
    health: Arc<Mutex<EmbedderHealth>>,
    background_model_calls: bool,
    /// What runs from `start` to `stop`.
    tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

impl std::fmt::Debug for MemoryModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MemoryModule").finish_non_exhaustive()
    }
}

impl MemoryModule {
    pub fn new(parts: MemoryParts) -> Self {
        let MemoryParts {
            store,
            clock,
            sleeper,
            ids,
            runs,
            sink,
            project_keys,
            profile,
            embedder,
            code,
            learn,
            background_model_calls,
        } = parts;
        let wake = Arc::new(Notify::new());
        let code = code.map(|c| {
            let capture = Capture::new(store.clone(), clock.clone(), ids.clone());
            Arc::new(CodePanes::new(&c.bus, capture, c.transcripts, clock.clone(), wake.clone()))
        });
        let health = if embedder.is_some() { EmbedderHealth::Loading } else { EmbedderHealth::Off };
        let recall = Arc::new(Recall::new(store.clone(), clock.clone()));
        let reflecting = learn.map(|learn| {
            let reflector = Reflector::new(ReflectParts {
                store: store.clone(),
                clock: clock.clone(),
                ids: ids.clone(),
                zone: learn.zone,
                one_shot: learn.one_shot,
                gate: Arc::new(PlanGate { background_model_calls, plan: learn.plan, profile: profile.clone() }),
                source: Arc::new(Moments {
                    store: store.clone(),
                    project_keys: project_keys.clone(),
                    runs: runs.clone(),
                    code: code.clone(),
                }),
                prompt: Arc::new(LibraryPrompt(learn.prompts)),
                recall: recall.clone(),
                scrubber: Arc::new(Scrubber::new(learn.home.as_deref())),
                device: learn.device,
                keeper: learn.keeper,
            });
            Arc::new(Reflecting { reflector, recall: recall.clone(), wake: wake.clone() })
        });
        let reminders = Reminders::new(
            recall.clone(),
            store.clone(),
            clock.clone(),
            ids.clone(),
            sink,
            project_keys,
            profile,
            runs.clone(),
        );
        Self {
            recall,
            reminders: Arc::new(reminders),
            capturer: Arc::new(Capturer::new(Capture::new(store.clone(), clock, ids), runs, wake)),
            code,
            reflecting,
            sleeper,
            store,
            embedder: Mutex::new(embedder),
            health: Arc::new(Mutex::new(health)),
            background_model_calls,
            tasks: Mutex::new(Vec::new()),
        }
    }

    pub fn embedder_health(&self) -> EmbedderHealth {
        *self.health.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn background_model_calls(&self) -> bool {
        self.background_model_calls
    }

    /// `recall_experience` for the agent tools.
    pub fn experience_search(&self) -> Arc<dyn ExperienceSearch> {
        Arc::new(Search(self.reminders.clone()))
    }

    pub async fn settings(&self) -> Result<ExperienceSettings, Error> {
        self.store.read(eos_memory::settings::read_in).await
    }
}

struct Search(Arc<Reminders>);

impl ExperienceSearch for Search {
    fn search<'a>(
        &'a self,
        agent_id: &'a str,
        query: &'a str,
        limit: usize,
    ) -> BoxFuture<'a, Result<Vec<FoundNote>, Error>> {
        Box::pin(self.0.search(agent_id, query, limit))
    }
}

/// Loads the model and turns meaning search on; a model that does not load
/// leaves recall on hooks and words.
async fn load_meaning(load: LoadEmbedder, recall: Arc<Recall>, health: Arc<Mutex<EmbedderHealth>>) {
    let loaded = tokio::task::spawn_blocking(load).await.map_err(|e| e.to_string()).and_then(|r| r);
    let ready = match loaded {
        Ok(embedder) => match recall.with_meaning(embedder).await {
            Ok(()) => true,
            Err(e) => {
                tracing::warn!(error = %e, "memory: the meaning vectors did not load");
                false
            }
        },
        Err(e) => {
            tracing::warn!(error = %e, "memory: the meaning model did not load");
            false
        }
    };
    let state = if ready { EmbedderHealth::Ready } else { EmbedderHealth::Off };
    *health.lock().unwrap_or_else(PoisonError::into_inner) = state;
}

impl Module for MemoryModule {
    fn id(&self) -> &'static str {
        "memory"
    }

    fn topics(&self) -> Vec<TopicDecl> {
        vec![MEMORY_CHANGE.decl(), MEMORY_RECALLED.decl()]
    }

    fn idle_hooks(&self) -> Vec<IdleHook> {
        let capturer = self.capturer.clone();
        vec![IdleHook::new("memory", 90, move |worker_id| {
            let capturer = capturer.clone();
            let worker_id = worker_id.to_owned();
            tokio::spawn(async move { capturer.look(&worker_id).await });
            std::future::ready(false)
        })]
    }

    fn on_agent_event(&self, worker_id: &str, event: &AgentEvent) {
        self.capturer.saw(worker_id);
        self.reminders.on_event(worker_id, event);
    }

    fn turn_notes(&self, turn: &NoteTurn) -> BoxFuture<'_, Vec<String>> {
        let turn = turn.clone();
        Box::pin(async move { self.reminders.turn_notes(&turn.worker_id, turn.message.as_deref(), turn.start).await })
    }

    fn on_compaction(&self, worker_id: &str, notice: &CompactionNotice) {
        if matches!(notice, CompactionNotice::Completed { .. }) {
            self.reminders.reset(worker_id);
        }
    }

    fn on_session_exit(&self, worker_id: &str) {
        self.reminders.reset(worker_id);
        self.capturer.ended(worker_id);
        let capturer = self.capturer.clone();
        let worker_id = worker_id.to_owned();
        tokio::spawn(async move { capturer.look(&worker_id).await });
    }

    fn start(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        let mut tasks = self.tasks.lock().unwrap_or_else(PoisonError::into_inner);
        let load = self.embedder.lock().unwrap_or_else(PoisonError::into_inner).take();
        if let Some(load) = load {
            tasks.push(tokio::spawn(load_meaning(load, self.recall.clone(), self.health.clone())));
        }
        tasks.push(tokio::spawn(self.capturer.clone().tick(self.sleeper.clone())));
        if let Some(code) = &self.code {
            tasks.push(tokio::spawn(code.poll(self.sleeper.clone())));
        }
        if let Some(reflecting) = &self.reflecting {
            tasks.push(tokio::spawn(reflecting.clone().run(self.sleeper.clone())));
        }
        drop(tasks);
        Box::pin(std::future::ready(Ok(())))
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        for task in self.tasks.lock().unwrap_or_else(PoisonError::into_inner).drain(..) {
            task.abort();
        }
        Box::pin(std::future::ready(()))
    }
}
