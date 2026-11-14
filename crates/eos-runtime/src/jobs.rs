//! Every background job, in memory, for the header beacon and the Jobs tab.
//!
//! The registry knows nothing about what a job is: whoever runs something in
//! the background (an agent's shells and Workflows, `!` commands, transfers,
//! dreams, sync, compaction, updates) starts a job here, updates it, ends it,
//! and says how to stop it. Changes go out as `jobs:change`, at most once per
//! throttle window per job — except a start or an end, which go at once.
//! Finished jobs are kept (the newest `finished_max`) until dismissed; an
//! ambient job (compaction, sync, an update download) shows only while it
//! runs. Nothing is persisted: a restart starts an empty list.

pub mod routes;

use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::Serialize;

use crate::bus::{Bus, Topic};
use crate::router::BoxFuture;
use eos_contracts::stream::topics;

/// One job as the dashboard sees it. The wire shape is `eos-contracts`'
/// `BackgroundJob`; it lives here until that type exists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundJob {
    /// `<kind>:<workerId|eos>:<ref>`.
    pub id: String,
    pub kind: String,
    pub status: JobStatus,
    /// The chat the job belongs to; `None` = Eos itself (transfer, dream, sync).
    pub worker_id: Option<String>,
    pub title: String,
    pub command: Option<String>,
    /// One line of what is happening now.
    pub detail: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub progress: Option<JobProgress>,
    pub exit_code: Option<i64>,
    /// The tool call that started it.
    pub call_id: Option<String>,
    pub has_output: bool,
    pub can_stop: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Running,
    Completed,
    Failed,
    Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct JobProgress {
    pub done: u64,
    pub total: u64,
}

/// The payload of `jobs:change`: one job's new state, or ids dropped from the list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct JobChange {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job: Option<BackgroundJob>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<Vec<String>>,
}

pub const JOBS_CHANGE: Topic<JobChange> = Topic::new(topics::JOBS_CHANGE);

/// A job's output after an offset. `next` is the offset to ask from next
/// time; `reset` = the output started over, so the reader drops what it holds.
/// Offsets are bytes (opaque to the client, which only hands `next` back).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct JobOutput {
    pub text: String,
    pub next: u64,
    pub truncated: bool,
    pub reset: bool,
}

/// The most output one read returns (its newest part when there is more).
pub const JOB_OUTPUT_MAX: usize = 64 * 1024;
/// The most output kept in memory per job.
const MEM_MAX: usize = 256 * 1024;

/// Why a user's action on a job was refused: the status and message the
/// route answers with.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{error}")]
pub struct JobActionError {
    pub status: u16,
    pub error: String,
}

pub type JobActionResult = Result<(), JobActionError>;
type StopFn = Arc<dyn Fn() -> BoxFuture<'static, JobActionResult> + Send + Sync>;
type CanStopFn = Arc<dyn Fn() -> bool + Send + Sync>;

/// What a source says when it starts a job.
#[derive(Clone, Default)]
pub struct JobSpec {
    /// A declared job kind (`shell`, `workflow`, `transfer`, …).
    pub kind: String,
    pub worker_id: Option<String>,
    /// Unique among this kind's jobs of the same worker.
    pub reference: String,
    pub title: String,
    pub command: Option<String>,
    pub call_id: Option<String>,
    /// Defaults to now.
    pub started_at: Option<i64>,
    /// Shown only while it runs.
    pub ambient: bool,
    /// Keep output in memory (`append_output`) — otherwise only a file's.
    pub memory_output: bool,
    stop: Option<StopFn>,
    can_stop: Option<CanStopFn>,
}

impl JobSpec {
    pub fn new(
        kind: impl Into<String>,
        worker_id: Option<&str>,
        reference: impl Into<String>,
        title: impl Into<String>,
    ) -> Self {
        Self {
            kind: kind.into(),
            worker_id: worker_id.map(str::to_owned),
            reference: reference.into(),
            title: title.into(),
            ..Self::default()
        }
    }

    /// How the user stops it; a job without this cannot be stopped.
    pub fn on_stop<F, Fut>(mut self, stop: F) -> Self
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = JobActionResult> + Send + 'static,
    {
        self.stop = Some(Arc::new(move || Box::pin(stop())));
        self
    }

    /// Whether stopping is possible right now (default: whenever it can be stopped at all).
    pub fn stoppable_when(mut self, can_stop: impl Fn() -> bool + Send + Sync + 'static) -> Self {
        self.can_stop = Some(Arc::new(can_stop));
        self
    }
}

