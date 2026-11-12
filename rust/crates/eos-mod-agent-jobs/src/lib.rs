//! An agent's own background work in the Jobs tab: the commands it left
//! running and its monitors (`manager/services/jobs/sources/agentTasks.ts`).
//!
//! The engine reports them through [`Module::on_background_task`] — only
//! what the session's own agent started with a Bash or Monitor call; a
//! subagent's are its own business. They are never logged. A job is stopped
//! through the session that runs it, and the task's own end closes it.
//! (Workflow runs are the workflow feature's.)

use std::path::PathBuf;
use std::sync::Arc;

use eos_core::agent::{BackgroundTaskKind, BackgroundTaskUpdate, TaskOutcome, WorkerSessions};
use eos_domain::text::first_line;
use eos_runtime::jobs::{JobActionError, JobHandle, JobRegistry, JobSpec, JobStatus};
use eos_runtime::module::Module;

/// A background command: the kernel's kind, shared with `!` commands.
const SHELL: &str = "shell";
const MONITOR: &str = "monitor";
/// The longest line a job's detail shows.
const DETAIL_CHARS: usize = 160;

pub struct AgentJobsModule {
    jobs: JobRegistry,
    sessions: Arc<dyn WorkerSessions>,
}

impl std::fmt::Debug for AgentJobsModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentJobsModule").finish_non_exhaustive()
    }
}

impl AgentJobsModule {
    pub fn new(jobs: JobRegistry, sessions: Arc<dyn WorkerSessions>) -> Self {
        Self { jobs, sessions }
    }

    /// The job of a task: updates name the task only, not its kind.
    fn job(&self, worker_id: &str, task_id: &str) -> Option<JobHandle> {
        [SHELL, MONITOR].into_iter().find_map(|kind| self.jobs.get(kind, Some(worker_id), task_id))
    }

    #[allow(clippy::too_many_arguments)]
    fn started(
        &self,
        worker_id: &str,
        task_id: &str,
        call_id: &str,
        kind: BackgroundTaskKind,
        title: &str,
        command: Option<&str>,
        output_file: Option<&str>,
    ) {
        let monitor = kind == BackgroundTaskKind::Monitor;
        let mut spec = JobSpec::new(if monitor { MONITOR } else { SHELL }, Some(worker_id), task_id, title);
        spec.command = command.map(str::to_owned);
        spec.call_id = Some(call_id.to_owned());
        spec.memory_output = monitor;
        let (sessions, worker, task) = (self.sessions.clone(), worker_id.to_owned(), task_id.to_owned());
        let spec = spec.on_stop(move || {
            let (sessions, worker, task) = (sessions.clone(), worker.clone(), task.clone());
            async move {
                let refused = |error: String| JobActionError { status: 409, error };
                let Some(session) = sessions.session(&worker) else {
                    return Err(refused("this session can't stop that job".into()));
                };
                session.stop_task(&task).await.map_err(|e| refused(e.to_string()))
            }
        });
        let (sessions, worker) = (self.sessions.clone(), worker_id.to_owned());
        let job = self.jobs.start(spec.stoppable_when(move || sessions.session(&worker).is_some()));
        job.set_output_file(output_file.map(PathBuf::from));
        job.update_now(|_| {});
    }
}

impl Module for AgentJobsModule {
    fn id(&self) -> &'static str {
        "agent-jobs"
    }

    fn job_kinds(&self) -> Vec<&'static str> {
        vec![SHELL, MONITOR]
    }

    fn on_background_task(&self, worker_id: &str, update: &BackgroundTaskUpdate) {
        match update {
            BackgroundTaskUpdate::Started { task_id, call_id, kind, title, command, output_file } => {
                self.started(worker_id, task_id, call_id, *kind, title, command.as_deref(), output_file.as_deref());
            }
            BackgroundTaskUpdate::Output { task_id, output_file } => {
                if let Some(job) = self.job(worker_id, task_id) {
                    job.set_output_file(Some(PathBuf::from(output_file)));
                    job.update_now(|_| {});
                }
            }
            BackgroundTaskUpdate::Ended { task_id, outcome, summary, output_file, exit_code } => {
                let Some(job) = self.job(worker_id, task_id) else { return };
                if let Some(file) = output_file {
                    job.set_output_file(Some(PathBuf::from(file)));
                }
                // A command can report "completed" although it exited non-zero.
                let status = match outcome {
                    TaskOutcome::Completed if exit_code.is_some_and(|code| code != 0) => JobStatus::Failed,
                    TaskOutcome::Completed => JobStatus::Completed,
                    TaskOutcome::Failed => JobStatus::Failed,
                    TaskOutcome::Stopped => JobStatus::Stopped,
                };
                let detail = first_line(summary.as_deref(), DETAIL_CHARS);
                job.finish(status, |job| {
                    if detail.is_some() {
                        job.detail = detail;
                    }
                    job.exit_code = *exit_code;
                });
            }
        }
    }
}
