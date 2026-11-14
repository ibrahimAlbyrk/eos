//! The app's side of Settings › Sync: owns the sync key, runs the engine and
//! keeps this computer caught up. A pass runs on start, after a local change
//! (once the burst settles), when the vault's long poll reports another
//! computer's write, when the user asks for one, and every minute for the
//! hand-edited folders that have no change event. Failures back off and show as
//! the status error; the next pass retries everything.
//!
//! One task per account drives all of it, so nothing queues: a trigger that
//! arrives while a pass runs is one more pass after it, however many arrived.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::Duration;

use eos_contracts::{Num, SyncPhase, SyncStatusResponse};
use eos_core::net::sync::{SyncAccounts, SyncDomain, SyncIdentityStore, SyncStateStore, SyncVault};
use eos_core::{Clock, Error};
use eos_domain::sync::{SyncIdentity, format_sync_key, parse_sync_key};
use eos_runtime::bus::Bus;
use eos_runtime::jobs::{JobHandle, JobRegistry, JobSpec};
use eos_sync::{SyncEngine, SyncEngineDeps};
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::{SYNC_CHANGE, SYNC_JOB_KIND};

/// The relay a new account is created on, read when the user creates one.
pub type RelayUrl = Arc<dyn Fn() -> Option<String> + Send + Sync>;

/// This computer's name, read when an account is opened.
pub type DeviceName = Arc<dyn Fn() -> String + Send + Sync>;

/// The service's clockwork. Tests shorten it.
#[derive(Debug, Clone)]
pub struct Timing {
    /// How long one wait on the vault for another computer's write lasts.
    pub long_poll: Duration,
    /// How long after the last local change of a burst a pass runs.
    pub local_debounce: Duration,
    /// How often a pass runs for the folders that have no change event.
    pub sweep: Duration,
    /// The waits after one, two, … failures in a row; the last one repeats.
    pub backoff: Vec<Duration>,
    /// A pass shows in the Jobs list once it has run this long.
    pub show_job_after: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            long_poll: Duration::from_secs(25),
            local_debounce: Duration::from_millis(1500),
            sweep: Duration::from_secs(60),
            backoff: [5, 15, 60, 300].into_iter().map(Duration::from_secs).collect(),
            show_job_after: Duration::from_millis(1500),
        }
    }
}

pub struct SyncServiceDeps {
    pub identities: Arc<dyn SyncIdentityStore>,
    pub state: Arc<dyn SyncStateStore>,
    pub accounts: Arc<dyn SyncAccounts>,
    pub relay_url: RelayUrl,
    /// Stamped on what this computer pushes.
    pub device: DeviceName,
    pub timing: Timing,
}

impl std::fmt::Debug for SyncServiceDeps {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SyncServiceDeps").finish_non_exhaustive()
    }
}

/// One account this computer is syncing with.
struct Session {
    identity: SyncIdentity,
    vault: Arc<dyn SyncVault>,
    engine: Arc<SyncEngine>,
    syncing: AtomicBool,
    /// A pass was asked for.
    kick: Notify,
    /// When the pass for the latest local change is due.
    debounce: Mutex<Option<Instant>>,
    /// The debounce deadline moved.
    changed: Notify,
    task: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Default)]
struct Inner {
    session: Option<Arc<Session>>,
    last_sync_at: Option<i64>,
    error: Option<String>,
}

pub struct SyncService {
    deps: SyncServiceDeps,
    domains: Vec<Arc<dyn SyncDomain>>,
    clock: Arc<dyn Clock>,
    bus: Bus,
    jobs: JobRegistry,
    inner: Mutex<Inner>,
    this: Weak<SyncService>,
}

impl std::fmt::Debug for SyncService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SyncService").finish_non_exhaustive()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The relay's host as the status shows it (`new URL(url).host`).
fn host_of(relay_url: &str) -> String {
    match url::Url::parse(relay_url) {
        Ok(parsed) => match (parsed.host_str(), parsed.port()) {
            (Some(host), Some(port)) => format!("{host}:{port}"),
            (Some(host), None) => host.to_owned(),
            (None, _) => relay_url.to_owned(),
        },
        Err(_) => relay_url.to_owned(),
    }
}

/// The Jobs entry of a pass, taken off the list when the pass ends, however
/// it ends.
struct ShownJob(Option<JobHandle>);

impl Drop for ShownJob {
    fn drop(&mut self) {
        if let Some(job) = self.0.take() {
            job.drop_job();
        }
    }
}

impl SyncService {
    pub fn new(
        deps: SyncServiceDeps,
        domains: Vec<Arc<dyn SyncDomain>>,
        clock: Arc<dyn Clock>,
        bus: Bus,
        jobs: JobRegistry,
    ) -> Arc<Self> {
        Arc::new_cyclic(|this| Self { deps, domains, clock, bus, jobs, inner: Mutex::default(), this: this.clone() })
    }