impl std::fmt::Debug for JobSpec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JobSpec")
            .field("kind", &self.kind)
            .field("worker_id", &self.worker_id)
            .field("reference", &self.reference)
            .finish_non_exhaustive()
    }
}

/// Job kinds no single feature owns, because more than one produces them:
/// `shell` is a `!` command from the composer and an agent's background
/// shell alike. A module may list one among its kinds; it never clashes.
pub const KERNEL_JOB_KINDS: &[&str] = &["shell"];

/// `<kind>:<workerId|eos>:<ref>` — stable per job.
pub fn job_id(kind: &str, worker_id: Option<&str>, reference: &str) -> String {
    format!("{kind}:{}:{reference}", worker_id.unwrap_or("eos"))
}

struct Entry {
    /// Tells this run of the job from an earlier one with the same id.
    generation: u64,
    /// Position in the list among jobs that sort equal (first start wins).
    position: u64,
    job: BackgroundJob,
    spec: Arc<JobSpec>,
    output_file: Option<PathBuf>,
    mem: Option<String>,
    /// Offset of `mem`'s first byte in the whole output.
    mem_base: u64,
    sent_at: Option<i64>,
    /// The armed throttle timer, if any.
    timer: Option<u64>,
}

impl Entry {
    fn row(&self) -> Row {
        let mut job = self.job.clone();
        job.has_output = self.mem.is_some() || self.output_file.is_some();
        Row { job, spec: self.spec.clone(), position: self.position }
    }
}

/// A job copied out of the registry; `can_stop` is filled in once no lock is
/// held (it asks the source).
struct Row {
    job: BackgroundJob,
    spec: Arc<JobSpec>,
    position: u64,
}

impl Row {
    fn finish(mut self) -> BackgroundJob {
        let stoppable = self.spec.stop.is_some() && self.spec.can_stop.as_ref().is_none_or(|ask| ask());
        self.job.can_stop = self.job.status == JobStatus::Running && stoppable;
        self.job
    }
}

enum Outgoing {
    Job(Box<Row>),
    Removed(Vec<String>),
}

#[derive(Default)]
struct State {
    entries: HashMap<String, Entry>,
    counter: u64,
    /// Changes in the order they happened, waiting for the lane to publish them.
    outbox: VecDeque<Outgoing>,
}

struct Inner {
    bus: Bus,
    throttle_ms: i64,
    finished_max: usize,
    max_jobs: usize,
    state: Mutex<State>,
}

#[derive(Debug, Clone, Copy)]
pub struct JobOptions {
    /// The least time between two `jobs:change` for one job (today: 500 ms).
    pub throttle: Duration,
    /// How many finished jobs are kept (today: 50).
    pub finished_max: usize,
    /// The most jobs held at all. Past it the oldest finished job is dropped
    /// to make room, or — with none finished — the longest-running one: the
    /// list shows work, it is not the record of it.
    pub max_jobs: usize,
}

impl Default for JobOptions {
    fn default() -> Self {
        Self { throttle: Duration::from_millis(500), finished_max: 50, max_jobs: 1024 }
    }
}

#[derive(Clone)]
pub struct JobRegistry {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for JobRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JobRegistry").field("jobs", &self.inner.state().entries.len()).finish_non_exhaustive()
    }
}

/// Running first (newest start first), then finished by end, newest first.
fn compare(a: &BackgroundJob, b: &BackgroundJob) -> std::cmp::Ordering {
    let (a_running, b_running) = (a.status == JobStatus::Running, b.status == JobStatus::Running);
    match (a_running, b_running) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        (true, true) => b.started_at.cmp(&a.started_at),
        (false, false) => b.ended_at.unwrap_or(0).cmp(&a.ended_at.unwrap_or(0)),
    }
}

impl JobRegistry {
    pub fn new(bus: Bus, options: JobOptions) -> Self {
        let inner = Inner {
            bus,
            throttle_ms: options.throttle.as_millis() as i64,
            finished_max: options.finished_max,
            max_jobs: options.max_jobs.max(1),
            state: Mutex::default(),
        };
        Self { inner: Arc::new(inner) }
    }

    /// Every job, running first.
    pub fn list(&self) -> Vec<BackgroundJob> {
        let mut rows: Vec<Row> = self.inner.state().entries.values().map(Entry::row).collect();
        rows.sort_by_key(|r| r.position);
        let mut jobs: Vec<BackgroundJob> = rows.into_iter().map(Row::finish).collect();
        jobs.sort_by(compare);
        jobs
    }

