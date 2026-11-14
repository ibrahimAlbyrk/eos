//! What happens around agents without anybody asking:
//!
//! - a chat left idle for a while has its session closed; the next message
//!   continues it;
//! - a top-level agent that ends a turn fires a banner with its last answer;
//! - a worker that goes idle without having reported is reminded once;
//! - a worker whose context fills up is reported to its parent, and parked
//!   when it is full;
//! - the folders of the active workers are watched for git changes.
//!
//! Everything kept per worker (a timer, a "reminded" mark) goes when the
//! worker's session ends or the worker is removed.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use eos_contracts::WorkerState;
use eos_contracts::stream::topics::{WORKER_CHANGE, WORKER_EXIT, WORKER_REMOVED, WORKER_REPORT, WORKER_SPAWN};
use eos_core::Error;
use eos_core::agent::ModelCatalog;
use eos_core::git::GitWatcher;
use eos_core::os::WatchLease;
use eos_core::store::{EventOrder, EventQuery};
use eos_domain::Worker;
use eos_domain::context::context_pct;
use eos_domain::envelope::Envelope;
use eos_domain::worker::is_active;
use eos_prompts::service::no_values;
use eos_runtime::bus::{Bus, Subscription};
use eos_runtime::idle::IdleHook;
use eos_runtime::jobs::{JobRegistry, JobStatus};
use eos_sessions::MessageInput;
use serde_json::Value;
use tokio::task::JoinHandle;

use crate::AgentsModule;

/// How long a chat sits idle before its session is closed.
const IDLE_SUSPEND: Duration = Duration::from_secs(15 * 60);
/// How long after a turn's end its banner waits (a queued message may start the next turn).
const TURN_END_DEFER: Duration = Duration::from_secs(1);
/// Changes of the worker list are gathered this long before the watches follow.
const RECONCILE_DEBOUNCE: Duration = Duration::from_millis(750);
/// How many of a turn's newest rows are searched for its last answer.
const ANSWER_ROWS: i64 = 60;
const BANNER_CHARS: usize = 160;

/// What the watchers work with besides the session service.
#[derive(Clone)]
pub struct Watch {
    pub bus: Bus,
    pub jobs: JobRegistry,
    pub git_watcher: Arc<dyn GitWatcher>,
    pub models: Arc<dyn ModelCatalog>,
}

impl std::fmt::Debug for Watch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Watch").finish_non_exhaustive()
    }
}

/// The watchers' memory.
#[derive(Default)]
pub(crate) struct Watching {
    /// One timer per idle chat.
    idle_timers: Mutex<HashMap<String, JoinHandle<()>>>,
    /// Workers that reported, and workers that were reminded to.
    reported: Mutex<HashSet<String>>,
    reminded: Mutex<HashSet<String>>,
    /// The folders watched for the active workers.
    watched: Mutex<HashMap<String, WatchLease>>,
    /// Each active worker's folder, by worker: what its tool calls may change.
    folders: Mutex<HashMap<String, PathBuf>>,
    reconcile: Mutex<Option<JoinHandle<()>>>,
    listening: Mutex<Vec<Subscription>>,
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Cuts `text` to `max` UTF-16 units, the last one an ellipsis.
fn truncate(text: &str, max: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= max {
        return text.to_owned();
    }
    let mut cut = String::from_utf16_lossy(&units[..max.saturating_sub(1)]);
    cut.push('…');
    cut
}

fn is_view_tool(name: &str) -> bool {
    let own = name.strip_prefix("mcp__orchestrator__").or_else(|| name.strip_prefix("mcp__worker__"));
    matches!(own, Some("present" | "present_app"))
}

/// What one recorded assistant message says: its text, or what a visual
/// answer in it is about.
fn said(message: &Value) -> Option<String> {
    if message["type"] != "message" || message["role"] != "assistant" {
        return None;
    }
    let (mut last, mut parts): (Option<String>, Vec<&str>) = (None, Vec::new());
    for block in message["blocks"].as_array().into_iter().flatten() {
        match block["type"].as_str() {
            Some("text") => parts.extend(block["text"].as_str().filter(|text| !text.trim().is_empty())),
            Some("tool_call") if block["parentCallId"].is_null() && is_view_tool(block["name"].as_str()?) => {
                let about = ["summary", "title"].iter().find_map(|key| block["input"][key].as_str());
                if let Some(about) = about.filter(|about| !about.trim().is_empty()) {
                    last = Some(about.to_owned());
                    parts.clear();
                }
            }
            _ => {}
        }
    }
    if parts.is_empty() { last } else { Some(parts.join("\n")) }
}

/// Where git changes of a worker are watched: its worktree once it exists,
/// else its folder (`gitWorkingDirOf`).
fn git_dir(worker: &Worker) -> Option<&str> {
    match &worker.worktree_dir {
        Some(dir) => worker.workspace_ready.then_some(dir.as_str()),
        None => worker.cwd.as_deref().or(worker.worktree_from.as_deref()),
    }
}

impl AgentsModule {
    fn watch(&self) -> Option<&Watch> {
        self.watch.as_ref()
    }

