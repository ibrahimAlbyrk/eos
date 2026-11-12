//! The app's side of in-app updates (`manager/modules/updates/UpdateService.ts`):
//! checks the feed (soon after start, about every half hour, when the window
//! shows or the computer wakes, and on "Check now"), downloads and stages a
//! new release in the background, and — once the user says restart, now or
//! when no agent is working — re-verifies the staged app and hands it to the
//! shell, which quits into the applier. Phases follow
//! `eos_domain::update::can_update_transition`; every change goes out as the
//! whole `UpdateState` on `update:change`.
//!
//! One lock guards the state. It is never held across an `.await`, and every
//! announcement is published while it is held, so the stream carries the
//! states in the order they were entered.

use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};
use std::time::Duration;

use eos_contracts::update::{
    AppVersion, UpdateApply, UpdateNotice, UpdateNoticeKind, UpdateOffReason, UpdatePhase, UpdatePointer,
    UpdateRestartRequestWhen, UpdateState, UpdateStatus, update_topics,
};
use eos_core::Clock;
use eos_core::net::updates::{TopLevelAgents, UpdateApplier, UpdateSignals, UpdateSignature};
use eos_core::store::ConfigSource;
use eos_domain::update::{StagedUpdate, UpdateError, UpdateInstall, can_update_transition, is_newer_version};
use eos_runtime::bus::{Bus, Topic};
use tokio::runtime::Handle;
use tokio::task::AbortHandle;

use crate::download::{Cancel, DownloadDeps, DownloadProgress, check_for_update, download_update};

/// The whole update state, on every change.
pub const UPDATE_CHANGE: Topic<UpdateState> = Topic::new(update_topics::CHANGE);

const FIRST_CHECK: Duration = Duration::from_secs(30);
/// A release reaches running apps within about this long; each install's own
/// spread (±`CHECK_JITTER`) keeps them from all asking — and downloading — at once.
const CHECK_EVERY: Duration = Duration::from_secs(30 * 60);
const CHECK_JITTER: f64 = 0.2;
/// The window showing or the computer waking skips the check when one ran this recently.
const NUDGE_MIN_GAP_MS: i64 = 10 * 60_000;
/// The app quits within seconds of the hand-over; still up after this, it did not take.
const APPLY_TIMEOUT: Duration = Duration::from_secs(90);
const PROGRESS_EVERY_MS: i64 = 250;

/// Why a check runs. `Scheduled` is the half-hourly timer; the next one
/// counts from any check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckTrigger {
    /// "Check now": always looks.
    Manual,
    Opened,
    Woke,
    Scheduled,
}

pub struct UpdateDeps {
    /// The install that may update itself, or why this one may not.
    pub install: Result<UpdateInstall, UpdateOffReason>,
    pub download: DownloadDeps,
    pub signature: Arc<dyn UpdateSignature>,
    pub agents: Arc<dyn TopLevelAgents>,
    pub applier: Arc<dyn UpdateApplier>,
    pub config: Arc<dyn ConfigSource>,
    pub bus: Bus,
    pub clock: Arc<dyn Clock>,
    /// A number in `[0, 1)` per call: where in its ±20 % this install's next check falls.
    pub spread: Arc<dyn Fn() -> f64 + Send + Sync>,
}

impl std::fmt::Debug for UpdateDeps {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UpdateDeps").field("install", &self.install).finish_non_exhaustive()
    }
}

struct State {
    status: UpdateStatus,
    last_checked_at: Option<i64>,
    notice: Option<UpdateNotice>,
    /// A version that was rolled back is never fetched again on its own.
    skip_version: Option<String>,
    offered: Option<UpdatePointer>,
    staged: Option<StagedUpdate>,
    downloading: Option<Cancel>,
    next_check: Option<AbortHandle>,
    apply_timer: Option<AbortHandle>,
    last_attempt_at: Option<i64>,
    progress_sent_at: i64,
}

pub struct UpdateService {
    deps: UpdateDeps,
    state: Mutex<State>,
    me: Weak<UpdateService>,
    /// Where its background work runs, once started.
    runtime: OnceLock<Handle>,
}

impl std::fmt::Debug for UpdateService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UpdateService").field("install", &self.deps.install).finish_non_exhaustive()
    }
}

fn status_of(phase: UpdatePhase) -> UpdateStatus {
    UpdateStatus { phase, off: None, version: None, bytes: None, done: None, full: None, agents: None, error: None }
}