    /// A new job, or the same one (same kind, worker and ref) started again.
    /// Nothing goes out until the caller's first update — so it can fill the
    /// job in first.
    pub fn start(&self, spec: JobSpec) -> JobHandle {
        let id = job_id(&spec.kind, spec.worker_id.as_deref(), &spec.reference);
        let now = self.inner.bus.clock().now_ms();
        let mut state = self.inner.state();
        state.counter += 1;
        let generation = state.counter;
        let position = state.entries.get(&id).map_or(generation, |previous| previous.position);
        let job = BackgroundJob {
            id: id.clone(),
            kind: spec.kind.clone(),
            status: JobStatus::Running,
            worker_id: spec.worker_id.clone(),
            title: spec.title.clone(),
            command: spec.command.clone(),
            detail: None,
            started_at: spec.started_at.unwrap_or(now),
            ended_at: None,
            progress: None,
            exit_code: None,
            call_id: spec.call_id.clone(),
            has_output: false,
            can_stop: false,
        };
        let mem = spec.memory_output.then(String::new);
        let entry = Entry {
            generation,
            position,
            job,
            spec: Arc::new(spec),
            output_file: None,
            mem,
            mem_base: 0,
            sent_at: None,
            timer: None,
        };
        state.entries.insert(id.clone(), entry);
        state.make_room(self.inner.max_jobs, &id);
        self.inner.flush(state);
        JobHandle { inner: self.inner.clone(), id, generation }
    }

    /// The handle of a job that is in the list.
    pub fn get(&self, kind: &str, worker_id: Option<&str>, reference: &str) -> Option<JobHandle> {
        let id = job_id(kind, worker_id, reference);
        let generation = self.inner.state().entries.get(&id)?.generation;
        Some(JobHandle { inner: self.inner.clone(), id, generation })
    }

    // ---- the user's actions ----

    /// The job's output after `since`, at most [`JOB_OUTPUT_MAX`] of its newest.
    pub fn output(&self, id: &str, since: u64) -> Option<JobOutput> {
        let file = {
            let state = self.inner.state();
            let entry = state.entries.get(id)?;
            if let Some(mem) = &entry.mem {
                return Some(slice_output(mem, entry.mem_base, since));
            }
            entry.output_file.clone()?
        };
        read_file_output(&file, since)
    }

    pub async fn stop(&self, id: &str) -> JobActionResult {
        let stop = {
            let state = self.inner.state();
            match state.entries.get(id) {
                Some(entry) if entry.job.status == JobStatus::Running => entry.spec.stop.clone(),
                _ => return Err(JobActionError { status: 404, error: "no running job with that id".into() }),
            }
        };
        match stop {
            Some(stop) => stop().await,
            None => Err(JobActionError { status: 409, error: "that job can't be stopped".into() }),
        }
    }

    pub fn dismiss(&self, id: &str) -> JobActionResult {
        let mut state = self.inner.state();
        match state.entries.get(id) {
            Some(entry) if entry.job.status != JobStatus::Running => {}
            _ => return Err(JobActionError { status: 404, error: "no finished job with that id".into() }),
        }
        state.entries.remove(id);
        self.inner.send(state, Outgoing::Removed(vec![id.to_owned()]));
        Ok(())
    }

    pub fn clear_finished(&self) {
        let mut state = self.inner.state();
        let ids = state.remove_where(|e| e.job.status != JobStatus::Running);
        if !ids.is_empty() {
            self.inner.send(state, Outgoing::Removed(ids));
        }
    }

    /// A worker row is gone for good: its jobs have nothing left to link to.
    pub fn forget_worker(&self, worker_id: &str) {
        let mut state = self.inner.state();
        let ids = state.remove_where(|e| e.job.worker_id.as_deref() == Some(worker_id));
        for id in ids {
            state.outbox.push_back(Outgoing::Removed(vec![id]));
        }
        self.inner.flush(state);
    }

    /// Drops every job without announcing it (shutdown).
    pub fn dispose(&self) {
        let mut state = self.inner.state();
        state.entries.clear();
        state.outbox.clear();
    }
}

impl State {
    /// Removes matching jobs, oldest entry first; returns their ids.
    fn remove_where(&mut self, matches: impl Fn(&Entry) -> bool) -> Vec<String> {
        let mut found: Vec<(u64, String)> =
            self.entries.values().filter(|e| matches(e)).map(|e| (e.position, e.job.id.clone())).collect();
        found.sort();
        found.into_iter().map(|(_, id)| id).inspect(|id| drop(self.entries.remove(id))).collect()
    }