    /// Resumes the account this computer is in, if any. Needs a runtime.
    pub fn start(&self) {
        if lock(&self.inner).session.is_some() {
            return;
        }
        if let Some(identity) = self.deps.identities.load() {
            self.open(identity);
        }
    }

    pub fn stop(&self) {
        self.close();
    }

    pub fn status(&self) -> SyncStatusResponse {
        Self::status_of(&lock(&self.inner))
    }

    fn status_of(inner: &Inner) -> SyncStatusResponse {
        let session = inner.session.as_ref();
        let phase = match session {
            None => SyncPhase::Off,
            Some(session) if session.syncing.load(Ordering::SeqCst) => SyncPhase::Syncing,
            Some(_) if inner.error.is_some() => SyncPhase::Error,
            Some(_) => SyncPhase::Idle,
        };
        SyncStatusResponse {
            phase,
            relay: session.map(|s| host_of(&s.identity.relay_url)),
            last_sync_at: inner.last_sync_at.map(|at| Num(at as f64)),
            error: session.and(inner.error.clone()),
            counts: session.map(|s| s.engine.counts()).unwrap_or_default(),
        }
    }

    pub fn key(&self) -> Option<String> {
        lock(&self.inner).session.as_ref().map(|session| format_sync_key(&session.identity))
    }

    /// A new account: this computer's data becomes its first content.
    pub fn create(&self) -> Result<SyncStatusResponse, Error> {
        let relay = (self.deps.relay_url)()
            .ok_or_else(|| Error::Validation("set up a relay first (Settings › Remote)".into()))?;
        self.adopt(self.deps.accounts.create(&relay))
    }

    /// Joining: the account's copy wins where both have one; this computer's
    /// is kept aside.
    pub fn join(&self, key: &str) -> Result<SyncStatusResponse, Error> {
        let identity = parse_sync_key(key).ok_or_else(|| Error::Validation("that isn't a sync key".into()))?;
        self.adopt(identity)
    }

    /// This computer stops syncing; its data stays as it is.
    pub fn leave(&self) -> Result<SyncStatusResponse, Error> {
        self.close();
        self.deps.identities.clear()?;
        self.deps.state.reset()?;
        let mut inner = lock(&self.inner);
        inner.last_sync_at = None;
        inner.error = None;
        Ok(self.publish(&inner))
    }

    pub fn sync_now(&self) {
        if let Some(session) = lock(&self.inner).session.as_ref() {
            session.kick.notify_one();
        }
    }

    /// A local change: pushed once the burst settles.
    pub fn note_local_change(&self) {
        if let Some(session) = lock(&self.inner).session.as_ref() {
            *lock(&session.debounce) = Some(Instant::now() + self.deps.timing.local_debounce);
            session.changed.notify_one();
        }
    }

    fn adopt(&self, identity: SyncIdentity) -> Result<SyncStatusResponse, Error> {
        self.close();
        self.deps.state.reset()?;
        self.deps.identities.save(&identity)?;
        {
            let mut inner = lock(&self.inner);
            inner.last_sync_at = None;
            inner.error = None;
        }
        self.open(identity);
        Ok(self.status())
    }

    fn open(&self, identity: SyncIdentity) {
        let opened = self.deps.accounts.open(&identity);
        let engine = SyncEngine::new(SyncEngineDeps {
            vault: opened.vault.clone(),
            crypto: opened.crypto,
            state: self.deps.state.clone(),
            domains: self.domains.clone(),
            clock: self.clock.clone(),
            device: (self.deps.device)(),
        });
        let session = Arc::new(Session {
            identity,
            vault: opened.vault,
            engine: Arc::new(engine),
            syncing: AtomicBool::new(false),
            kick: Notify::new(),
            debounce: Mutex::new(None),
            changed: Notify::new(),
            task: Mutex::new(None),
        });
        {
            let mut inner = lock(&self.inner);
            inner.session = Some(session.clone());
            self.publish(&inner);
        }
        if let Some(service) = self.this.upgrade() {
            let task = tokio::spawn(service.watch(session.clone()));
            *lock(&session.task) = Some(task);
        }
    }

    fn close(&self) {
        let Some(session) = lock(&self.inner).session.take() else { return };
        // A pass in flight ends at its next record and saves nothing more.
        session.engine.stop();
        if let Some(task) = lock(&session.task).take() {
            task.abort();
        }
    }

    fn is_current(&self, session: &Arc<Session>) -> bool {
        lock(&self.inner).session.as_ref().is_some_and(|current| Arc::ptr_eq(current, session))
    }

