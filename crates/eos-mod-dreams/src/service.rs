//! When to dream, and one dream at a time.
//!
//! A tick every minute checks the schedule (tonight's slot, or an away
//! stretch); "Dream now" runs on demand, whether or not dreaming is switched
//! on. Before any model request: a Claude sign-in (a dream never bills an API
//! key) and plan usage under the user's line — a night held off is recorded
//! as skipped. While a scheduled dream runs, the user coming back stops it
//! after the current chat. Every step is announced as `dream:change`; the
//! morning note goes out when a dream filed proposals.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use eos_contracts::stream::topics::NOTIFICATION_FIRE;
use eos_contracts::{
    DreamBlock, DreamChangeEvent, DreamProgress, DreamRun, DreamRunStatus, DreamSchedule, DreamStatus, DreamTrigger,
    DreamingSettings, WorkerState,
};
use eos_core::Error;
use eos_core::accounts::PlanAccess;
use eos_runtime::bus::Bus;
use eos_runtime::jobs::{JobActionError, JobHandle, JobProgress, JobRegistry, JobSpec, JobStatus};
use serde_json::json;

use crate::rules::{empty_dropped, is_away_due, is_nightly_due, next_nightly};
use crate::run::{DreamParts, dream_over_chats};
use crate::{DREAM_CHANGE, JOB_KIND};

/// The provider dreams run on.
const PROVIDER: &str = "anthropic";

struct Running {
    trigger: DreamTrigger,
    progress: Option<DreamProgress>,
    stop: bool,
}

#[derive(Default)]
struct State {
    running: Option<Running>,
    /// When dreaming was last switched on: switching it on in the afternoon
    /// waits for tonight instead of dreaming at once.
    enabled_at: i64,
    was_enabled: Option<bool>,
    last_user_at: i64,
    job: Option<JobHandle>,
    jobs_started: u64,
}

struct Inner {
    parts: DreamParts,
    plan: Arc<dyn PlanAccess>,
    bus: Bus,
    jobs: JobRegistry,
    state: Mutex<State>,
}

/// Cheap to clone.
#[derive(Clone)]
pub struct Dreams(Arc<Inner>);

impl std::fmt::Debug for Dreams {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Dreams").field("running", &self.state().running.is_some()).finish_non_exhaustive()
    }
}

fn percent(share: f64) -> i64 {
    (share * 100.0 + 0.5).floor() as i64
}

impl Dreams {
    pub fn new(parts: DreamParts, plan: Arc<dyn PlanAccess>, bus: Bus, jobs: JobRegistry) -> Self {
        let state = State { last_user_at: parts.clock.now_ms(), ..State::default() };
        Self(Arc::new(Inner { parts, plan, bus, jobs, state: Mutex::new(state) }))
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.0.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn settings(&self) -> DreamingSettings {
        self.0.parts.profile.get().dreaming.clone()
    }

    fn now(&self) -> i64 {
        self.0.parts.clock.now_ms()
    }

    fn offset_at(&self) -> impl Fn(i64) -> i32 + '_ {
        |at| self.0.parts.zone.offset_minutes_at(at)
    }

    /// An Eos Claude sign-in, or the setup-token of an install from before sign-ins.
    fn signed_in(&self) -> bool {
        let token = self.0.parts.config.current().anthropic.auth_token.clone();
        !self.0.plan.logins(PROVIDER).is_empty() || token.is_some_and(|t| !t.trim().is_empty())
    }

    async fn latest(&self) -> Option<DreamRun> {
        self.0.parts.store.read(|tx| tx.dreams().list(1)).await.ok().and_then(|runs| runs.into_iter().next())
    }

    /// A top-level chat started working: the user is here.
    pub fn note_user_activity(&self) {
        let mut state = self.state();
        state.last_user_at = self.now();
        if let Some(running) = state.running.as_mut().filter(|r| r.trigger != DreamTrigger::Manual) {
            running.stop = true;
        }
    }

    /// Asks the running dream to stop after its current chat; `false` when none runs.
    pub fn request_stop(&self) -> bool {
        self.state().running.as_mut().map(|running| running.stop = true).is_some()
    }

