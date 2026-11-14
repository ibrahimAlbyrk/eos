//! Workflow runs, live and finished.
//!
//! A running run's progress is held here — the latest snapshot only — and
//! relayed as `workflow:progress` at most once per [`THROTTLE_MS`]. It is
//! never written to the event log, whose per-worker cap would otherwise lose
//! chat rows to progress ticks. What lasts is the `workflow_started` /
//! `workflow_completed` agent events, and the files kept for the run (its
//! record and each agent's conversation).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use eos_contracts::{
    AgentEvent, PtyConversationRow, SubagentUsage, WORKFLOW_AGENT_ROWS_MAX, WorkerEventType, WorkflowCompletedEvent,
    WorkflowCompletedEventStatus, WorkflowRunDetail, WorkflowRunProgress, WorkflowRunSnapshot, WorkflowRunStatus,
    WorkflowStartedEvent,
};
use eos_core::Error;
use eos_domain::text::first_line;
use eos_domain::workflow_run::{
    RunEnd, empty_snapshot, parse_workflow_record, settle_workflow_snapshot, with_workflow_record,
};
use eos_runtime::jobs::{JobActionError, JobSpec, JobStatus};

use crate::agent_rows::AgentRows;
use crate::jobs::{DETAIL_CHARS, progress_of};
use crate::{JOB_KIND, Parts, WORKFLOW_PROGRESS};

/// One relayed snapshot per run in this long: twice a second.
const THROTTLE_MS: i64 = 500;

struct LiveRun {
    task_id: String,
    started: Option<WorkflowStartedEvent>,
    started_at: Option<i64>,
    snapshot: WorkflowRunSnapshot,
    usage: Option<SubagentUsage>,
    updated_at: i64,
    /// When a snapshot last went out; `None` before the first.
    sent_at: Option<i64>,
    /// A relay is waiting for the window to end.
    waiting: bool,
}

/// `(worker, call)`.
type Key = (String, String);

struct Inner {
    parts: Parts,
    live: Mutex<HashMap<Key, LiveRun>>,
    agent_rows: AgentRows,
}

/// Why a run was not stopped: the status and the words of the answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StopRefused {
    pub status: u16,
    pub error: String,
}

/// Cheap to clone.
#[derive(Clone)]
pub struct WorkflowRuns(Arc<Inner>);

impl std::fmt::Debug for WorkflowRuns {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkflowRuns").field("live", &self.live().len()).finish_non_exhaustive()
    }
}

fn end_of(status: WorkflowCompletedEventStatus) -> (WorkflowRunStatus, RunEnd, JobStatus) {
    match status {
        WorkflowCompletedEventStatus::Completed => {
            (WorkflowRunStatus::Completed, RunEnd::Completed, JobStatus::Completed)
        }
        WorkflowCompletedEventStatus::Failed => (WorkflowRunStatus::Failed, RunEnd::Failed, JobStatus::Failed),
        WorkflowCompletedEventStatus::Stopped => (WorkflowRunStatus::Stopped, RunEnd::Stopped, JobStatus::Stopped),
    }
}