    /// Why an idle chat keeps its session, or `None` when it can be closed.
    /// `Err(())`: it is no longer an idle chat that could be closed at all.
    async fn idle_keep_reason(&self, id: &str) -> Result<Option<&'static str>, ()> {
        let Ok(Some(row)) = self.worker(id).await else { return Err(()) };
        let resumable = self.sessions.descriptor().capabilities.resumable == Some(true);
        if row.state != WorkerState::Idle || !resumable || row.session_id.as_deref().is_none_or(str::is_empty) {
            return Err(());
        }
        // A peer asks it directly, which only reaches a live session.
        if row.collaborate {
            return Ok(Some("collaborating"));
        }
        if self.sessions.live_subagents(id) > 0 {
            return Ok(Some("subagents running"));
        }
        let running = |jobs: &JobRegistry| {
            jobs.list().iter().any(|j| j.worker_id.as_deref() == Some(id) && j.status == JobStatus::Running)
        };
        if self.watch().is_some_and(|w| running(&w.jobs)) {
            return Ok(Some("background job running"));
        }
        if self.sessions.is_held(id) {
            return Ok(Some("held"));
        }
        let worker = id.to_owned();
        let busy = self
            .store
            .read(move |tx| {
                if !tx.message_queue().list_pending(&worker)?.is_empty() {
                    return Ok(Some("messages queued"));
                }
                // Its sub-workers report and ask for approvals through it.
                let children = tx.workers().list_by_parent(&worker)?;
                Ok(children.iter().any(|child| is_active(child.state)).then_some("sub-workers running"))
            })
            .await;
        busy.map_err(|_| ())
    }

    /// (Re)starts the idle timer of a chat that just went idle; any other
    /// state stops it.
    fn track_idle(&self, id: &str, idle: bool) {
        let mut timers = locked(&self.watching.idle_timers);
        if let Some(timer) = timers.remove(id) {
            timer.abort();
        }
        if !idle {
            return;
        }
        let (m, worker) = (self.clone(), id.to_owned());
        let timer = tokio::spawn(async move {
            loop {
                tokio::time::sleep(IDLE_SUSPEND).await;
                match m.idle_keep_reason(&worker).await {
                    Ok(Some(_)) => continue,
                    Ok(None) => {
                        if let Err(e) = m.sessions.suspend(&worker, "idle").await {
                            tracing::warn!(worker_id = %worker, error = %e, "an idle chat could not be suspended");
                        }
                    }
                    Err(()) => {}
                }
                break;
            }
            locked(&m.watching.idle_timers).remove(&worker);
        });
        timers.insert(id.to_owned(), timer);
    }

    /// The banner of a top-level agent's finished turn: its name and the
    /// start of its last answer.
    async fn turn_end_banner(&self, id: &str) -> Result<(), Error> {
        let Some(row) = self.worker(id).await? else { return Ok(()) };
        let Some(turn_started_at) = row.turn_started_at.filter(|_| row.parent_id.is_none()) else { return Ok(()) };
        if row.state != WorkerState::Idle || self.sessions.live_subagents(id) > 0 {
            return Ok(());
        }
        let query = EventQuery {
            worker_id: id.to_owned(),
            since: turn_started_at - 1,
            limit: ANSWER_ROWS,
            order: EventOrder::Desc,
            before_id: None,
            after_id: None,
        };
        let rows = self.store.read(move |tx| tx.events().list(&query)).await?;
        // Newest first: the first answer found is the turn's last.
        let answer = rows.iter().filter(|row| row.kind == "agent_event").find_map(|row| {
            said(&row.payload.as_deref().and_then(|p| serde_json::from_str(p).ok()).unwrap_or(Value::Null))
        });
        let Some(answer) = answer else { return Ok(()) };
        let flat = answer.split_whitespace().collect::<Vec<_>>().join(" ");
        self.notify_user(id, row.name.as_deref().unwrap_or(id), &truncate(&flat, BANNER_CHARS)).await
    }

