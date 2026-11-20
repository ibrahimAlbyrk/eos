//! The scheduler (02 §3 A, §4.4): fires each schedule of each active
//! routine held here once a slot, also after a sleep, a closed app or a
//! clock that jumped.
//!
//! A pass reads what starts each routine's runs, keeps one
//! `signal_schedules` row per schedule and fires what is due, one write job
//! per schedule: the slot's clock signal, its decision, the run admitted
//! and the row moved, saved together or not at all. A schedule that is new,
//! changed or resumed is armed then: no slot before it fires. The latest
//! slot fires once however many passed, `missed` counting the rest; a slot
//! at or before the last one fired never fires. Then the sources the
//! routines read are kept and the due ones polled (`polls`), and the router
//! is kicked, which closes due batches and retries what it could not route.
//!
//! Between passes the loop sleeps until the next slot, at most
//! [`SCHEDULER_MAX_SLEEP_MS`], since the timer stops while the computer
//! sleeps; a wake, a routine's change and a run's change start a pass at
//! once. Every pass reads the wall clock again.

use std::sync::Arc;

use eos_contracts::{RoutineState, Schedule, Trigger};
use eos_core::os::ZoneRules;
use eos_core::routine::RoutineTriggers;
use eos_core::signals::{Holder, Runner};
use eos_core::store::{NewSignal, Outbox, Store, StoredSignalSchedule, Tx};
use eos_core::{Clock, Error, Ids, Sleeper};
use eos_domain::routine::blueprint::hash;
use eos_domain::signals::decision::Decision;
use eos_domain::signals::key;
use eos_domain::signals::schedule::{ScheduleState, clock_reset, due, next_slot};
use tokio::sync::Notify;

use crate::polls::Polls;
use crate::router::{CLOCK, Router, Routing, run_in};
use crate::sources::{SourceSpec, source_in};

/// The loop never sleeps longer: a sleep of the computer, a changed clock
/// or zone is seen within this much awake time.
pub const SCHEDULER_MAX_SLEEP_MS: i64 = 60_000;
/// A slot that fires later than this after its time counts as late.
pub(crate) const LATE_MS: i64 = 5 * 60_000;
/// What `spec_hash` holds while the routine does not run: any schedule is
/// armed again when it does.
const NOT_ARMED: &str = "not-armed";

pub(crate) struct Scheduler {
    pub(crate) store: Arc<dyn Store>,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) sleeper: Arc<dyn Sleeper>,
    pub(crate) ids: Arc<dyn Ids>,
    pub(crate) zones: Arc<dyn ZoneRules>,
    pub(crate) runner: Arc<dyn Runner>,
    pub(crate) router: Arc<Router>,
    pub(crate) polls: Arc<Polls>,
    /// Rings when a pass should run now.
    pub(crate) kick: Arc<Notify>,
}

/// The earlier of two times, either of which may be none.
fn earliest(a: Option<i64>, b: Option<i64>) -> Option<i64> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}

impl Scheduler {
    /// Passes until stopped.
    pub(crate) async fn run(self: Arc<Self>) {
        loop {
            let next = match self.pass().await {
                Ok(next) => next,
                Err(error) => {
                    tracing::warn!(%error, "schedules could not be read");
                    None
                }
            };
            self.router.kick.notify_one();
            let wait =
                next.map_or(SCHEDULER_MAX_SLEEP_MS, |at| (at - self.clock.now_ms()).clamp(0, SCHEDULER_MAX_SLEEP_MS));
            tokio::select! {
                () = self.sleeper.sleep(wait) => {}
                () = self.kick.notified() => {}
            }
        }
    }

    /// One pass over every schedule of the routines held here, then their
    /// sources; answers the next slot or poll of any.
    async fn pass(&self) -> Result<Option<i64>, Error> {
        let routines = self.router.directory.triggers().await?;
        let held: Vec<Arc<RoutineTriggers>> = routines
            .into_iter()
            .filter(|routine| matches!(self.runner.holder(&routine.id), Holder::Here { .. }))
            .map(Arc::new)
            .collect();
        let mut next: Option<i64> = None;
        for routine in &held {
            for (slot, trigger) in routine.when.on.iter().enumerate() {
                let Trigger::Schedule { schedule, .. } = trigger else { continue };
                let job = Slot {
                    routine: routine.clone(),
                    slot: slot as i64,
                    schedule: schedule.clone(),
                    now: self.clock.now_ms(),
                    zones: self.zones.clone(),
                    ids: self.ids.clone(),
                    routing: self.router.routing(),
                };
                let at = self.store.write(move |tx, out| job.fire_in(tx, out)).await?;
                next = earliest(next, at);
            }
        }
        self.polls.ensure(&held).await?;
        Ok(earliest(next, self.polls.start_due().await?))
    }
}

/// One schedule of one routine, as one pass sees it.
struct Slot {
    routine: Arc<RoutineTriggers>,
    slot: i64,
    schedule: Schedule,
    now: i64,
    zones: Arc<dyn ZoneRules>,
    ids: Arc<dyn Ids>,
    routing: Routing,
}