fn version_of(version: &str) -> Option<AppVersion> {
    Some(AppVersion(version.to_owned()))
}

fn ready_status(state: &State) -> UpdateStatus {
    let staged = state.staged.as_ref();
    UpdateStatus {
        version: staged.and_then(|s| version_of(&s.version)),
        bytes: staged.map(|s| s.bytes),
        full: staged.map(|s| s.full),
        ..status_of(UpdatePhase::Ready)
    }
}

impl UpdateService {
    pub fn new(deps: UpdateDeps) -> Arc<Self> {
        let status = match &deps.install {
            Ok(_) => status_of(UpdatePhase::Idle),
            Err(off) => UpdateStatus { off: Some(*off), ..status_of(UpdatePhase::Off) },
        };
        let state = State {
            status,
            last_checked_at: None,
            notice: None,
            skip_version: None,
            offered: None,
            staged: None,
            downloading: None,
            next_check: None,
            apply_timer: None,
            last_attempt_at: None,
            progress_sent_at: 0,
        };
        Arc::new_cyclic(|me| Self { deps, state: Mutex::new(state), me: me.clone(), runtime: OnceLock::new() })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Reads how the last swap ended, picks up a version staged before the
    /// app restarted, and schedules the first check. Call it inside the
    /// runtime the service's background work is to run on.
    pub async fn start(&self) -> Result<(), UpdateError> {
        let _ = self.runtime.set(Handle::current());
        let Ok(install) = &self.deps.install else { return Ok(()) };
        let workspace = &self.deps.download.workspace;
        // A rollback is on record before the old version opens again; an
        // update shows as this version being newer than the one that ran last
        // (the applier's own record lands only after the new version is up).
        let result = workspace.result().await;
        let last = workspace.last_version().await;
        workspace.set_last_version(&install.version).await?;
        let staged = workspace.staged().await.filter(|s| is_newer_version(&s.version, &install.version));
        if staged.is_none() {
            let _ = workspace.clear(None).await;
        }

        let mut state = self.lock();
        match result {
            Some(result) if result.notice.kind == UpdateNoticeKind::RolledBack => {
                state.skip_version = Some(result.notice.version.0.clone());
                if !result.dismissed {
                    state.notice = Some(result.notice);
                }
            }
            _ => {
                if let Some(last) = last.filter(|last| is_newer_version(&install.version, last)) {
                    state.notice = Some(UpdateNotice {
                        kind: UpdateNoticeKind::Updated,
                        version: AppVersion(install.version.clone()),
                        from: AppVersion(last),
                    });
                }
            }
        }
        if staged.is_some() {
            state.staged = staged;
            let ready = ready_status(&state);
            self.set(&mut state, ready);
        }
        self.schedule_check(&mut state, FIRST_CHECK);
        Ok(())
    }

    /// Stops the timers and a running download.
    pub fn stop(&self) {
        let mut state = self.lock();
        for timer in [state.next_check.take(), state.apply_timer.take()].into_iter().flatten() {
            timer.abort();
        }
        if let Some(download) = &state.downloading {
            download.cancel();
        }
    }

    pub fn state(&self) -> UpdateState {
        self.state_of(&self.lock())
    }

    fn state_of(&self, state: &State) -> UpdateState {
        let ready = matches!(state.status.phase, UpdatePhase::Ready | UpdatePhase::Waiting);
        UpdateState {
            current: self.deps.install.as_ref().ok().and_then(|install| version_of(&install.version)),
            status: state.status.clone(),
            last_checked_at: state.last_checked_at.map(Into::into),
            auto_download: self.deps.config.current().updates.auto_download,
            notes: if ready { state.staged.as_ref().and_then(|s| s.notes.clone()) } else { None },
            notice: state.notice.clone(),
        }
    }

    /// Looks for a new release and, when auto-download is on, fetches it.
    /// Resolves when that run has ended.
    pub async fn check(&self, trigger: CheckTrigger) {
        if let Some(run) = self.begin_check(trigger) {
            run.await;
        }
    }

    /// [`check`](Self::check) with the rest left running: when this returns,
    /// the state already says "checking".
    pub fn check_in_background(&self, trigger: CheckTrigger) {
        let Some(runtime) = self.handle() else { return };
        if let Some(run) = self.begin_check(trigger) {
            runtime.spawn(run);
        }
    }

    /// Enters "checking" (or decides not to look) and returns the rest of the run.
    fn begin_check(&self, trigger: CheckTrigger) -> Option<impl Future<Output = ()> + Send + 'static> {
        let install = self.deps.install.as_ref().ok()?.clone();
        let me = self.me.upgrade()?;
        let mut state = self.lock();
        if state.status.phase == UpdatePhase::Checking {
            return None;
        }
        let now = self.deps.clock.now_ms();
        let nudge = matches!(trigger, CheckTrigger::Opened | CheckTrigger::Woke);
        if nudge && state.last_attempt_at.is_some_and(|at| now - at < NUDGE_MIN_GAP_MS) {
            return None;
        }
        state.last_attempt_at = Some(now);
        let next = self.jittered(CHECK_EVERY);
        self.schedule_check(&mut state, next);
        if !can_update_transition(state.status.phase, UpdatePhase::Checking) {
            return None;
        }
        let version = state.staged.as_ref().and_then(|s| version_of(&s.version));
        self.transition(&mut state, UpdateStatus { version, ..status_of(UpdatePhase::Checking) });
        drop(state);
        Some(async move { me.finish_check(install).await })
    }

