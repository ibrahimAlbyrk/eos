//! The gate a checked result passes (03 §4.8), behind 01's [`RunGate`]:
//! inside the run's own write job it decides whether the result is only
//! shown, refused, held for the user as a `draft` item or handed to the
//! delivery engine, and writes the rows of that decision in the same job.
//!
//! - `targets`: where the result would go, each target checked against the
//!   Goes to the user confirmed;
//! - `apply`: the decision, from the channel action's class, the outbound
//!   check and the rung under every cap; and taking back a held result.

mod apply;
mod targets;

pub(crate) use apply::DRAFT_PRODUCER;
pub use apply::TARGET_REFUSED;

use std::sync::Arc;

use eos_core::delivery::Channels;
use eos_core::os::TimeZone;
use eos_core::routine::{GateDecision, GateInput, RoutineControl, RunGate, RunOutcomes};
use eos_core::store::{Outbox, Tx};
use eos_core::{Clock, Error, Ids};
use tokio::sync::Notify;

use crate::control::{LateControl, LateOutcomes};

/// Needs you's gate.
pub struct Gate {
    channels: Arc<dyn Channels>,
    zone: Arc<dyn TimeZone>,
    clock: Arc<dyn Clock>,
    control: LateControl,
    outcomes: LateOutcomes,
    /// Pokes the delivery engine once a decision queued deliveries.
    wake: Arc<Notify>,
}

impl std::fmt::Debug for Gate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Gate").finish_non_exhaustive()
    }
}

impl Gate {
    pub fn new(channels: Arc<dyn Channels>, zone: Arc<dyn TimeZone>, clock: Arc<dyn Clock>) -> Self {
        Self {
            channels,
            zone,
            clock,
            control: LateControl::default(),
            outcomes: LateOutcomes::default(),
            wake: Arc::new(Notify::new()),
        }
    }

    /// The routines' control, which pauses a routine whose result was
    /// refused, and its run outcomes, which end the run whose draft a newer
    /// one replaced. The caller keeps both alive.
    pub fn attach(&self, control: &Arc<dyn RoutineControl>, outcomes: &Arc<dyn RunOutcomes>) {
        self.control.attach(control);
        self.outcomes.attach(outcomes);
    }

    /// What wakes the delivery engine when the gate queued deliveries.
    pub fn waker(&self) -> Arc<Notify> {
        self.wake.clone()
    }

    fn control(&self) -> Result<Arc<dyn RoutineControl>, Error> {
        self.control.get()
    }

    fn outcomes(&self) -> Result<Arc<dyn RunOutcomes>, Error> {
        self.outcomes.get()
    }
}

impl RunGate for Gate {
    fn apply_in(
        &self,
        tx: &dyn Tx,
        out: &mut Outbox,
        now: i64,
        ids: &dyn Ids,
        input: &GateInput,
    ) -> Result<GateDecision, Error> {
        apply::apply_in(self, tx, out, now, ids, input)
    }

    fn withdraw_in(&self, tx: &dyn Tx, out: &mut Outbox, run_id: &str) -> Result<(), Error> {
        apply::withdraw_in(tx, out, self.clock.now_ms(), run_id)
    }
}
