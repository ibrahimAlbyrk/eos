//! Workflow runs of a focused session (`manager/modules/workflow-runs`):
//! their live progress for the run card and its side-panel tab, the run
//! record's phases and logs, each agent's conversation, and stopping a run.
//!
//! The engine reports a running run's snapshots through
//! [`Module::on_workflow_progress`]; the run's start and end are agent
//! events. [`WorkflowRuns`] holds what is live; the routes under
//! `/workers/:id/workflow-runs` read it.

mod agent_rows;
mod jobs;
mod routes;
mod service;

use std::sync::Arc;

use eos_contracts::{AgentEvent, WORKFLOW_RUN_PROGRESS_TOPIC, WorkflowRunProgress};
use eos_core::agent::{WorkerSessions, WorkflowRunFiles};
use eos_core::store::Store;
use eos_core::{Clock, Sleeper};
use eos_runtime::bus::{Bus, ScopeKind, Topic, TopicDecl};
use eos_runtime::jobs::JobRegistry;
use eos_runtime::module::Module;
use eos_runtime::router::RouteDef;

pub use service::{StopRefused, WorkflowRuns};

/// A running run's latest snapshot, at most twice a second per run, and once
/// more with its end status. Reaches only the streams that follow the worker.
pub const WORKFLOW_PROGRESS: Topic<WorkflowRunProgress> =
    Topic::scoped(WORKFLOW_RUN_PROGRESS_TOPIC, ScopeKind::Worker, |progress| Some(progress.worker_id.as_str()));

/// The kind of a run's row in the Jobs tab.
pub const JOB_KIND: &str = "workflow";

/// What the feature is built from.
#[derive(Clone)]
pub struct Parts {
    pub store: Arc<dyn Store>,
    pub sessions: Arc<dyn WorkerSessions>,
    /// The run records and agent conversations the engine keeps.
    pub files: Arc<dyn WorkflowRunFiles>,
    pub bus: Bus,
    pub jobs: JobRegistry,
    pub clock: Arc<dyn Clock>,
    pub sleeper: Arc<dyn Sleeper>,
}

impl std::fmt::Debug for Parts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Parts").finish_non_exhaustive()
    }
}

#[derive(Debug)]
pub struct WorkflowRunsModule {
    runs: WorkflowRuns,
}

impl WorkflowRunsModule {
    pub fn new(parts: Parts) -> Self {
        Self { runs: WorkflowRuns::new(parts) }
    }

    pub fn runs(&self) -> &WorkflowRuns {
        &self.runs
    }
}

impl Module for WorkflowRunsModule {
    fn id(&self) -> &'static str {
        "workflow-runs"
    }

    fn routes(&self) -> Vec<RouteDef> {
        routes::all(&self.runs)
    }

    fn topics(&self) -> Vec<TopicDecl> {
        vec![WORKFLOW_PROGRESS.decl()]
    }

    fn job_kinds(&self) -> Vec<&'static str> {
        vec![JOB_KIND]
    }

    fn on_agent_event(&self, worker_id: &str, event: &AgentEvent) {
        self.runs.observe(worker_id, event);
    }

    fn on_workflow_progress(&self, progress: &WorkflowRunProgress) {
        self.runs.on_progress(progress);
    }
}