    /// A worker that went idle without reporting to its parent is told to,
    /// once (`ReportGapService`).
    async fn remind_to_report(&self, id: &str) {
        if locked(&self.watching.reminded).contains(id) || locked(&self.watching.reported).contains(id) {
            return;
        }
        let worker = id.to_owned();
        let due = self
            .store
            .read(move |tx| {
                let Some(row) = tx.workers().find(&worker)? else { return Ok(false) };
                let is_worker = row.agent_role.as_deref() == Some("worker") && row.parent_id.is_some();
                Ok(is_worker && row.state == WorkerState::Idle)
            })
            .await;
        if !matches!(due, Ok(true)) || !self.sessions.is_live(id) {
            return;
        }
        locked(&self.watching.reminded).insert(id.to_owned());
        let text = match self.spawning.prompts.render("system/report-reminder", &no_values(), &no_values()) {
            Ok(text) => text.trim().to_owned(),
            Err(e) => return tracing::warn!(worker_id = id, error = %e, "the report reminder could not be rendered"),
        };
        let reminder = MessageInput {
            worker_id: id.to_owned(),
            display_text: Some(text.clone()),
            text,
            envelope: Some(Envelope::ReportReminder),
            queue_when_busy: true,
            origin: Some("report-reminder".into()),
            ..MessageInput::default()
        };
        if let Err(e) = self.sessions.dispatch(reminder).await {
            tracing::warn!(worker_id = id, error = %e, "the report reminder could not be delivered");
        }
    }

    /// Tells a worker's parent when its context is nearly full, and parks the
    /// worker when it is full; once per crossing (`ContextThresholdService`).
    async fn check_context(&self, id: &str) -> Result<(), Error> {
        let Some(watch) = self.watch() else { return Ok(()) };
        let Some(row) = self.worker(id).await? else { return Ok(()) };
        let Some(parent_id) = row.parent_id.clone() else { return Ok(()) };
        let used = row.last_context_tokens.unwrap_or(0);
        let Some(pct) = context_pct(used, Some(watch.models.context_window_for(row.model.as_deref()))) else {
            return Ok(());
        };
        let (worker, now) = (id.to_owned(), self.sessions.clock().now_ms());
        if used == 0 {
            return self.store.write(move |tx, _| tx.context_marks().clear(&worker)).await;
        }
        let limits = self.spawning.config.current().context.clone();
        let stage = match pct as f64 {
            pct if pct >= limits.full_ratio * 100.0 => "full",
            pct if pct >= limits.warn_ratio * 100.0 => "warn90",
            _ => return Ok(()),
        };
        if !self.store.write(move |tx, _| tx.context_marks().mark(&worker, stage, now)).await? {
            return Ok(());
        }
        let name = row.name.clone().unwrap_or_else(|| id.to_owned());
        let text = match stage {
            "full" => {
                self.sessions.suspend(id, "context_full").await?;
                "agent'ın context'i doldu ve durduruldu".to_owned()
            }
            _ => format!("{name} worker'ının context'i dolmak üzere, %90'a ulaştı"),
        };
        let notice = MessageInput {
            worker_id: parent_id,
            display_text: Some(text.clone()),
            text,
            envelope: Some(Envelope::ContextThreshold {
                stage: stage.to_owned(),
                from_worker: id.to_owned(),
                worker_name: Some(name),
                pct: (stage == "warn90").then_some(pct as f64),
            }),
            queue_when_busy: true,
            origin: Some("context-threshold".into()),
            ..MessageInput::default()
        };
        self.sessions.dispatch(notice).await.map(|_| ())
    }

    /// The idle-edge watchers, after compaction (10).
    pub(crate) fn watch_hooks(&self) -> Vec<IdleHook> {
        if self.watch.is_none() {
            return Vec::new();
        }
        let (gap, context) = (self.clone(), self.clone());
        vec![
            IdleHook::new("report-gap", 30, move |id| {
                let (m, id) = (gap.clone(), id.to_owned());
                async move {
                    m.remind_to_report(&id).await;
                    false
                }
            }),
            IdleHook::new("context-threshold", 40, move |id| {
                let (m, id) = (context.clone(), id.to_owned());
                async move {
                    if let Err(e) = m.check_context(&id).await {
                        tracing::warn!(worker_id = %id, error = %e, "the context check failed");
                    }
                    false
                }
            }),
        ]
    }

    /// Watches exactly the folders of the active workers.
    async fn reconcile_watches(&self) {
        let Some(watch) = self.watch() else { return };
        let Ok(rows) = self.store.read(|tx| tx.workers().list_all()).await else { return };
        let active = || rows.iter().filter(|w| is_active(w.state));
        *locked(&self.watching.folders) =
            active().filter_map(|w| git_dir(w).map(|dir| (w.id.clone(), PathBuf::from(dir)))).collect();
        let desired: HashSet<String> = active().filter_map(git_dir).map(str::to_owned).collect();
        let mut watched = locked(&self.watching.watched);
        watched.retain(|dir, _| desired.contains(dir));
        for dir in desired {
            let folder = Path::new(&dir).to_owned();
            watched.entry(dir).or_insert_with(|| watch.git_watcher.watch(&folder));
        }
    }