impl Slot {
    /// Arms the schedule when it is new, changed or resumed and fires its
    /// due slot, inside one write; answers its next slot.
    fn fire_in(self, tx: &dyn Tx, out: &mut Outbox) -> Result<Option<i64>, Error> {
        let routine_id = self.routine.id.as_str();
        let stored = tx.signal_schedules().of_routine(routine_id)?.into_iter().find(|row| row.slot == self.slot);
        if self.routine.state != RoutineState::Active {
            if let Some(row) = stored.filter(|row| row.spec_hash != NOT_ARMED) {
                let row =
                    StoredSignalSchedule { spec_hash: NOT_ARMED.into(), next_at: None, updated_at: self.now, ..row };
                tx.signal_schedules().put(&row)?;
            }
            return Ok(None);
        }
        if !self.zones.known(&self.schedule.zone) {
            return Ok(None);
        }
        let spec_hash = hash(&serde_json::to_string(&self.schedule).unwrap_or_default());
        let armed = stored.as_ref().is_some_and(|row| row.spec_hash == spec_hash);
        let mut row = match stored {
            Some(row) if armed => row,
            earlier => {
                tracing::info!(routine_id, slot = self.slot, armed_at = self.now, "a schedule was armed");
                StoredSignalSchedule {
                    routine_id: routine_id.to_owned(),
                    slot: self.slot,
                    spec_hash,
                    zone: self.schedule.zone.clone(),
                    armed_at: self.now,
                    last_slot_at: earlier.as_ref().and_then(|row| row.last_slot_at),
                    next_at: None,
                    missed: earlier.as_ref().map_or(0, |row| row.missed),
                    late_by_ms: earlier.as_ref().map_or(0, |row| row.late_by_ms),
                    updated_at: self.now,
                }
            }
        };
        let before = row.clone();
        let zones = self.zones.clone();
        let zone = self.schedule.zone.clone();
        let offset_at = move |at: i64| zones.offset_minutes_at(&zone, at).unwrap_or(0);
        let state =
            ScheduleState { repeat: &self.schedule.repeat, armed_at: row.armed_at, last_slot_at: row.last_slot_at };
        if clock_reset(&state, self.now) {
            tracing::warn!(
                routine_id,
                slot = self.slot,
                last_slot_at = row.last_slot_at,
                now = self.now,
                "clock_reset"
            );
            row.last_slot_at = Some(self.now);
        }
        if let Some(due) = due(&state, self.now, &offset_at) {
            self.slot_in(tx, out, due.slot, due.missed)?;
            row.last_slot_at = Some(due.slot);
            row.missed = due.missed;
            row.late_by_ms = if due.late_by > LATE_MS { due.late_by } else { 0 };
            tracing::info!(
                routine_id,
                slot = self.slot,
                slot_at = due.slot,
                missed = due.missed,
                late_by_ms = due.late_by,
                "a schedule fired"
            );
        }
        let after = row.last_slot_at.map_or(self.now, |last| last.max(self.now));
        row.next_at = next_slot(&self.schedule.repeat, after, &offset_at);
        if !armed || row != before {
            row.updated_at = self.now;
            tx.signal_schedules().put(&row)?;
        }
        Ok(row.next_at)
    }

    /// The slot's clock signal, decided and its run admitted. Its facts
    /// keep how many slots it ran for, which the routine's counts add up.
    fn slot_in(&self, tx: &dyn Tx, out: &mut Outbox, slot: i64, missed: i64) -> Result<(), Error> {
        let routine = self.routine.as_ref();
        let source_id = clock_source_in(tx, self.ids.as_ref(), &routine.id, self.now)?;
        let key = key::clock(&routine.id, slot);
        let signal = NewSignal {
            source_id,
            key: key.clone(),
            subject: key,
            version: None,
            kind: CLOCK.into(),
            occurred_at: slot,
            received_at: self.now,
            facts_json: Some(serde_json::json!({ "missed": missed }).to_string()),
            item_json: "null".into(),
            depth: 0,
        };
        let Some(id) = tx.signals().ingest(&signal)? else { return Ok(()) };
        let signal = tx.signals().find(id)?.ok_or_else(|| Error::not_found("signal", id.to_string()))?;
        let decided = if self.routing.autostart {
            run_in(tx, out, self.routing.intake.as_ref(), routine, &signal, self.now, &[])?
        } else {
            (Decision::HeldDev, None, None)
        };
        self.routing.record_in(tx, out, routine, &signal, decided)?;
        tx.signals().mark_routed(id)
    }
}

/// The source every slot of the routine's schedules is a signal of, made
/// the first time one fires.
fn clock_source_in(tx: &dyn Tx, ids: &dyn Ids, routine_id: &str, now: i64) -> Result<String, Error> {
    let spec = SourceSpec {
        kind: CLOCK,
        source: None,
        scope_json: serde_json::json!({ "routine": routine_id }).to_string(),
        scope_hash: format!("{CLOCK}:{routine_id}"),
        interval_ms: 0,
    };
    Ok(source_in(tx, ids, spec, now)?.0.id)
}
