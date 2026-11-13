//! Context compaction (`manager/modules/compaction`): a tool-less summarizer
//! on the agent's own model condenses the conversation, and the session
//! continues from the summary. It runs at a worker's idle edge once the
//! context is as full as the configured threshold (ahead of the nudges), or
//! on `/compact [focus]`. While it runs the worker is held:
//! messages to it queue.
//!
//! [`rules`] are the pure decisions, [`CompactionService`] decides when and
//! keeps one run per worker, `run` is the compaction itself.

mod command;
pub mod rules;
mod run;
mod service;

use std::sync::Arc;

use eos_core::Clock;
use eos_core::agent::{ModelCatalog, OneShot, WorkerSessions};
use eos_core::store::{ConfigSource, Store};
use eos_prompts::PromptService;
use eos_runtime::idle::IdleHook;
use eos_runtime::jobs::JobRegistry;
use eos_runtime::module::{Module, SlashCommandDecl};
use eos_sessions::SlashCommand;

pub use run::Input;
pub use service::CompactionService;

/// The kind of the job the Jobs tab shows while a context is compacted.
pub const JOB_KIND: &str = "compaction";

/// Ahead of the report nudge (30) and the context watcher (40): a worker at
/// or over the threshold is compacted before anything hands it more work.
const IDLE_ORDER: i32 = 10;

/// What compaction is built from.
#[derive(Clone)]
pub struct Parts {
    pub store: Arc<dyn Store>,
    pub sessions: Arc<dyn WorkerSessions>,
    pub config: Arc<dyn ConfigSource>,
    pub models: Arc<dyn ModelCatalog>,
    /// The summarizer: one tool-less request on the agent's own model.
    pub summarizer: Arc<dyn OneShot>,
    pub prompts: Arc<PromptService>,
    pub clock: Arc<dyn Clock>,
    pub jobs: JobRegistry,
}

impl std::fmt::Debug for Parts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Parts").finish_non_exhaustive()
    }
}

#[derive(Debug)]
pub struct CompactionModule {
    service: CompactionService,
}

impl CompactionModule {
    pub fn new(parts: Parts) -> Self {
        Self { service: CompactionService::new(parts) }
    }

    pub fn service(&self) -> &CompactionService {
        &self.service
    }
}

impl Module for CompactionModule {
    fn id(&self) -> &'static str {
        "compaction"
    }

    fn job_kinds(&self) -> Vec<&'static str> {
        vec![JOB_KIND]
    }

    fn idle_hooks(&self) -> Vec<IdleHook> {
        let service = self.service.clone();
        vec![IdleHook::new("compaction", IDLE_ORDER, move |worker_id| {
            let (service, id) = (service.clone(), worker_id.to_owned());
            async move { service.check_on_idle(&id).await }
        })]
    }

    fn slash_commands(&self) -> Vec<SlashCommandDecl> {
        let command: Arc<dyn SlashCommand> = Arc::new(command::Compact(self.service.clone()));
        vec![SlashCommandDecl { name: "compact", command: Arc::new(command) }]
    }

    fn holds_worker(&self, worker_id: &str) -> bool {
        self.service.is_compacting(worker_id)
    }
}