    async fn finish_check(&self, install: UpdateInstall) {
        let deps = &self.deps;
        let result =
            check_for_update(deps.download.feed.as_ref(), deps.signature.as_ref(), install.platform, &install.version)
                .await;
        if let Ok(Some(pointer)) = &result {
            self.follow_feed(pointer).await;
        }
        let auto = deps.config.current().updates.auto_download;
        let download = {
            let mut state = self.lock();
            state.last_checked_at = Some(deps.clock.now_ms());
            match result {
                Err(e) => {
                    self.fail(&mut state, &e);
                    false
                }
                Ok(pointer) => {
                    let staged = state.staged.as_ref().map(|s| s.version.as_str());
                    let offered = pointer.as_ref().map(|p| p.version.0.as_str());
                    let nothing_new = offered.is_none() || offered == staged;
                    let skipped = offered.is_some() && offered == state.skip_version.as_deref();
                    let version = pointer.as_ref().map(|p| p.version.clone());
                    state.offered = pointer;
                    if nothing_new {
                        let next =
                            if state.staged.is_some() { ready_status(&state) } else { status_of(UpdatePhase::Idle) };
                        self.transition(&mut state, next);
                        false
                    } else if auto && !skipped {
                        true
                    } else {
                        self.transition(&mut state, UpdateStatus { version, ..status_of(UpdatePhase::Available) });
                        false
                    }
                }
            }
        };
        if download {
            self.download().await;
        }
    }

    /// The feed may move; the signed pointer says where to look next time.
    async fn follow_feed(&self, pointer: &UpdatePointer) {
        let Some(feed_url) = &pointer.feed_url else { return };
        if self.deps.config.current().updates.feed_url.as_ref() == Some(feed_url) {
            return;
        }
        let (config, feed_url) = (self.deps.config.clone(), feed_url.clone());
        let written = tokio::task::spawn_blocking(move || {
            let mut patch = serde_json::Map::new();
            patch.insert("feedUrl".to_owned(), serde_json::Value::String(feed_url));
            config.patch("updates", patch).map(|_| ())
        })
        .await;
        if let Ok(Err(e)) = written {
            tracing::warn!(error = %e, "the feed's new address could not be saved");
        }
    }

    /// Fetches and stages the offered release. Resolves when that run has ended.
    pub async fn download(&self) {
        if let Some(run) = self.begin_download() {
            run.await;
        }
    }

    /// [`download`](Self::download) with the rest left running: when this
    /// returns, the state already says "downloading".
    pub fn download_in_background(&self) {
        let Some(runtime) = self.handle() else { return };
        if let Some(run) = self.begin_download() {
            runtime.spawn(run);
        }
    }