    fn entry(&mut self, id: &str, generation: u64) -> Option<&mut Entry> {
        self.entries.get_mut(id).filter(|e| e.generation == generation)
    }

    /// Queues the job's current state for publishing and stamps it as sent.
    fn announce(&mut self, id: &str, now: i64) {
        let Some(entry) = self.entries.get_mut(id) else { return };
        entry.timer = None;
        entry.sent_at = Some(now);
        let row = entry.row();
        self.outbox.push_back(Outgoing::Job(Box::new(row)));
    }

    /// Drops jobs until at most `max` are held, never the one just started.
    fn make_room(&mut self, max: usize, keep: &str) {
        while self.entries.len() > max {
            // Finished before running, then the oldest end / the oldest start.
            let victim = self
                .entries
                .values()
                .filter(|e| e.job.id != keep)
                .min_by_key(|e| {
                    (e.job.status == JobStatus::Running, e.job.ended_at.unwrap_or(e.job.started_at), e.position)
                })
                .map(|e| e.job.id.clone());
            let Some(id) = victim else { return };
            self.entries.remove(&id);
            self.outbox.push_back(Outgoing::Removed(vec![id]));
        }
    }

    fn prune_finished(&mut self, keep: usize) {
        let mut finished: Vec<(i64, u64, String)> = self
            .entries
            .values()
            .filter(|e| e.job.status != JobStatus::Running)
            .map(|e| (e.job.ended_at.unwrap_or(0), e.position, e.job.id.clone()))
            .collect();
        // Newest end first; among equals the earlier entry is kept.
        finished.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        let extra: Vec<String> = finished.into_iter().skip(keep).map(|(_, _, id)| id).collect();
        for id in &extra {
            self.entries.remove(id);
        }
        if !extra.is_empty() {
            self.outbox.push_back(Outgoing::Removed(extra));
        }
    }
}

impl Inner {
    // Every mutation leaves the registry valid, so a poisoned lock is safe to use.
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn send(self: &Arc<Self>, mut state: MutexGuard<'_, State>, change: Outgoing) {
        state.outbox.push_back(change);
        self.flush(state);
    }

    /// Hands the outbox to the lane. Changes are queued under the registry's
    /// lock, in the order they happened, and published from the lane with no
    /// lock held: two threads updating jobs cannot publish out of order, and a
    /// publish never waits while holding the registry.
    fn flush(self: &Arc<Self>, state: MutexGuard<'_, State>) {
        let pending = !state.outbox.is_empty();
        drop(state);
        if !pending {
            return;
        }
        let inner = self.clone();
        // A stopped lane means the app is shutting down: nobody is listening.
        let _ = self.bus.lane().post(move || inner.publish_outbox());
    }

    fn publish_outbox(&self) {
        loop {
            let Some(next) = self.state().outbox.pop_front() else { return };
            let change = match next {
                Outgoing::Job(row) => JobChange { job: Some(row.finish()), removed: None },
                Outgoing::Removed(ids) => JobChange { job: None, removed: Some(ids) },
            };
            self.bus.publish(&JOBS_CHANGE, &change);
        }
    }

    fn timer_fired(self: &Arc<Self>, id: &str, generation: u64, timer: u64) {
        let now = self.bus.clock().now_ms();
        let mut state = self.state();
        if state.entry(id, generation).is_some_and(|e| e.timer == Some(timer)) {
            state.announce(id, now);
        }
        self.flush(state);
    }
}

/// A source's grip on the job it started. Calls on a job that was dropped or
/// started again do nothing.
#[derive(Clone)]
pub struct JobHandle {
    inner: Arc<Inner>,
    id: String,
    generation: u64,
}

impl std::fmt::Debug for JobHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JobHandle").field("id", &self.id).finish_non_exhaustive()
    }
}

impl JobHandle {
    pub fn id(&self) -> &str {
        &self.id
    }

    /// The job as the registry holds it.
    pub fn job(&self) -> Option<BackgroundJob> {
        self.inner.state().entry(&self.id, self.generation).map(|e| e.job.clone())
    }

    /// Changes the job; the change goes out within the throttle window.
    pub fn update(&self, change: impl FnOnce(&mut BackgroundJob)) {
        self.apply(change, false);
    }

