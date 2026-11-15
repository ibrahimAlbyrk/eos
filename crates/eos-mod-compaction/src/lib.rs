//! Context compaction. A session summarizes its own conversation (the agent
//! engine does it, `eos-engine` `compaction.rs`): by itself once its context
//! reaches `config.compaction.threshold`, before the request that would pass
//! it, so the turn goes on from the summary; and on `/compact [focus]`. The
//! sessions record each run's `compaction_*` rows.
//!
//! This feature words the summary from the prompt library ([`Words`]), runs
//! `/compact` ([`CompactionService`]; the worker is held meanwhile: messages
//! to it queue), and shows a running summary in the Jobs tab.

mod command;
mod service;
mod words;

use std::sync::Arc;

use eos_core::Clock;
use eos_core::agent::{CompactionNotice, WorkerSessions};
use eos_core::store::Store;
use eos_runtime::jobs::{JobRegistry, JobSpec};
use eos_runtime::module::{Module, SlashCommandDecl};
use eos_sessions::SlashCommand;

pub use service::CompactionService;
pub use words::Words;

/// The kind of the job the Jobs tab shows while a context is compacted.
pub const JOB_KIND: &str = "compaction";
const JOB_KEY: &str = "context";

/// What compaction is built from.
#[derive(Clone)]
pub struct Parts {
    pub store: Arc<dyn Store>,
    pub sessions: Arc<dyn WorkerSessions>,
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
    jobs: JobRegistry,
}

impl CompactionModule {
    pub fn new(parts: Parts) -> Self {
        let jobs = parts.jobs.clone();
        Self { service: CompactionService::new(parts), jobs }
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

    fn slash_commands(&self) -> Vec<SlashCommandDecl> {
        let command: Arc<dyn SlashCommand> = Arc::new(command::Compact(self.service.clone()));
        vec![SlashCommandDecl { name: "compact", command: Arc::new(command) }]
    }

    fn holds_worker(&self, worker_id: &str) -> bool {
        self.service.is_compacting(worker_id)
    }

    /// Shown only while it runs.
    fn on_compaction(&self, worker_id: &str, notice: &CompactionNotice) {
        if let CompactionNotice::Started { .. } = notice {
            let mut job = JobSpec::new(JOB_KIND, Some(worker_id), JOB_KEY, "Compacting context");
            job.ambient = true;
            self.jobs.start(job).update_now(|_| {});
        } else if let Some(job) = self.jobs.get(JOB_KIND, Some(worker_id), JOB_KEY) {
            job.drop_job();
        }
    }
}
