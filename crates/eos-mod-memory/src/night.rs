//! Night tidying in the app (04 G14): every night at the dreaming slot
//! (`profile.dreaming.nightlyAt`), whether Dreaming is on or not; a Mac
//! asleep at the slot tidies once it has been awake ten minutes. "Tidy now"
//! starts one at once. Each tidying is a stoppable `mem-tidy` job in the
//! Jobs tab; one runs at a time.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use eos_core::os::TimeZone;
use eos_core::profile::UserProfileReader;
use eos_core::store::Store;
use eos_core::{Clock, Error, Sleeper};
use eos_domain::time::nightly_slot;
use eos_memory::night::{GeneralizePrompt, Night};
use eos_prompts::PromptService;
use eos_runtime::jobs::{JobActionError, JobRegistry, JobSpec, JobStatus};

/// The job kind of a night's tidying.
pub(crate) const JOB_KIND: &str = "mem-tidy";
/// The schedule is looked at this often.
const TICK_MS: i64 = 60_000;
/// A gap this long between two looks means the Mac slept.
const SLEPT_MS: i64 = 3 * TICK_MS;
/// After a sleep across the slot, the tidying waits this long awake.
const AWAKE_MS: i64 = 10 * 60_000;
/// Where the last tidying's start is kept.
const LAST_KEY: &str = "night.last";

/// Due when the slot passed since the last tidying; a slot passed while the
/// Mac slept waits until it has been awake [`AWAKE_MS`].
pub(crate) fn due(now: i64, slot: i64, last: i64, awake_since: i64) -> bool {
    if last >= slot {
        return false;
    }
    let missed = awake_since > slot;
    !missed || now - awake_since >= AWAKE_MS
}

/// The generalization prompt from the library, so the user's override applies.
pub(crate) struct LibraryGeneralize(pub(crate) Arc<PromptService>);

impl GeneralizePrompt for LibraryGeneralize {
    fn render(&self, lessons: &str) -> Result<(String, String), Error> {
        eos_prompts::templates::memory::generalize(&self.0, lessons)
    }
}

pub(crate) struct Nightly {
    pub(crate) night: Night,
    pub(crate) store: Arc<dyn Store>,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) zone: Arc<dyn TimeZone>,
    pub(crate) profile: Arc<dyn UserProfileReader>,
    pub(crate) jobs: JobRegistry,
    /// Asks the tidying at work to stop; `None` while none works.
    pub(crate) running: Mutex<Option<Arc<AtomicBool>>>,
}

impl Nightly {
    /// Looks at the schedule every minute, until stopped.
    pub(crate) async fn run(self: Arc<Self>, sleeper: Arc<dyn Sleeper>) {
        let mut seen = self.clock.now_ms();
        let mut awake_since = seen;
        loop {
            sleeper.sleep(TICK_MS).await;
            let now = self.clock.now_ms();
            if now - seen >= SLEPT_MS {
                awake_since = now;
            }
            seen = now;
            match self.is_due(now, awake_since).await {
                Ok(true) => {
                    self.clone().tidy().await;
                }
                Ok(false) => {}
                Err(e) => tracing::warn!(error = %e, "memory: the night's schedule was not read"),
            }
        }
    }

    async fn is_due(&self, now: i64, awake_since: i64) -> Result<bool, Error> {
        let at = self.profile.get().dreaming.nightly_at.clone();
        let slot = nightly_slot(now, &at, &|t| self.zone.offset_minutes_at(t));
        let last = self.store.read(|tx| tx.mem_book().setting(LAST_KEY)).await?;
        let last = last.and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
        Ok(due(now, slot, last, awake_since))
    }

    /// Starts a tidying in the background; `false` when one already works.
    pub(crate) fn start(self: &Arc<Self>) -> bool {
        if self.running.lock().unwrap_or_else(PoisonError::into_inner).is_some() {
            return false;
        }
        tokio::spawn(self.clone().tidy());
        true
    }

    /// One tidying, as a job of its own.
    async fn tidy(self: Arc<Self>) {
        let stop = Arc::new(AtomicBool::new(false));
        {
            let mut running = self.running.lock().unwrap_or_else(PoisonError::into_inner);
            if running.is_some() {
                return;
            }
            *running = Some(stop.clone());
        }
        let now = self.clock.now_ms();
        let started = self.store.write(move |tx, _| tx.mem_book().set_setting(LAST_KEY, &now.to_string())).await;
        if let Err(e) = started {
            tracing::warn!(error = %e, "memory: the night's start was not kept");
        }
        let stopping = stop.clone();
        let spec = JobSpec::new(JOB_KIND, None, format!("night-{now}"), "Tidying memory").on_stop(move || {
            stopping.store(true, Ordering::SeqCst);
            std::future::ready(Ok::<(), JobActionError>(()))
        });
        let job = self.jobs.start(spec);
        let status = match self.night.tidy(&stop).await {
            Ok(tidied) if tidied.stopped => JobStatus::Stopped,
            Ok(_) => JobStatus::Completed,
            Err(e) => {
                tracing::warn!(error = %e, "memory: the night's tidying failed");
                JobStatus::Failed
            }
        };
        job.finish(status, |job| job.progress = None);
        *self.running.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SLOT: i64 = 1_000_000_000;

    #[test]
    fn due_once_past_the_slot_and_after_a_sleep_only_ten_minutes_awake() {
        assert!(due(SLOT + 1, SLOT, SLOT - 86_400_000, 0), "the slot passed while awake");
        assert!(!due(SLOT + 1, SLOT, SLOT + 1, 0), "already tidied tonight");
        assert!(!due(SLOT - 1, SLOT - 86_400_000, SLOT - 86_400_000 + 5, 0), "not yet tonight");
        let woke = SLOT + 3 * 3_600_000;
        assert!(!due(woke + 60_000, SLOT, 0, woke), "just woke");
        assert!(due(woke + AWAKE_MS, SLOT, 0, woke), "ten minutes awake");
    }
}
