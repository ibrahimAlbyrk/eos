//! The database's weekly vacuum (`eos_kit_sqlite::Db::maybe_vacuum`): looked for every
//! hour, as the 0.1.x app did, the first time a while after start-up so it never competes
//! with the window's first load. Each look runs on a blocking thread; the vacuum itself
//! decides whether it is due and skips while any worker is live.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};

use eos_core::{Clock, Sleeper};
use eos_kit_sqlite::VacuumOutcome;
use eos_store_sqlite::SqliteStore;
use tokio::task::AbortHandle;

/// The first look, after start-up.
pub(crate) const FIRST_LOOK_MS: i64 = 10 * 60 * 1000;
/// Every look after that.
pub(crate) const EVERY_MS: i64 = 60 * 60 * 1000;

/// One look: `None` once the database is gone.
type Look = dyn Fn(i64) -> Option<Result<VacuumOutcome, eos_kit_sqlite::Error>> + Send + Sync;

/// The running schedule, from start to shutdown.
#[derive(Debug, Default)]
pub(crate) struct Vacuum {
    task: Mutex<Option<AbortHandle>>,
    /// Set at shutdown: a look already on its blocking thread (which the abort cannot
    /// reach) stops before its next slice.
    stopped: Arc<AtomicBool>,
}

impl Vacuum {
    pub(crate) fn start(&self, store: Weak<SqliteStore>, clock: Arc<dyn Clock>, sleeper: Arc<dyn Sleeper>) {
        let stopped = self.stopped.clone();
        let look: Arc<Look> = Arc::new(move |now| {
            let go_on = || !stopped.load(Ordering::SeqCst);
            go_on().then(|| store.upgrade().map(|store| store.db().maybe_vacuum_while(now, &go_on))).flatten()
        });
        let task = schedule(look, clock, sleeper);
        if let Some(previous) = self.task.lock().unwrap_or_else(|p| p.into_inner()).replace(task) {
            previous.abort();
        }
    }

    pub(crate) fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Some(task) = self.task.lock().unwrap_or_else(|p| p.into_inner()).take() {
            task.abort();
        }
    }
}

fn schedule(look: Arc<Look>, clock: Arc<dyn Clock>, sleeper: Arc<dyn Sleeper>) -> AbortHandle {
    let task = tokio::spawn(async move {
        let mut wait = FIRST_LOOK_MS;
        loop {
            sleeper.sleep(wait).await;
            wait = EVERY_MS;
            let (look, now) = (look.clone(), clock.now_ms());
            match tokio::task::spawn_blocking(move || look(now)).await {
                Ok(None) => return,
                Ok(Some(Ok(outcome @ (VacuumOutcome::Incremental { .. } | VacuumOutcome::Full)))) => {
                    tracing::info!(?outcome, "the database gave its free pages back");
                }
                Ok(Some(Ok(outcome))) => tracing::debug!(?outcome, "no vacuum"),
                Ok(Some(Err(error))) => tracing::warn!(%error, "the vacuum failed"),
                Err(error) => tracing::error!(%error, "the vacuum panicked"),
            }
        }
    });
    task.abort_handle()
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use eos_testkit::{FakeClock, FakeSleeper};

    use super::*;

    async fn settle() {
        for _ in 0..50 {
            tokio::task::yield_now().await;
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn it_looks_a_while_after_start_then_every_hour_until_the_database_is_gone() {
        let clock = Arc::new(FakeClock::at(1_000));
        let sleeper = Arc::new(FakeSleeper::default());
        let seen: Arc<Mutex<Vec<i64>>> = Arc::default();
        let gone = Arc::new(AtomicBool::new(false));
        let look: Arc<Look> = {
            let (seen, gone) = (seen.clone(), gone.clone());
            Arc::new(move |now| {
                if gone.load(Ordering::SeqCst) {
                    return None;
                }
                seen.lock().expect("seen").push(now);
                Some(Ok(VacuumOutcome::NotDue))
            })
        };
        let task = schedule(look, clock.clone(), sleeper.clone());
        settle().await;
        assert_eq!(sleeper.pending(), vec![FIRST_LOOK_MS]);
        assert!(seen.lock().expect("seen").is_empty(), "nothing at start-up");

        clock.set(5_000);
        assert!(sleeper.wake());
        settle().await;
        assert_eq!(*seen.lock().expect("seen"), vec![5_000]);
        assert_eq!(sleeper.pending(), vec![EVERY_MS]);

        clock.set(9_000);
        assert!(sleeper.wake());
        settle().await;
        assert_eq!(*seen.lock().expect("seen"), vec![5_000, 9_000]);

        gone.store(true, Ordering::SeqCst);
        assert!(sleeper.wake());
        settle().await;
        assert!(sleeper.pending().is_empty(), "the schedule ends with the database");
        assert!(task.is_finished());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn stopping_ends_the_schedule() {
        let temp = eos_testkit::TempStore::new();
        let store = temp.store.clone();
        let sleeper = Arc::new(FakeSleeper::default());
        let vacuum = Vacuum::default();
        vacuum.start(Arc::downgrade(&store), Arc::new(FakeClock::at(0)), sleeper.clone());
        settle().await;
        assert_eq!(sleeper.pending(), vec![FIRST_LOOK_MS]);
        vacuum.stop();
        settle().await;
        assert!(sleeper.pending().is_empty());
    }
}