    /// Announces the status as it stands. Under the state's lock, so two
    /// changes are announced in the order they were made.
    fn publish(&self, inner: &Inner) -> SyncStatusResponse {
        let status = Self::status_of(inner);
        self.bus.publish(&SYNC_CHANGE, &status);
        status
    }

    /// Pass, then wait until another is due; on failure back off and start
    /// over with a pass.
    async fn watch(self: Arc<Self>, session: Arc<Session>) {
        let timing = &self.deps.timing;
        let mut sweep = tokio::time::interval_at(Instant::now() + timing.sweep, timing.sweep);
        sweep.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut failures = 0usize;
        while self.is_current(&session) {
            if self.pass(&session).await {
                failures = 0;
                match self.until_due(&session, &mut sweep).await {
                    Ok(()) => continue,
                    Err(error) => self.fail(&session, &error),
                }
            }
            let wait = timing.backoff.get(failures).or(timing.backoff.last()).copied().unwrap_or_default();
            failures += 1;
            tokio::select! {
                () = tokio::time::sleep(wait) => {}
                () = session.kick.notified() => {}
                () = local_change_due(&session) => {}
                _ = sweep.tick() => {}
            }
        }
    }

    /// Resolves when a pass is due: another computer wrote to the vault, the
    /// user asked, a local change settled, or the sweep came round. An error
    /// when the vault could not be asked.
    async fn until_due(&self, session: &Session, sweep: &mut tokio::time::Interval) -> Result<(), Error> {
        let wait_ms = u64::try_from(self.deps.timing.long_poll.as_millis()).unwrap_or(u64::MAX);
        loop {
            tokio::select! {
                page = session.vault.changes(session.engine.position(), wait_ms) => {
                    if !page?.entries.is_empty() {
                        return Ok(());
                    }
                }
                () = session.kick.notified() => return Ok(()),
                () = local_change_due(session) => return Ok(()),
                _ = sweep.tick() => return Ok(()),
            }
        }
    }

    /// True when the pass completed.
    async fn pass(&self, session: &Arc<Session>) -> bool {
        {
            let inner = lock(&self.inner);
            if !inner.session.as_ref().is_some_and(|current| Arc::ptr_eq(current, session)) {
                return false;
            }
            session.syncing.store(true, Ordering::SeqCst);
            self.publish(&inner);
        }
        // A pass that outlasts a moment shows in the Jobs list.
        let mut shown = ShownJob(None);
        let sync = session.engine.sync();
        tokio::pin!(sync);
        let result = tokio::select! {
            result = &mut sync => result,
            () = tokio::time::sleep(self.deps.timing.show_job_after) => {
                let mut spec = JobSpec::new(SYNC_JOB_KIND, None, "sync", "Syncing");
                spec.ambient = true;
                let job = self.jobs.start(spec);
                job.update_now(|_| {});
                shown.0 = Some(job);
                sync.await
            }
        };
        drop(shown);

        let mut inner = lock(&self.inner);
        session.syncing.store(false, Ordering::SeqCst);
        if !inner.session.as_ref().is_some_and(|current| Arc::ptr_eq(current, session)) {
            return false;
        }
        let done = match result {
            Ok(r) => {
                inner.last_sync_at = Some(self.clock.now_ms());
                inner.error = None;
                if r.pulled + r.pushed + r.conflicts > 0 {
                    tracing::info!(pulled = r.pulled, pushed = r.pushed, conflicts = r.conflicts, "sync: pass");
                }
                true
            }
            Err(e) => {
                Self::note_error(&mut inner, &e);
                false
            }
        };
        self.publish(&inner);
        done
    }

    fn note_error(inner: &mut Inner, error: &Error) {
        let message = error.to_string();
        if inner.error.as_deref() != Some(message.as_str()) {
            tracing::warn!(error = %message, "sync: failed");
        }
        inner.error = Some(message);
    }

    fn fail(&self, session: &Arc<Session>, error: &Error) {
        let mut inner = lock(&self.inner);
        if inner.session.as_ref().is_some_and(|current| Arc::ptr_eq(current, session)) {
            Self::note_error(&mut inner, error);
            self.publish(&inner);
        }
    }
}

/// Resolves when the pass for the latest local change is due; never, while
/// there is none. A new change moves the deadline.
async fn local_change_due(session: &Session) {
    loop {
        let deadline = *lock(&session.debounce);
        let due = async {
            match deadline {
                Some(at) => tokio::time::sleep_until(at).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            () = due => {
                let mut slot = lock(&session.debounce);
                if slot.is_some_and(|at| at <= Instant::now()) {
                    *slot = None;
                    return;
                }
            }
            () = session.changed.notified() => {}
        }
    }
}