    fn since(&self, latest: Option<&DreamRun>) -> i64 {
        latest.map_or(0, |run| run.started_at.0 as i64).max(self.state().enabled_at)
    }

    pub async fn status(&self) -> DreamStatus {
        let (settings, now, last_run) = (self.settings(), self.now(), self.latest().await);
        let nightly = settings.enabled && settings.schedule == DreamSchedule::Nightly;
        let next_at = nightly.then(|| {
            let (at, offset_at) = (settings.nightly_at.as_str(), self.offset_at());
            if is_nightly_due(now, at, self.since(last_run.as_ref()), &offset_at) {
                now
            } else {
                next_nightly(now, at, &offset_at)
            }
        });
        let blocked = match (settings.enabled, self.signed_in()) {
            (false, _) => Some(DreamBlock::Disabled),
            (true, false) => Some(DreamBlock::SignIn),
            (true, true) => None,
        };
        let state = self.state();
        DreamStatus {
            running: state.running.is_some(),
            run_id: None,
            progress: state.running.as_ref().and_then(|r| r.progress.clone()),
            last_run,
            next_at: next_at.map(Into::into),
            blocked,
        }
    }

    /// One look at the schedule; starts a dream when one is due.
    pub async fn tick(&self) {
        let (settings, now, latest) = (self.settings(), self.now(), self.latest().await);
        {
            let mut state = self.state();
            let switched_on = state.was_enabled == Some(false) || (state.was_enabled.is_none() && latest.is_none());
            if settings.enabled && switched_on {
                state.enabled_at = now;
            }
            state.was_enabled = Some(settings.enabled);
            if !settings.enabled || state.running.is_some() || settings.schedule == DreamSchedule::Manual {
                return;
            }
        }
        let since = self.since(latest.as_ref());
        let (due, trigger) = if settings.schedule == DreamSchedule::Nightly {
            (is_nightly_due(now, &settings.nightly_at, since, &self.offset_at()), DreamTrigger::Nightly)
        } else {
            let working = self.0.parts.store.read(|tx| tx.workers().list_all()).await;
            let any_working = working.is_ok_and(|rows| rows.iter().any(|w| w.state == WorkerState::Working));
            let last_user_at = self.state().last_user_at;
            (is_away_due(now, settings.away_minutes, last_user_at, any_working, since), DreamTrigger::Away)
        };
        if due {
            self.begin(trigger).await;
        }
    }

    /// "Dream now": starts a dream in the background; its progress arrives as
    /// `dream:change`. `Err` is why none was started.
    pub async fn dream_now(&self) -> Result<(), String> {
        if self.state().running.is_some() {
            return Err("A dream is already running".to_owned());
        }
        // Without a sign-in there is nothing to wait for: the skipped night is on record when this answers.
        if !self.signed_in() {
            self.begin(DreamTrigger::Manual).await;
            return Ok(());
        }
        let dreams = self.clone();
        tokio::spawn(async move { dreams.begin(DreamTrigger::Manual).await });
        Ok(())
    }

    async fn begin(&self, trigger: DreamTrigger) {
        if self.state().running.is_some() {
            return;
        }
        let settings = self.settings();
        if !self.signed_in() {
            let why = "Needs a Claude sign-in — dreams run on your plan, never an API key";
            return self.skip(trigger, &settings, why.to_owned()).await;
        }
        let ceiling = settings.usage_ceiling.0;
        if let Some(used) = self.0.plan.utilization(PROVIDER).await.filter(|used| *used >= ceiling) {
            let why = format!("Held off — plan usage at {}%, above your {}% line", percent(used), percent(ceiling));
            return self.skip(trigger, &settings, why).await;
        }
        {
            let mut state = self.state();
            if state.running.is_some() {
                return;
            }
            state.running = Some(Running { trigger, progress: None, stop: false });
        }
        self.publish(None, DreamRunStatus::Running);
        let should_stop = || self.state().running.as_ref().is_some_and(|r| r.stop);
        let on_progress = |progress: DreamProgress| {
            if let Some(running) = self.state().running.as_mut() {
                running.progress = Some(progress);
            }
            self.publish(None, DreamRunStatus::Running);
        };
        let run = dream_over_chats(&self.0.parts, trigger, &should_stop, &on_progress).await;
        self.state().running = None;
        match run {
            Ok(run) => {
                if run.proposed > 0 && settings.morning_note {
                    self.notify(&run);
                }
                self.publish(Some(run.id), run.status);
            }
            Err(error) => {
                tracing::warn!(%error, "dream failed");
                self.publish(None, DreamRunStatus::Failed);
            }
        }
    }