    fn schedule_reconcile(&self) {
        let mut pending = locked(&self.watching.reconcile);
        if pending.as_ref().is_some_and(|task| !task.is_finished()) {
            return;
        }
        let m = self.clone();
        *pending = Some(tokio::spawn(async move {
            tokio::time::sleep(RECONCILE_DEBOUNCE).await;
            m.reconcile_watches().await;
        }));
    }

    /// A tool of the worker's agent ran: what git shows of its folder may
    /// have changed before the folder's watch says so.
    pub(crate) fn tool_ran(&self, worker_id: &str) {
        if let Some(folder) = locked(&self.watching.folders).get(worker_id) {
            self.git().state.touched(folder);
        }
    }

    /// Everything a worker's end frees.
    fn forget(&self, id: &str) {
        self.track_idle(id, false);
        locked(&self.watching.folders).remove(id);
        locked(&self.watching.reported).remove(id);
        locked(&self.watching.reminded).remove(id);
    }

    /// Starts listening. Called from a task of the runtime.
    pub(crate) fn start_watching(&self) {
        let Some(watch) = self.watch().cloned() else { return };
        let tasks = tokio::runtime::Handle::current();
        let mut listening = locked(&self.watching.listening);

        let (m, runtime) = (self.clone(), tasks.clone());
        listening.push(watch.bus.on(WORKER_CHANGE, move |event| {
            let Ok(change) = event.payload_as::<Value>() else { return };
            let Some(id) = change["workerId"].as_str() else { return };
            let _in_runtime = runtime.enter();
            m.schedule_reconcile();
            let Some(state) = change["state"].as_str() else { return };
            m.track_idle(id, state == "IDLE");
            if state == "IDLE" && change["from"] == "WORKING" {
                let (m, id) = (m.clone(), id.to_owned());
                runtime.spawn(async move {
                    tokio::time::sleep(TURN_END_DEFER).await;
                    if let Err(e) = m.turn_end_banner(&id).await {
                        tracing::warn!(worker_id = %id, error = %e, "a turn's banner could not be sent");
                    }
                });
            }
        }));
        let m = self.clone();
        listening.push(watch.bus.on(WORKER_REPORT, move |event| {
            let reported = event.payload_as::<Value>().ok().and_then(|p| p["workerId"].as_str().map(str::to_owned));
            if let Some(id) = reported {
                locked(&m.watching.reported).insert(id);
            }
        }));
        for topic in [WORKER_SPAWN, WORKER_EXIT, WORKER_REMOVED] {
            let (m, runtime) = (self.clone(), tasks.clone());
            listening.push(watch.bus.on(topic, move |event| {
                let _in_runtime = runtime.enter();
                m.schedule_reconcile();
                let gone = event.payload_as::<Value>().ok().and_then(|p| p["workerId"].as_str().map(str::to_owned));
                if let (Some(id), true) = (gone, topic != WORKER_SPAWN) {
                    m.forget(&id);
                }
            }));
        }
        drop(listening);
        // The workers the start-up found: nothing is active yet, so nothing is watched.
        self.schedule_reconcile();
    }

    /// Stops listening and ends every timer and watch.
    pub(crate) fn stop_watching(&self) {
        locked(&self.watching.listening).clear();
        for (_, timer) in locked(&self.watching.idle_timers).drain() {
            timer.abort();
        }
        if let Some(task) = locked(&self.watching.reconcile).take() {
            task.abort();
        }
        locked(&self.watching.watched).clear();
        locked(&self.watching.folders).clear();
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_turns_banner_reads_the_answer_or_what_a_visual_answer_is_about() {
        let message = |blocks: Value| json!({"type": "message", "role": "assistant", "blocks": blocks});
        assert_eq!(
            said(&message(json!([{"type": "text", "text": "Done."}, {"type": "text", "text": " "}]))),
            Some("Done.".into())
        );
        let view =
            json!({"type": "tool_call", "name": "mcp__worker__present", "input": {"summary": "Three cafés nearby"}});
        assert_eq!(said(&message(json!([{"type": "text", "text": "Here:"}, view]))), Some("Three cafés nearby".into()));
        let inner =
            json!({"type": "tool_call", "name": "mcp__worker__present", "parentCallId": "c1", "input": {"title": "x"}});
        assert_eq!(said(&message(json!([inner]))), None, "a subagent's view is not the agent's answer");
        let other = json!({"type": "tool_call", "name": "Bash", "input": {"title": "x"}});
        assert_eq!(said(&message(json!([other]))), None);
        assert_eq!(said(&json!({"type": "message", "role": "user", "blocks": [{"type": "text", "text": "hi"}]})), None);
        assert_eq!(truncate("héllo wörld", 6), "héllo…");
    }
}
