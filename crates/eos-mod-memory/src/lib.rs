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
//! - Model work nobody asked for (reflection, night tidying) runs only when
//!   the host lets it ([`MemoryParts::background_model_calls`]).
//!
//! Note text, cues and hook keys are the user's: logged by id, kind and
//! count only.

use std::sync::{Arc, Mutex, PoisonError};

use eos_contracts::{ExperienceChange, ExperienceRecalledEvent, ExperienceSettings};
use eos_core::experience::Embedder;
use eos_core::store::Store;
use eos_core::{BoxFuture, Clock, Error};
use eos_memory::Recall;
use eos_runtime::bus::{Topic, TopicDecl};
use eos_runtime::module::{Module, ModuleError};

pub const MEMORY_CHANGE: Topic<ExperienceChange> = Topic::new("memory:change");
pub const MEMORY_RECALLED: Topic<ExperienceRecalledEvent> = Topic::new("memory:recalled");

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

/// What the module is built from.
pub struct MemoryParts {
    pub store: Arc<dyn Store>,
    pub clock: Arc<dyn Clock>,
    /// The meaning model, when the host has one.
    pub embedder: Option<LoadEmbedder>,
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
        let MemoryParts { store, clock, embedder, background_model_calls } = parts;
        let health = if embedder.is_some() { EmbedderHealth::Loading } else { EmbedderHealth::Off };
        Self {
            recall: Arc::new(Recall::new(store.clone(), clock)),
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

    pub async fn settings(&self) -> Result<ExperienceSettings, Error> {
        self.store.read(eos_memory::settings::read_in).await
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

    fn start(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        let load = self.embedder.lock().unwrap_or_else(PoisonError::into_inner).take();
        if let Some(load) = load {
            let task = tokio::spawn(load_meaning(load, self.recall.clone(), self.health.clone()));
            self.tasks.lock().unwrap_or_else(PoisonError::into_inner).push(task);
        }
        Box::pin(std::future::ready(Ok(())))
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        for task in self.tasks.lock().unwrap_or_else(PoisonError::into_inner).drain(..) {
            task.abort();
        }
        Box::pin(std::future::ready(()))
    }
}
