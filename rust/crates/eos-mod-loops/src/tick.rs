//! The goal gate (`core/src/use-cases/runLoopTick.ts`, `manager/services/GoalLoopService.ts`).
//!
//! It runs when a looped worker settles at IDLE with nothing queued, checks
//! the goal, and the first of these that holds decides:
//!
//! 1. met: the held report goes to the parent (or a completion written for a
//!    worker that left none); the loop passed;
//! 2. the check itself failed (indeterminate): a neutral nudge, no attempt
//!    counted; twice in a row ends the loop;
//! 3. every unmet criterion is one no artifact could prove: escalated — the
//!    report goes to the parent as unverified and the loop waits for its answer;
//! 4. the attempt limit: exhausted, the report goes up with why;
//! 5. no progress across the window: frozen or cycling ends the loop, a
//!    stalled thrasher escalates;
//! 6. otherwise the held report was a claim the check rejected: it is dropped
//!    and the worker is sent the unmet criteria.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};

use eos_contracts::stream::topics::{LOOP_CHANGE, LOOP_CHECK, WORKER_CHANGE};
use eos_contracts::{
    GoalSpec, GoalVerdict, LoopCheckEvent, LoopCheckOutcome, LoopCheckPhase, LoopCheckProgress, LoopStatus,
    WorkerEventType, WorkerState,
};
use eos_core::Error;
use eos_core::git::GitDiffs;
use eos_core::store::{ConfigSource, Store};
use eos_domain::envelope::Envelope;
use eos_domain::loops::feedback::{
    CHECK_ERROR, CONTINUATION, ESCALATION, EXHAUSTED_RELEASE, LOOP_COMPLETE, LOOP_EXHAUSTED, check_error_vars,
    continuation_vars, escalation_vars, exhausted_release_vars, loop_complete_vars, loop_exhausted_vars,
};
use eos_domain::loops::progress::{NoProgress, detect_no_progress, outcome_key, state_hash, with_attempt};
use eos_domain::loops::{LoopAttempt, WorkerLoop};
use eos_prompts::PromptService;
use eos_prompts::service::no_values;
use eos_runtime::bus::Bus;
use eos_sessions::{MessageInput, Sessions};
use serde_json::{Map, Value, json};

use crate::check::{Checker, Subject};
use crate::commands::{Memo, VerifyCommands};

/// How a tick ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Tick {
    /// Nothing to do: no active loop, or it waits for an answer.
    Noop,
    Released,
    Continued,
    Exhausted,
    Escalated,
}

impl Tick {
    /// The loop's status to announce after the tick.
    fn status(self) -> Option<LoopStatus> {
        match self {
            Self::Noop => None,
            Self::Continued | Self::Escalated => Some(LoopStatus::Active),
            Self::Released => Some(LoopStatus::Passed),
            Self::Exhausted => Some(LoopStatus::Exhausted),
        }
    }

    fn outcome(self) -> Option<LoopCheckOutcome> {
        match self {
            Self::Noop => None,
            Self::Released => Some(LoopCheckOutcome::Released),
            Self::Continued => Some(LoopCheckOutcome::Continued),
            Self::Exhausted => Some(LoopCheckOutcome::Exhausted),
            Self::Escalated => Some(LoopCheckOutcome::Escalated),
        }
    }
}

/// Who wrote a message to the parent: the worker (its held report), or the
/// app for a worker that left none.
fn provenance(held: Option<&str>) -> &'static str {
    if held.is_some() { "agent" } else { "system" }
}

/// What the engine runs on.
pub(crate) struct Engine {
    pub(crate) store: Arc<dyn Store>,
    pub(crate) sessions: Sessions,
    pub(crate) config: Arc<dyn ConfigSource>,
    pub(crate) prompts: Arc<PromptService>,
    pub(crate) diffs: Arc<dyn GitDiffs>,
    pub(crate) commands: Arc<dyn VerifyCommands>,
    pub(crate) checker: Checker,
    pub(crate) bus: Bus,
    /// Workers whose tick runs: one at a time each.
    ticking: Mutex<HashSet<String>>,
}

/// Removes the worker from the ticking set when the tick ends, however it ends.
struct Ticking<'a> {
    engine: &'a Engine,
    worker_id: String,
}

impl Drop for Ticking<'_> {
    fn drop(&mut self) {
        self.engine.ticking.lock().unwrap_or_else(PoisonError::into_inner).remove(&self.worker_id);
    }
}