    /// Changes the job and announces it at once.
    pub fn update_now(&self, change: impl FnOnce(&mut BackgroundJob)) {
        self.apply(change, true);
    }

    fn apply(&self, change: impl FnOnce(&mut BackgroundJob), immediate: bool) {
        let inner = &self.inner;
        let now = inner.bus.clock().now_ms();
        let mut state = inner.state();
        state.counter += 1;
        let timer = state.counter;
        let Some(entry) = state.entry(&self.id, self.generation) else { return };
        change(&mut entry.job);
        // How long until the throttle window since the last announcement is over.
        let wait = entry.sent_at.map_or(0, |sent| u64::try_from(sent + inner.throttle_ms - now).unwrap_or(0));
        if immediate || wait == 0 {
            state.announce(&self.id, now);
        } else if entry.timer.is_none() {
            entry.timer = Some(timer);
            let (registry, id, generation) = (inner.clone(), self.id.clone(), self.generation);
            inner.bus.lane().after(Duration::from_millis(wait), move || registry.timer_fired(&id, generation, timer));
        }
        inner.flush(state);
    }

    /// Ends the job. An ambient job leaves the list; any other stays as finished.
    pub fn finish(&self, status: JobStatus, change: impl FnOnce(&mut BackgroundJob)) {
        let inner = &self.inner;
        let now = inner.bus.clock().now_ms();
        let mut state = inner.state();
        let Some(entry) = state.entry(&self.id, self.generation) else { return };
        if entry.spec.ambient {
            state.entries.remove(&self.id);
            inner.send(state, Outgoing::Removed(vec![self.id.clone()]));
            return;
        }
        let was_running = entry.job.status == JobStatus::Running;
        change(&mut entry.job);
        entry.job.status = status;
        if was_running {
            entry.job.ended_at = Some(now);
        }
        state.announce(&self.id, now);
        if was_running {
            state.prune_finished(inner.finished_max);
        }
        inner.flush(state);
    }

    /// Adds to the output kept in memory (the newest 256 KiB are kept).
    pub fn append_output(&self, text: &str) {
        let mut state = self.inner.state();
        let Some(entry) = state.entry(&self.id, self.generation) else { return };
        let mem = entry.mem.get_or_insert_with(String::new);
        mem.push_str(text);
        if mem.len() > MEM_MAX {
            let mut cut = mem.len() - MEM_MAX;
            while !mem.is_char_boundary(cut) {
                cut += 1;
            }
            mem.drain(..cut);
            entry.mem_base += cut as u64;
        }
    }

    /// The file the job writes its output to.
    pub fn set_output_file(&self, path: Option<PathBuf>) {
        if let Some(entry) = self.inner.state().entry(&self.id, self.generation) {
            entry.output_file = path;
        }
    }

    /// Takes the job off the list.
    pub fn drop_job(&self) {
        let mut state = self.inner.state();
        if state.entry(&self.id, self.generation).is_none() {
            return;
        }
        state.entries.remove(&self.id);
        self.inner.send(state, Outgoing::Removed(vec![self.id.clone()]));
    }
}

/// The part of an output after `since`, at most [`JOB_OUTPUT_MAX`] of its
/// newest. `base` is the offset of `text`'s first byte in the whole output.
pub fn slice_output(text: &str, base: u64, since: u64) -> JobOutput {
    let end = base + text.len() as u64;
    let reset = since > end;
    let mut start = if reset { base } else { since.max(base) };
    let mut truncated = start > since && !reset;
    if end - start > JOB_OUTPUT_MAX as u64 {
        start = end - JOB_OUTPUT_MAX as u64;
        truncated = true;
    }
    let mut from = (start - base) as usize;
    while !text.is_char_boundary(from) {
        from += 1;
    }
    JobOutput { text: text[from..].to_owned(), next: end, truncated, reset }
}

fn read_file_output(path: &Path, since: u64) -> Option<JobOutput> {
    let mut file = File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    let reset = since > size;
    let mut start = if reset { 0 } else { since };
    let mut truncated = false;
    if size - start > JOB_OUTPUT_MAX as u64 {
        start = size - JOB_OUTPUT_MAX as u64;
        truncated = true;
    }
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::with_capacity((size - start) as usize);
    file.take(size - start).read_to_end(&mut bytes).ok()?;
    Some(JobOutput { text: String::from_utf8_lossy(&bytes).into_owned(), next: size, truncated, reset })
}

#[cfg(test)]
mod tests;