    async fn skip(&self, trigger: DreamTrigger, settings: &DreamingSettings, reason: String) {
        let now = self.now();
        let model = serde_json::to_value(settings.model).ok().and_then(|v| v.as_str().map(str::to_owned));
        let run = DreamRun {
            id: self.0.parts.ids.dream_run_id(),
            trigger,
            status: DreamRunStatus::Skipped,
            reason: Some(reason),
            started_at: now.into(),
            finished_at: Some(now.into()),
            model: model.unwrap_or_default(),
            chats_read: 0,
            observations: 0,
            proposed: 0,
            tokens: 0,
            narrative: None,
            dropped: empty_dropped(),
            chats: Vec::new(),
            candidates: 0,
            rejected: Vec::new(),
        };
        let (id, saved) = (run.id.clone(), run);
        let written: Result<(), Error> = self.0.parts.store.write(move |tx, _| tx.dreams().save(&saved)).await;
        if let Err(error) = written {
            tracing::warn!(%error, "a skipped dream could not be recorded");
        }
        self.publish(Some(id), DreamRunStatus::Skipped);
    }

    fn notify(&self, run: &DreamRun) {
        let banner = json!({
            "title": format!("Eos dreamt · {} to review", run.proposed),
            "body": run.narrative.clone().unwrap_or_else(|| "Review what it noticed while you were away.".to_owned()),
            "workerId": "",
            "route": "memory",
            "ts": self.now(),
        });
        self.0.bus.publish_raw(NOTIFICATION_FIRE, None, banner.to_string().into());
    }

    /// Announces a step, and keeps the dream's row in the Jobs tab in step with it.
    fn publish(&self, run_id: Option<String>, status: DreamRunStatus) {
        self.0.bus.publish(&DREAM_CHANGE, &DreamChangeEvent { run_id, status });
        let mut state = self.state();
        let Some(progress) = state.running.as_ref().map(|running| running.progress.clone()) else {
            // A skipped dream leaves nothing behind.
            match (state.job.take(), status) {
                (None, _) => {}
                (Some(job), DreamRunStatus::Skipped) => job.drop_job(),
                (Some(job), DreamRunStatus::Failed) => job.finish(JobStatus::Failed, |job| job.progress = None),
                (Some(job), DreamRunStatus::Stopped) => job.finish(JobStatus::Stopped, |job| job.progress = None),
                (Some(job), _) => job.finish(JobStatus::Completed, |job| job.progress = None),
            }
            return;
        };
        if state.job.is_none() {
            state.jobs_started += 1;
            let dreams = self.clone();
            let spec =
                JobSpec::new(JOB_KIND, None, format!("run-{}", state.jobs_started), "Dreaming").on_stop(move || {
                    let stopping = dreams.request_stop();
                    let refused = JobActionError { status: 409, error: "no dream to stop".into() };
                    async move { if stopping { Ok(()) } else { Err(refused) } }
                });
            state.job = Some(self.0.jobs.start(spec));
        }
        let Some(job) = state.job.clone() else { return };
        drop(state);
        let total = progress.as_ref().map_or(0, |p| p.total);
        job.update(|job| {
            job.title = match total {
                0 => "Dreaming".to_owned(),
                1 => "Dreaming over 1 chat".to_owned(),
                n => format!("Dreaming over {n} chats"),
            };
            job.detail = progress.as_ref().map(|p| format!("Read {} of {}", p.done, p.total));
            job.progress = progress.as_ref().filter(|p| p.total > 0).map(|p| JobProgress {
                done: u64::try_from(p.done).unwrap_or(0),
                total: u64::try_from(p.total).unwrap_or(0),
            });
        });
    }
}