fn valid_agent_id(id: &str) -> bool {
    (6..=40).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

impl WorkflowRuns {
    pub fn new(parts: Parts) -> Self {
        Self(Arc::new(Inner { parts, live: Mutex::default(), agent_rows: AgentRows::default() }))
    }

    fn live(&self) -> MutexGuard<'_, HashMap<Key, LiveRun>> {
        self.0.live.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn now(&self) -> i64 {
        self.0.parts.clock.now_ms()
    }

    fn entry<'m>(&self, live: &'m mut HashMap<Key, LiveRun>, key: Key, task_id: &str) -> &'m mut LiveRun {
        let now = self.now();
        live.entry(key).or_insert_with(|| LiveRun {
            task_id: task_id.to_owned(),
            started: None,
            started_at: None,
            snapshot: empty_snapshot(),
            usage: None,
            updated_at: now,
            sent_at: None,
            waiting: false,
        })
    }

    /// Publishes a live run's snapshot. Called with the runs locked, so a
    /// run's end can never be overtaken by a snapshot of it.
    fn send(&self, key: &Key, run: &mut LiveRun) {
        run.waiting = false;
        run.sent_at = Some(self.now());
        let payload = WorkflowRunProgress {
            worker_id: key.0.clone(),
            call_id: key.1.clone(),
            task_id: run.task_id.clone(),
            status: WorkflowRunStatus::Running,
            snapshot: run.snapshot.clone(),
            usage: run.usage.clone(),
            updated_at: run.updated_at.into(),
        };
        self.0.parts.bus.publish(&WORKFLOW_PROGRESS, &payload);
    }

    /// The engine's latest snapshot of a running run. Does not block.
    pub fn on_progress(&self, progress: &WorkflowRunProgress) {
        let key = (progress.worker_id.clone(), progress.call_id.clone());
        let mut live = self.live();
        let run = self.entry(&mut live, key.clone(), &progress.task_id);
        run.snapshot = progress.snapshot.clone();
        if progress.usage.is_some() {
            run.usage = progress.usage.clone();
        }
        run.updated_at = progress.updated_at.0 as i64;
        let wait = run.sent_at.map_or(0, |sent| sent + THROTTLE_MS - self.now());
        if wait <= 0 {
            self.send(&key, run);
        } else if !run.waiting {
            run.waiting = true;
            self.relay_after(key.clone(), wait);
        }
        drop(live);
        if let Some(job) = self.0.parts.jobs.get(JOB_KIND, Some(&key.0), &key.1) {
            let (detail, bar) = progress_of(&progress.snapshot);
            job.update(|job| {
                job.detail = detail;
                job.progress = bar;
            });
        }
    }

    /// The held snapshot goes out when the window ends, unless the run ended first.
    fn relay_after(&self, key: Key, wait: i64) {
        let Ok(tasks) = tokio::runtime::Handle::try_current() else { return };
        let (runs, sleeping) = (self.clone(), self.0.parts.sleeper.sleep(wait));
        tasks.spawn(async move {
            sleeping.await;
            if let Some(run) = runs.live().get_mut(&key).filter(|run| run.waiting) {
                runs.send(&key, run);
            }
        });
    }

    /// Every agent event of a worker passes here; only a run's start and end matter.
    pub fn observe(&self, worker_id: &str, event: &AgentEvent) {
        match event {
            AgentEvent::WorkflowStarted(started) => self.started(worker_id, started),
            AgentEvent::WorkflowCompleted(completed) => self.completed(worker_id, completed),
            _ => {}
        }
    }

    fn started(&self, worker_id: &str, started: &WorkflowStartedEvent) {
        let key = (worker_id.to_owned(), started.call_id.clone());
        {
            let mut live = self.live();
            let run = self.entry(&mut live, key, &started.task_id);
            run.started = Some(started.clone());
            run.started_at = Some(self.now());
        }
        let title = started.name.clone().or_else(|| started.description.clone()).unwrap_or_else(|| "Workflow".into());
        let mut job = JobSpec::new(JOB_KIND, Some(worker_id), started.call_id.clone(), title);
        job.call_id = Some(started.call_id.clone());
        let (stopper, worker, call) = (self.clone(), worker_id.to_owned(), started.call_id.clone());
        let job = job.on_stop(move || {
            let (stopper, worker, call) = (stopper.clone(), worker.clone(), call.clone());
            async move {
                stopper.stop(&worker, &call).await.map_err(|refused| JobActionError {
                    status: 409,
                    error: if refused.status == 404 {
                        "this session can't stop that job".into()
                    } else {
                        refused.error
                    },
                })
            }
        });
        let (sessions, worker) = (self.0.parts.sessions.clone(), worker_id.to_owned());
        let job = job.stoppable_when(move || sessions.session(&worker).is_some());
        self.0.parts.jobs.start(job).update_now(|_| {});
    }

    fn completed(&self, worker_id: &str, completed: &WorkflowCompletedEvent) {
        let key = (worker_id.to_owned(), completed.call_id.clone());
        let (status, end, job_status) = end_of(completed.status);
        {
            // The end goes out at once: an open side-panel tab learns it
            // here, not from the transcript it may not have loaded.
            let mut live = self.live();
            let run = live.remove(&key);
            self.0.agent_rows.forget_run(&key);
            let last = run.as_ref().map(|run| run.snapshot.clone());
            let snapshot = completed.snapshot.clone().or(last).unwrap_or_else(empty_snapshot);
            let payload = WorkflowRunProgress {
                worker_id: key.0.clone(),
                call_id: key.1.clone(),
                task_id: completed.task_id.clone(),
                status,
                snapshot: settle_workflow_snapshot(snapshot, end),
                usage: completed.usage.clone().or(run.and_then(|run| run.usage)),
                updated_at: self.now().into(),
            };
            self.0.parts.bus.publish(&WORKFLOW_PROGRESS, &payload);
        }
        if let Some(job) = self.0.parts.jobs.get(JOB_KIND, Some(worker_id), &completed.call_id) {
            let from_snapshot = completed.snapshot.as_ref().and_then(|snapshot| progress_of(snapshot).0);
            let detail = first_line(completed.summary.as_deref(), DETAIL_CHARS).or(from_snapshot);
            job.finish(job_status, |job| {
                if detail.is_some() {
                    job.detail = detail;
                }
            });
        }
    }

    /// Phase details and logs live only in the run's record, once it is written.
    async fn with_record(&self, snapshot: WorkflowRunSnapshot, dir: Option<&str>) -> WorkflowRunSnapshot {
        let Some(dir) = dir else { return snapshot };
        let record = self.0.parts.files.record(dir).await.and_then(|json| parse_workflow_record(&json));
        match record {
            Some(record) => with_workflow_record(&snapshot, &record),
            None => snapshot,
        }
    }

    async fn live_detail(&self, worker_id: &str, call_id: &str) -> Option<WorkflowRunDetail> {
        let (task_id, started, started_at, snapshot, usage) = {
            let live = self.live();
            let run = live.get(&(worker_id.to_owned(), call_id.to_owned()))?;
            (run.task_id.clone(), run.started.clone(), run.started_at, run.snapshot.clone(), run.usage.clone())
        };
        let started = started.as_ref();
        let dir = started.and_then(|s| s.transcript_dir.as_deref());
        Some(WorkflowRunDetail {
            call_id: call_id.to_owned(),
            task_id,
            run_id: started.and_then(|s| s.run_id.clone()),
            name: started.and_then(|s| s.name.clone()),
            description: started.and_then(|s| s.description.clone()),
            status: WorkflowRunStatus::Running,
            started_at: started_at.map(Into::into),
            ended_at: None,
            summary: None,
            usage,
            snapshot: self.with_record(snapshot, dir).await,
            can_stop: self.0.parts.sessions.session(worker_id).is_some(),
        })
    }

    /// A worker's running runs.
    pub async fn list(&self, worker_id: &str) -> Vec<WorkflowRunDetail> {
        let mut calls: Vec<String> =
            self.live().keys().filter(|(w, _)| w == worker_id).map(|(_, c)| c.clone()).collect();
        calls.sort();
        let mut runs = Vec::with_capacity(calls.len());
        for call in calls {
            runs.extend(self.live_detail(worker_id, &call).await);
        }
        runs
    }

    /// The run's two recorded events, each with the time of its row.
    async fn recorded(
        &self,
        worker_id: &str,
        call_id: &str,
    ) -> Result<(Option<(WorkflowStartedEvent, i64)>, Option<(WorkflowCompletedEvent, i64)>), Error> {
        let (worker, call) = (worker_id.to_owned(), call_id.to_owned());
        let rows =
            self.0.parts.store.read(move |tx| tx.events().list_by_type(&worker, WorkerEventType::AgentEvent, None));
        let (mut started, mut completed) = (None, None);
        for row in rows.await? {
            let Some(payload) = row.payload.as_deref().filter(|p| p.contains("\"workflow_") && p.contains(&call))
            else {
                continue;
            };
            match serde_json::from_str::<AgentEvent>(payload) {
                Ok(AgentEvent::WorkflowStarted(e)) if e.call_id == call => started = Some((e, row.ts)),
                Ok(AgentEvent::WorkflowCompleted(e)) if e.call_id == call => completed = Some((e, row.ts)),
                _ => {}
            }
        }
        Ok((started, completed))
    }

    /// One run, live or finished.
    pub async fn get(&self, worker_id: &str, call_id: &str) -> Result<Option<WorkflowRunDetail>, Error> {
        if let Some(live) = self.live_detail(worker_id, call_id).await {
            return Ok(Some(live));
        }
        let (started, completed) = self.recorded(worker_id, call_id).await?;
        let Some(task_id) = started.as_ref().map(|(s, _)| &s.task_id).or(completed.as_ref().map(|(c, _)| &c.task_id))
        else {
            return Ok(None);
        };
        let task_id = task_id.clone();
        let s = started.as_ref().map(|(event, _)| event);
        let c = completed.as_ref().map(|(event, _)| event);
        // Started, never ended, not live: the session that ran it is gone.
        let (status, end, _) = end_of(c.map_or(WorkflowCompletedEventStatus::Stopped, |c| c.status));
        let snapshot = c.and_then(|c| c.snapshot.clone()).unwrap_or_else(empty_snapshot);
        let with_record = self.with_record(snapshot, s.and_then(|s| s.transcript_dir.as_deref())).await;
        Ok(Some(WorkflowRunDetail {
            call_id: call_id.to_owned(),
            task_id,
            run_id: s.and_then(|s| s.run_id.clone()),
            name: s.and_then(|s| s.name.clone()),
            description: s.and_then(|s| s.description.clone()),
            status,
            started_at: started.as_ref().map(|(_, ts)| (*ts).into()),
            ended_at: completed.as_ref().map(|(_, ts)| (*ts).into()),
            summary: c.and_then(|c| c.summary.clone()).filter(|s| !s.is_empty()),
            usage: c.and_then(|c| c.usage.clone()),
            // Settled after the record: a stopped run's record keeps its agents in progress too.
            snapshot: settle_workflow_snapshot(with_record, end),
            can_stop: false,
        }))
    }

    /// One agent's conversation as worker-event rows, the newest
    /// [`WORKFLOW_AGENT_ROWS_MAX`] of them.
    pub async fn agent_rows(
        &self,
        worker_id: &str,
        call_id: &str,
        agent_id: &str,
    ) -> Result<Option<Vec<PtyConversationRow>>, Error> {
        if !valid_agent_id(agent_id) {
            return Ok(None);
        }
        let live = {
            let live = self.live();
            live.get(&(worker_id.to_owned(), call_id.to_owned())).map(|run| run.started.clone())
        };
        let started = match live {
            Some(started) => started,
            None => self.recorded(worker_id, call_id).await?.0.map(|(event, _)| event),
        };
        let Some(dir) = started.and_then(|s| s.transcript_dir) else { return Ok(None) };
        let files = &self.0.parts.files;
        let run = (worker_id.to_owned(), call_id.to_owned());
        // Read again only once the file changed: a drawer asks every few seconds.
        let stamp = files.agent_stamp(&dir, agent_id).await;
        if let Some(rows) = stamp.as_ref().and_then(|stamp| self.0.agent_rows.get(&run, agent_id, stamp)) {
            return Ok(Some(rows));
        }
        let Some(mut rows) = files.agent_rows(&dir, agent_id).await else { return Ok(None) };
        let max = usize::try_from(WORKFLOW_AGENT_ROWS_MAX).unwrap_or(usize::MAX);
        if rows.len() > max {
            rows.drain(..rows.len() - max);
        }
        if let Some(stamp) = stamp {
            self.0.agent_rows.put(run, agent_id, stamp, &rows);
        }
        Ok(Some(rows))
    }

    /// Stops a running run through the session that runs it. The run's own
    /// end event closes it.
    pub async fn stop(&self, worker_id: &str, call_id: &str) -> Result<(), StopRefused> {
        let task = self.live().get(&(worker_id.to_owned(), call_id.to_owned())).map(|run| run.task_id.clone());
        let Some(task_id) = task else {
            return Err(StopRefused { status: 404, error: "no running workflow with that call id".into() });
        };
        let Some(session) = self.0.parts.sessions.session(worker_id) else {
            return Err(StopRefused { status: 409, error: "this session can't stop a workflow".into() });
        };
        session.stop_task(&task_id).await.map_err(|e| StopRefused { status: 409, error: e.to_string() })
    }

    /// How many runs are held in memory.
    pub fn live_count(&self) -> usize {
        self.live().len()
    }

    /// How many agent conversations are kept parsed.
    pub fn kept_conversations(&self) -> usize {
        self.0.agent_rows.len()
    }
}