    fn begin_download(&self) -> Option<impl Future<Output = ()> + Send + 'static> {
        let install = self.deps.install.as_ref().ok()?.clone();
        let me = self.me.upgrade()?;
        let mut state = self.lock();
        let pointer = state.offered.clone()?;
        if state.downloading.is_some() {
            return None;
        }
        let downloading = UpdateStatus {
            version: Some(pointer.version.clone()),
            done: Some(0),
            ..status_of(UpdatePhase::Downloading)
        };
        if !self.transition(&mut state, downloading) {
            return None;
        }
        let cancel = Cancel::default();
        state.downloading = Some(cancel.clone());
        state.staged = None;
        drop(state);
        Some(async move { me.finish_download(install, pointer, cancel).await })
    }

    async fn finish_download(&self, install: UpdateInstall, pointer: UpdatePointer, cancel: Cancel) {
        let progress = Progress { service: self, version: pointer.version.clone() };
        let result = download_update(&self.deps.download, &pointer, &install.root, &progress, &cancel).await;
        let mut state = self.lock();
        state.downloading = None;
        match result {
            Ok(staged) => {
                tracing::info!(version = %staged.version, bytes = staged.bytes, "update staged");
                state.staged = Some(staged);
                let ready = ready_status(&state);
                self.transition(&mut state, ready);
            }
            Err(_) if cancel.is_cancelled() => {
                let available = UpdateStatus { version: Some(pointer.version), ..status_of(UpdatePhase::Available) };
                self.transition(&mut state, available);
            }
            Err(e) => self.fail(&mut state, &e),
        }
    }

    /// Restart now, or once no agent is working ("When they finish"). False
    /// when nothing is ready to restart into.
    pub async fn restart(&self, when: UpdateRestartRequestWhen) -> bool {
        {
            let state = self.lock();
            let ready = matches!(state.status.phase, UpdatePhase::Ready | UpdatePhase::Waiting);
            if !ready || state.staged.is_none() {
                return false;
            }
        }
        let agents = self.deps.agents.working().await;
        if when == UpdateRestartRequestWhen::Idle && agents > 0 {
            let mut state = self.lock();
            let waiting = UpdateStatus {
                phase: UpdatePhase::Waiting,
                agents: Some(i64::try_from(agents).unwrap_or(i64::MAX)),
                ..ready_status(&state)
            };
            return self.transition(&mut state, waiting);
        }
        self.apply_in_background();
        true
    }

    /// A top-level agent started or finished a turn.
    pub async fn agents_changed(&self) {
        if self.lock().status.phase != UpdatePhase::Waiting {
            return;
        }
        let agents = self.deps.agents.working().await;
        let mut state = self.lock();
        if state.status.phase != UpdatePhase::Waiting {
            return;
        }
        let agents = i64::try_from(agents).unwrap_or(i64::MAX);
        if agents == 0 {
            drop(state);
            self.apply_in_background();
        } else if state.status.agents != Some(agents) {
            state.status.agents = Some(agents);
            self.publish(&state);
        }
    }

    /// Stops waiting for agents.
    pub fn later(&self) {
        let mut state = self.lock();
        if state.status.phase == UpdatePhase::Waiting {
            let ready = ready_status(&state);
            self.transition(&mut state, ready);
        }
    }

    /// Hides how the last swap ended.
    pub async fn dismiss_notice(&self) {
        let rolled_back = self.lock().notice.take().is_some_and(|notice| notice.kind == UpdateNoticeKind::RolledBack);
        if rolled_back {
            let _ = self.deps.download.workspace.dismiss_result().await;
        }
        self.publish(&self.lock());
    }

    /// Auto-download was switched: start what was only offered, or stop what was running.
    pub fn settings_changed(&self) {
        let auto = self.deps.config.current().updates.auto_download;
        let state = self.lock();
        if auto && state.status.phase == UpdatePhase::Available {
            drop(state);
            self.download_in_background();
        } else if !auto {
            if let Some(download) = &state.downloading {
                download.cancel();
            }
        } else {
            self.publish(&state);
        }
    }

    /// Enters "applying" and leaves the hand-over running: the last check of
    /// the staged app, then the shell's applier.
    fn apply_in_background(&self) {
        let (Ok(install), Some(me), Some(runtime)) = (&self.deps.install, self.me.upgrade(), self.handle()) else {
            return;
        };
        let staged = {
            let mut state = self.lock();
            let Some(staged) = state.staged.clone() else { return };
            let applying = UpdateStatus { phase: UpdatePhase::Applying, ..ready_status(&state) };
            if !self.transition(&mut state, applying) {
                return;
            }
            staged
        };
        let install = install.clone();
        runtime.spawn(async move { me.finish_apply(install, staged).await });
    }

    async fn finish_apply(&self, install: UpdateInstall, staged: StagedUpdate) {
        let checked = self.deps.download.bundle_check.verify(Path::new(&staged.path), Path::new(&install.root)).await;
        if let Err(e) = checked {
            self.lock().staged = None;
            let _ = self.deps.download.workspace.clear(None).await;
            self.fail(&mut self.lock(), &e);
            return;
        }
        let apply = UpdateApply {
            version: AppVersion(staged.version),
            from: AppVersion(install.version),
            staged: staged.path,
            target: install.root,
        };
        tracing::info!(version = %apply.version.0, from = %apply.from.0, "update applying");
        self.arm_apply_timer();
        if let Err(message) = self.deps.applier.apply(&apply).await {
            let mut state = self.lock();
            if let Some(timer) = state.apply_timer.take() {
                timer.abort();
            }
            self.fail(&mut state, &UpdateError::disk(message));
        }
    }

    fn arm_apply_timer(&self) {
        let (Some(runtime), me) = (self.runtime.get(), self.me.clone()) else { return };
        let timer = runtime.spawn(async move {
            tokio::time::sleep(APPLY_TIMEOUT).await;
            let Some(me) = me.upgrade() else { return };
            let mut state = me.lock();
            state.apply_timer = None;
            let stuck = UpdateError::disk("Eos didn't restart. Quit and open it again to finish the update.");
            me.fail(&mut state, &stuck);
        });
        self.lock().apply_timer = Some(timer.abort_handle());
    }

    fn schedule_check(&self, state: &mut State, after: Duration) {
        if let Some(previous) = state.next_check.take() {
            previous.abort();
        }
        let (Some(runtime), me) = (self.runtime.get(), self.me.clone()) else { return };
        // The timer only starts the check: the check replaces this timer, and
        // must not be cut short with it.
        let timer = runtime.spawn(async move {
            tokio::time::sleep(after).await;
            if let Some(me) = me.upgrade() {
                me.check_in_background(CheckTrigger::Scheduled);
            }
        });
        state.next_check = Some(timer.abort_handle());
    }

    fn jittered(&self, time: Duration) -> Duration {
        let spread = (self.deps.spread)().clamp(0.0, 1.0);
        time.mul_f64(1.0 + CHECK_JITTER * (2.0 * spread - 1.0))
    }

    /// Where background work runs: the runtime the service was started on,
    /// else the caller's. `None` before either exists — nothing is begun then.
    fn handle(&self) -> Option<Handle> {
        self.runtime.get().cloned().or_else(|| Handle::try_current().ok())
    }

    fn fail(&self, state: &mut State, error: &UpdateError) {
        tracing::warn!(phase = ?state.status.phase, code = error.code.as_str(), error = %error, "update failed");
        let version = state.offered.as_ref().map(|p| p.version.clone()).or_else(|| state.status.version.clone());
        let failed = UpdateStatus { version, error: Some(error.message.clone()), ..status_of(UpdatePhase::Error) };
        self.transition(state, failed);
    }

    /// Moves to `next` when the rule book allows it.
    fn transition(&self, state: &mut State, next: UpdateStatus) -> bool {
        if !can_update_transition(state.status.phase, next.phase) {
            tracing::warn!(from = ?state.status.phase, to = ?next.phase, "update transition refused");
            return false;
        }
        self.set(state, next);
        true
    }

    fn set(&self, state: &mut State, next: UpdateStatus) {
        state.status = next;
        self.publish(state);
    }

    fn publish(&self, state: &State) {
        self.deps.bus.publish(&UPDATE_CHANGE, &self.state_of(state));
    }
}

/// A download's progress, written into the status and announced at most
/// every quarter second (its start and its end at once).
struct Progress<'a> {
    service: &'a UpdateService,
    version: AppVersion,
}

impl DownloadProgress for Progress<'_> {
    fn progress(&self, done: i64, total: i64) {
        let mut state = self.service.lock();
        if state.status.phase != UpdatePhase::Downloading {
            return;
        }
        state.status.done = Some(done);
        state.status.bytes = Some(total);
        let now = self.service.deps.clock.now_ms();
        if done != 0 && done != total && now - state.progress_sent_at < PROGRESS_EVERY_MS {
            return;
        }
        state.progress_sent_at = now;
        self.service.publish(&state);
    }

    fn staging(&self) {
        let mut state = self.service.lock();
        let staging = UpdateStatus {
            version: Some(self.version.clone()),
            bytes: state.status.bytes,
            ..status_of(UpdatePhase::Staging)
        };
        self.service.transition(&mut state, staging);
    }
}

impl UpdateSignals for UpdateService {
    fn window_shown(&self) {
        self.check_in_background(CheckTrigger::Opened);
    }

    fn woke(&self) {
        self.check_in_background(CheckTrigger::Woke);
    }
}
