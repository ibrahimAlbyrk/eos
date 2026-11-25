//! Acting only as a routine's holder (02 §3 F.30–34): this computer polls a
//! routine's sources, fires its schedules and admits its runs only while
//! its lease says it holds it, and only once the leases were read after a
//! launch or a wake, or [`FIRST_READ_WAIT_MS`] passed without reaching the
//! vault (then on the last view). A routine no lease names is adopted once
//! a read went through: written over nothing, so it never takes a lease
//! another computer has. While nothing is shared every routine is held here.

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use eos_core::Clock;
use eos_core::routine::{RoutineTriggers, RunIntake};
use eos_core::signals::{Holder, Runner, RunnerError};
use eos_core::store::Store;

/// How long after a launch or a wake the last view is trusted without a
/// read of the vault.
pub const FIRST_READ_WAIT_MS: i64 = 2 * 60_000;

/// Where a routine's triggers are acted on, as this computer knows now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Place {
    Here,
    Elsewhere,
    /// Not known yet: its signals wait.
    Waiting,
}

pub(crate) struct Holding {
    pub(crate) runner: Arc<dyn Runner>,
    clock: Arc<dyn Clock>,
    /// When the app started or the computer last woke.
    woke_at: AtomicI64,
}

impl Holding {
    pub(crate) fn new(runner: Arc<dyn Runner>, clock: Arc<dyn Clock>) -> Self {
        let woke_at = AtomicI64::new(clock.now_ms());
        Self { runner, clock, woke_at }
    }

    pub(crate) fn woke(&self) {
        self.woke_at.store(self.clock.now_ms(), Ordering::SeqCst);
    }

    /// Whether the view of the leases may be acted on.
    fn settled(&self) -> bool {
        let woke_at = self.woke_at.load(Ordering::SeqCst);
        !self.runner.shared()
            || self.runner.confirmed_at().is_some_and(|read| read >= woke_at)
            || self.clock.now_ms() - woke_at >= FIRST_READ_WAIT_MS
    }

    pub(crate) fn place(&self, routine_id: &str) -> Place {
        match self.runner.holder(routine_id) {
            Holder::Here { .. } if self.settled() => Place::Here,
            Holder::Elsewhere { .. } => Place::Elsewhere,
            Holder::Here { .. } | Holder::Unknown => Place::Waiting,
        }
    }

    pub(crate) fn acts(&self, routine_id: &str) -> bool {
        self.place(routine_id) == Place::Here
    }

    /// Takes a first lease for each routine no lease names (made here, or
    /// made before leases were kept), and lets 01 cancel as `moved` the
    /// queued runs of the routines another computer holds.
    pub(crate) async fn settle(
        &self,
        routines: &[RoutineTriggers],
        store: &Arc<dyn Store>,
        intake: &Arc<dyn RunIntake>,
    ) {
        let read = !self.runner.shared() || self.runner.confirmed_at().is_some();
        for routine in routines {
            let unleased = match self.runner.holder(&routine.id) {
                Holder::Here { epoch } => epoch == 0,
                Holder::Unknown => read,
                Holder::Elsewhere { .. } => false,
            };
            if !unleased {
                continue;
            }
            match self.runner.adopt(&routine.id).await {
                Ok(()) | Err(RunnerError::Off) => {}
                Err(error) => tracing::info!(routine_id = %routine.id, ?error, "a routine's first lease waits"),
            }
        }
        let away: Vec<String> = routines
            .iter()
            .filter(|routine| self.place(&routine.id) == Place::Elsewhere)
            .map(|r| r.id.clone())
            .collect();
        if away.is_empty() {
            return;
        }
        let intake = intake.clone();
        let moved = store.write(move |tx, out| intake.moved_away(tx, out, &away)).await;
        match moved {
            Ok(0) => {}
            Ok(runs) => tracing::info!(runs, "queued runs of routines held elsewhere were cancelled"),
            Err(error) => tracing::warn!(error = %error, "queued runs of routines held elsewhere stay queued"),
        }
    }
}