impl Engine {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        store: Arc<dyn Store>,
        sessions: Sessions,
        config: Arc<dyn ConfigSource>,
        prompts: Arc<PromptService>,
        diffs: Arc<dyn GitDiffs>,
        commands: Arc<dyn VerifyCommands>,
        checker: Checker,
        bus: Bus,
    ) -> Self {
        Self { store, sessions, config, prompts, diffs, commands, checker, bus, ticking: Mutex::default() }
    }

    fn now(&self) -> i64 {
        self.sessions.clock().now_ms()
    }

    fn render(&self, id: &str, vars: &Map<String, Value>) -> Result<String, Error> {
        let text = self.prompts.render(id, vars, &no_values()).map_err(|e| Error::Storage(e.to_string()))?;
        Ok(text.trim().to_owned())
    }

    /// Checks the worker's goal if it is due: idle, live, a loop active,
    /// nothing queued, no tick of it already running.
    pub(crate) async fn tick_for(&self, worker_id: &str) -> Result<Tick, Error> {
        if !self.ticking.lock().unwrap_or_else(PoisonError::into_inner).insert(worker_id.to_owned()) {
            return Ok(Tick::Noop);
        }
        let _ticking = Ticking { engine: self, worker_id: worker_id.to_owned() };
        let id = worker_id.to_owned();
        let (worker, active, queued) = self
            .store
            .read(move |tx| {
                Ok((
                    tx.workers().find(&id)?,
                    tx.loops().find_active_by_worker(&id)?,
                    tx.message_queue().list_pending(&id)?,
                ))
            })
            .await?;
        let (Some(worker), Some(active)) = (worker, active) else { return Ok(Tick::Noop) };
        // A queued message or a waiting peer always goes before a self-continue.
        if worker.state != WorkerState::Idle || !self.sessions.is_live(worker_id) || !queued.is_empty() {
            return Ok(Tick::Noop);
        }
        let subject = Subject {
            worker_id: worker.id.clone(),
            worktree_dir: worker.worktree_dir.as_ref().map(PathBuf::from),
            cwd: worker.cwd.as_ref().map(PathBuf::from),
            fork_base_sha: worker.fork_base_sha.clone(),
            report: active.held_report.clone(),
        };
        let tick = self.run(active, subject).await?;
        if let Some(status) = tick.status() {
            let payload = json!({"workerId": worker_id, "status": status});
            self.store
                .write(move |_, out| {
                    out.push(LOOP_CHANGE, &payload);
                    Ok(())
                })
                .await?;
        }
        Ok(tick)
    }

    /// The live progress of a check, and its verdict on the worker's timeline.
    fn progress(&self, active: &WorkerLoop, phase: LoopCheckPhase, criterion: Option<&str>) {
        let update = LoopCheckProgress {
            worker_id: active.worker_id.clone(),
            attempt: active.attempt + 1,
            max_attempts: active.max_attempts,
            strategy: active.strategy,
            phase,
            criterion_id: criterion.map(str::to_owned),
            met: None,
            outcome: None,
            reason: None,
        };
        self.publish_check(&update);
    }

    fn publish_check(&self, update: &LoopCheckProgress) {
        if let Ok(payload) = serde_json::to_vec(update) {
            self.bus.publish_raw(LOOP_CHECK, None, payload.into());
        }
    }

    async fn verdict(&self, active: &WorkerLoop, verdict: &GoalVerdict, tick: Tick, reason: &str) -> Result<(), Error> {
        let Some(outcome) = tick.outcome() else { return Ok(()) };
        let update = LoopCheckProgress {
            worker_id: active.worker_id.clone(),
            attempt: active.attempt + 1,
            max_attempts: active.max_attempts,
            strategy: active.strategy,
            phase: LoopCheckPhase::Verdict,
            criterion_id: None,
            met: Some(verdict.met),
            outcome: Some(outcome),
            reason: Some(reason.to_owned()),
        };
        self.publish_check(&update);
        let event = LoopCheckEvent {
            attempt: update.attempt,
            max_attempts: update.max_attempts,
            strategy: update.strategy,
            met: verdict.met,
            outcome,
            reason: reason.to_owned(),
        };
        let (id, now) = (active.worker_id.clone(), self.now());
        self.store
            .write(move |tx, out| {
                let row_id = tx.events().append_json(&id, now, WorkerEventType::LoopCheck, &event)?;
                out.push(WORKER_CHANGE, &json!({"workerId": id, "rowId": row_id}));
                Ok(())
            })
            .await
    }

    async fn send_worker(&self, worker_id: &str, text: String, attempt: Option<i64>) -> Result<(), Error> {
        let message = MessageInput {
            worker_id: worker_id.to_owned(),
            display_text: Some(text.clone()),
            text,
            queue_when_busy: true,
            origin: Some("loop".into()),
            envelope: Some(Envelope::Loop { attempt }),
            ..MessageInput::default()
        };
        self.sessions.dispatch(message).await.map(drop)
    }

    /// Writes the loop's new state in one job.
    async fn update(
        &self,
        change: impl FnOnce(&dyn eos_core::store::Tx, i64) -> Result<(), Error> + Send + 'static,
    ) -> Result<(), Error> {
        let now = self.now();
        self.store.write(move |tx, _| change(tx, now)).await
    }

    async fn run(&self, active: WorkerLoop, subject: Subject) -> Result<Tick, Error> {
        if active.awaiting_input {
            return Ok(Tick::Noop);
        }
        let Some(goal) = active.goal_spec() else {
            tracing::warn!(loop_id = active.id, "a loop's goal is of an older shape: it is not checked");
            return Ok(Tick::Noop);
        };
        let memo = Memo::new(self.commands.clone());
        self.progress(&active, LoopCheckPhase::Started, None);
        let report = |phase: LoopCheckPhase, criterion: Option<&str>| self.progress(&active, phase, criterion);
        let verdict = self.checker.evaluate(active.strategy, &goal, &subject, &memo, &report).await;
        // The work passes the worker has made: its first report and every re-trigger since.
        let attempts_made = active.attempt + 1;
        let loop_id = active.id.clone();

        if verdict.met {
            self.verdict(&active, &verdict, Tick::Released, &verdict.reason).await?;
            if let Some(parent) = &active.parent_id {
                let text = match &active.held_report {
                    Some(held) => held.clone(),
                    None => self.render(LOOP_COMPLETE, &loop_complete_vars(&goal, attempts_made))?,
                };
                self.sessions
                    .release_report(&active.worker_id, parent, &text, provenance(active.held_report.as_deref()))
                    .await?;
            }
            let clear = active.parent_id.is_some() && active.held_report.is_some();
            self.update(move |tx, now| {
                if clear {
                    tx.loops().set_held_report(&loop_id, None, now)?;
                }
                tx.loops().set_status(&loop_id, LoopStatus::Passed, now)
            })
            .await?;
            tracing::info!(worker_id = active.worker_id, "loop goal met");
            return Ok(Tick::Released);
        }

        if verdict.indeterminate == Some(true) {
            let consecutive = active.check_failures + 1;
            if consecutive >= 2 {
                return self
                    .exhaust(&active, &goal, &verdict, "goal check failing (judge/evidence infrastructure)")
                    .await;
            }
            self.update(move |tx, now| tx.loops().set_check_failures(&loop_id, consecutive, now)).await?;
            self.verdict(&active, &verdict, Tick::Continued, &verdict.reason).await?;
            self.send_worker(&active.worker_id, self.render(CHECK_ERROR, &check_error_vars(&goal))?, None).await?;
            return Ok(Tick::Continued);
        }
        if active.check_failures > 0 {
            let id = loop_id.clone();
            self.update(move |tx, now| tx.loops().set_check_failures(&id, 0, now)).await?;
        }

        let unverifiable: HashSet<&str> =
            verdict.criteria.iter().filter(|c| !c.met && c.unverifiable == Some(true)).map(|c| c.id.as_str()).collect();
        if !verdict.unmet.is_empty() && verdict.unmet.iter().all(|id| unverifiable.contains(id.as_str())) {
            let reason = format!(
                "the gate cannot verify criteria [{}] with the evidence it collects (verify outputs, change diff, criteria-named files)",
                verdict.unmet.join(", ")
            );
            return self.escalate(&active, &goal, &verdict, &reason).await;
        }

        let next_attempt = active.attempt + 1;
        if active.max_attempts.is_some_and(|max| next_attempt > max) {
            return self.exhaust(&active, &goal, &verdict, "the attempt limit was reached").await;
        }

        let hash = self.state_hash(&subject).await;
        let entry = LoopAttempt {
            state_hash: hash.clone(),
            outcome_hash: outcome_key(&verdict.unmet),
            unmet_count: i64::try_from(verdict.unmet.len()).unwrap_or(i64::MAX),
            reason: verdict.reason.clone(),
        };
        let config = self.config.current();
        let window = usize::try_from(config.r#loop.no_progress_window).unwrap_or(0);
        // No change-set to hash: progress cannot be measured.
        if config.r#loop.stop_on_no_progress && !hash.is_empty() {
            match detect_no_progress(&with_attempt(&active.progress_ring, entry.clone()), window) {
                Some(NoProgress::Stalled) => {
                    let reason = format!(
                        "{window} attempts changed the code but closed no criterion — amend the goal, stop the loop, or reply to continue"
                    );
                    return self.escalate(&active, &goal, &verdict, &reason).await;
                }
                Some(NoProgress::Frozen) => {
                    let reason = format!(
                        "no progress — the worker produced an identical change-set across the last {window} attempts"
                    );
                    return self.exhaust(&active, &goal, &verdict, &reason).await;
                }
                Some(NoProgress::Oscillation) => {
                    let reason =
                        "no progress — the worker is cycling between a few change-sets without closing criteria";
                    return self.exhaust(&active, &goal, &verdict, reason).await;
                }
                None => {}
            }
        }

        // The held report claimed completion and the check rejected it: dropped, the worker goes on.
        self.verdict(&active, &verdict, Tick::Continued, &verdict.reason).await?;
        let drop_held = active.held_report.is_some();
        self.update(move |tx, now| {
            if drop_held {
                tx.loops().set_held_report(&loop_id, None, now)?;
            }
            tx.loops().record_attempt(&loop_id, &entry, now)
        })
        .await?;
        let text = self.render(CONTINUATION, &continuation_vars(&goal, &verdict, next_attempt))?;
        self.send_worker(&active.worker_id, text, Some(next_attempt)).await?;
        tracing::info!(worker_id = active.worker_id, attempt = next_attempt, "loop re-triggered");
        Ok(Tick::Continued)
    }

    /// Ends an unmet loop: the held report goes up annotated with why, or a
    /// message saying so for a worker that left none.
    async fn exhaust(
        &self,
        active: &WorkerLoop,
        goal: &GoalSpec,
        verdict: &GoalVerdict,
        reason: &str,
    ) -> Result<Tick, Error> {
        self.verdict(active, verdict, Tick::Exhausted, reason).await?;
        if let Some(parent) = &active.parent_id {
            let text = match &active.held_report {
                Some(held) => self.render(EXHAUSTED_RELEASE, &exhausted_release_vars(goal, verdict, reason, held))?,
                None => self.render(LOOP_EXHAUSTED, &loop_exhausted_vars(goal, verdict, reason, active.attempt + 1))?,
            };
            self.sessions
                .release_report(&active.worker_id, parent, &text, provenance(active.held_report.as_deref()))
                .await?;
        }
        let (loop_id, clear) = (active.id.clone(), active.parent_id.is_some() && active.held_report.is_some());
        self.update(move |tx, now| {
            if clear {
                tx.loops().set_held_report(&loop_id, None, now)?;
            }
            tx.loops().set_status(&loop_id, LoopStatus::Exhausted, now)
        })
        .await?;
        tracing::info!(worker_id = active.worker_id, reason, "loop exhausted");
        Ok(Tick::Exhausted)
    }

    /// Pauses an unmet loop for a decision, never a pass: the report goes up
    /// as unverified, and the loop waits until the parent's answer reaches the
    /// worker. A fresh no-progress window starts.
    async fn escalate(
        &self,
        active: &WorkerLoop,
        goal: &GoalSpec,
        verdict: &GoalVerdict,
        reason: &str,
    ) -> Result<Tick, Error> {
        self.verdict(active, verdict, Tick::Escalated, reason).await?;
        if let Some(parent) = &active.parent_id {
            let report = active.held_report.as_deref().unwrap_or("(the worker left no report)");
            let text = self.render(ESCALATION, &escalation_vars(goal, verdict, reason, report))?;
            self.sessions
                .release_report(&active.worker_id, parent, &text, provenance(active.held_report.as_deref()))
                .await?;
        }
        let (loop_id, clear) = (active.id.clone(), active.held_report.is_some());
        self.update(move |tx, now| {
            if clear {
                tx.loops().set_held_report(&loop_id, None, now)?;
            }
            tx.loops().set_awaiting_input(&loop_id, true, now)?;
            tx.loops().reset_progress(&loop_id, now)
        })
        .await?;
        tracing::info!(worker_id = active.worker_id, reason, "loop escalated");
        Ok(Tick::Escalated)
    }

    /// The fingerprint of the worker's change-set; empty when it has no folder.
    async fn state_hash(&self, subject: &Subject) -> String {
        let Some(dir) = subject.worktree_dir.as_deref().or(subject.cwd.as_deref()) else { return String::new() };
        let base = subject.fork_base_sha.as_deref();
        let diff = self.diffs.full_diff(dir, base).await;
        let changed = self.diffs.changed_files(dir, base).await;
        state_hash(diff.as_deref(), &changed)
    }
}
