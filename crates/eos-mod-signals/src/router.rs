//! From a source's page to runs, exactly once (02 §3 B).
//!
//! Ingest is one write: the page's signals are kept as `received` (a key
//! the source reported before costs nothing) and the source's cursor moves
//! with them. Routing is one write per signal: one `signal_routes` row for
//! each routine held here that takes the signal, the run of each `run`
//! decision admitted, the signal marked `routed` and `signals:change`
//! announced, all saved together or not at all. A crash between the two
//! leaves `received` signals, which the next pass routes; a signal written
//! `routed` (a run started by hand) is never routed again.
//!
//! A match that may start a run first supersedes the subject's run that
//! still waits, then joins the routine's batch when it has one, then meets
//! the routine's limits (`limits`, `batch`); the decision, its run and the
//! over-limit notice commit together. Each pass ends by closing the batches
//! that came due.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use eos_contracts::{
    Facts, ItemRef, ResultMode, RoutineState, RunInput, RunTrigger, SignalChange, SignalChangeWhat, Trigger,
};
use eos_core::os::TimeZone;
use eos_core::routine::{
    Admission, AdmitOutcome, AdmitRefusal, RoutineControl, RoutineDirectory, RoutineTriggers, RunIntake,
};
use eos_core::signals::{Holder, PollPage, Runner};
use eos_core::store::{NewSignal, Outbox, Store, StoredSignal, StoredSignalRoute, StoredSignalSource, Tx};
use eos_core::{Clock, Error, Ids};
use eos_domain::signals::decision::Decision;
use eos_domain::signals::key::{capability_scope, fits};
use eos_domain::signals::which::{Verdict, evaluate};
use eos_inbox::Opening;
use tokio::sync::Notify;

use crate::SIGNALS_CHANGE;
use crate::batch;
use crate::limits::{fits_in, notice_over_limit_in, stale_in, supersede_in};

/// The kind of a schedule's slot, as signal and source.
pub(crate) const CLOCK: &str = "clock";

/// The signals one read takes to route.
const BATCH: i64 = 100;
/// A signal whose write failed is tried again at most this often.
const RETRY_MS: i64 = 60_000;

/// What kind of failure an error is, for the log: its text may name the
/// user's things.
fn error_kind(error: &Error) -> &'static str {
    match error {
        Error::NotFound { .. } => "not_found",
        Error::Conflict(_) => "conflict",
        Error::Validation(_) => "validation",
        Error::PermissionDenied(_) => "permission_denied",
        Error::LimitExceeded(_) => "limit_exceeded",
        Error::Unreachable(_) => "unreachable",
        Error::Rule(_) => "rule",
        Error::Storage(_) => "storage",
    }
}

/// Keeps a page inside a write job: its new signals as `received`, the
/// source's cursor as the page gave it. Answers how many were new.
pub(crate) fn ingest_in(tx: &dyn Tx, source_id: &str, page: &PollPage, now: i64) -> Result<usize, Error> {
    let mut source = tx.signal_sources().find(source_id)?.ok_or_else(|| Error::not_found("source", source_id))?;
    let mut fresh = 0;
    for draft in page.items.iter().filter(|draft| fits(&draft.key)) {
        let signal = NewSignal {
            source_id: source_id.to_owned(),
            key: draft.key.clone(),
            subject: draft.subject.clone(),
            version: draft.version.clone(),
            kind: draft.kind.clone(),
            occurred_at: draft.occurred_at,
            received_at: now,
            facts_json: serde_json::to_string(&draft.facts).ok(),
            item_json: draft.item.to_string(),
            depth: 0,
        };
        fresh += usize::from(tx.signals().ingest(&signal)?.is_some());
    }
    source.cursor_json = Some(page.cursor.to_string());
    source.last_poll_at = Some(now);
    if fresh > 0 {
        source.last_signal_at = Some(now);
    }
    source.updated_at = now;
    tx.signal_sources().update(&source)?;
    tracing::info!(source_id, items = page.items.len(), fresh, "a source's page was kept");
    Ok(fresh)
}

/// Whether a routine's When reads the source the signal came from, for
/// what happened to it.
fn takes(routine: &RoutineTriggers, source: &StoredSignalSource, kind: &str) -> bool {
    routine.when.on.iter().any(|trigger| match trigger {
        Trigger::Source { source: name, scope, events, .. } => {
            source.source.as_deref() == Some(name.as_str())
                && capability_scope(name, scope).1 == source.scope_hash
                && (events.is_empty() || events.iter().any(|event| event == kind))
        }
        _ => false,
    })
}

/// What started a run of `signal`: a schedule's slot names the slot and how
/// late it fired.
fn trigger(signal: &StoredSignal) -> RunTrigger {
    let slot = (signal.signal.kind == CLOCK).then_some(signal.signal.occurred_at);
    RunTrigger {
        signal_id: signal.id.to_string(),
        slot_at: slot,
        late_by_ms: slot.map(|slot| signal.signal.received_at - slot),
    }
}

/// Admits one run of `routine` for `signal` when the routine's limits let
/// it, then supersedes the subject's `stale` runs: the decision, with its
/// reason and run. A refused admission leaves the waiting run to run.
pub(crate) fn run_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    intake: &dyn RunIntake,
    routine: &RoutineTriggers,
    signal: &StoredSignal,
    now: i64,
    stale: &[String],
) -> Result<(Decision, Option<String>, Option<String>), Error> {
    if !fits_in(tx, intake, &routine.id, &routine.when, now, stale.len())? {
        return Ok((Decision::OverLimit, Some("limits".into()), None));
    }
    let input = RunInput {
        item: serde_json::from_str::<ItemRef>(&signal.signal.item_json).ok(),
        items: None,
        trigger: Some(trigger(signal)),
        options: Default::default(),
        note: None,
        result: ResultMode::Usual,
        at: None,
    };
    let admission = Admission { routine_id: routine.id.clone(), signal_id: signal.id, input };
    Ok(match intake.admit(tx, out, &admission)? {
        AdmitOutcome::Queued { run_id } => {
            supersede_in(tx, out, intake, stale)?;
            (Decision::Run, None, Some(run_id))
        }
        AdmitOutcome::Refused { reason: AdmitRefusal::QueueFull } => {
            (Decision::OverLimit, Some("queue_full".into()), None)
        }
        AdmitOutcome::Refused { reason: AdmitRefusal::NotActive } => {
            (Decision::Refused, Some("not_active".into()), None)
        }
    })
}

/// What routes signals: the store, who holds each routine, and the runs.
pub(crate) struct Router {
    pub(crate) store: Arc<dyn Store>,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) runner: Arc<dyn Runner>,
    pub(crate) intake: Arc<dyn RunIntake>,
    pub(crate) directory: Arc<dyn RoutineDirectory>,
    pub(crate) autostart: bool,
    /// Rings when there may be signals to route.
    pub(crate) kick: Notify,
    /// What opening the over-limit notice needs.
    pub(crate) ids: Arc<dyn Ids>,
    pub(crate) zone: Arc<dyn TimeZone>,
    pub(crate) control: Arc<dyn RoutineControl>,
    /// When each signal whose write failed last failed: a cache, so a
    /// restart tries them all again at once.
    pub(crate) failed: Mutex<HashMap<i64, i64>>,
}

/// What one signal's routing needs inside its write.
pub(crate) struct Routing {
    runner: Arc<dyn Runner>,
    pub(crate) intake: Arc<dyn RunIntake>,
    pub(crate) autostart: bool,
    now: i64,
    ids: Arc<dyn Ids>,
    zone: Arc<dyn TimeZone>,
    control: Arc<dyn RoutineControl>,
}

impl Routing {
    /// The decision of `routine` on `signal`, with its reason and run.
    fn decide(
        &self,
        tx: &dyn Tx,
        out: &mut Outbox,
        routine: &RoutineTriggers,
        signal: &StoredSignal,
        facts: &Facts,
    ) -> Result<(Decision, Option<String>, Option<String>), Error> {
        match routine.state {
            RoutineState::Active => {}
            RoutineState::Paused | RoutineState::Archived => return Ok((Decision::Paused, None, None)),
            _ => return Ok((Decision::Refused, Some("state".into()), None)),
        }
        let verdict = routine.which.rule.as_ref().map_or(Verdict::Pass, |rule| evaluate(rule, facts));
        match verdict {
            Verdict::Fail(index) => return Ok((Decision::Unmatched, Some(index.to_string()), None)),
            Verdict::Missing(_) => return Ok((Decision::Undecided, Some("missing".into()), None)),
            // The model's stage of Which decides it; it is not asked yet.
            Verdict::Pass if routine.which.ask.is_some() => return Ok((Decision::Undecided, Some("ask".into()), None)),
            Verdict::Pass => {}
        }
        if !self.autostart {
            return Ok((Decision::HeldDev, None, None));
        }
        let stale = stale_in(tx, &routine.id, &signal.signal.subject)?;
        if routine.when.batch.is_some() {
            supersede_in(tx, out, self.intake.as_ref(), &stale)?;
            return Ok((Decision::Batched, None, None));
        }
        run_in(tx, out, self.intake.as_ref(), routine, signal, self.now, &stale)
    }

    /// Routes one received signal inside a write job.
    fn route_in(&self, tx: &dyn Tx, out: &mut Outbox, id: i64, routines: &[RoutineTriggers]) -> Result<(), Error> {
        let Some(signal) = tx.signals().find(id)?.filter(|signal| !signal.routed) else { return Ok(()) };
        let source = tx.signal_sources().find(&signal.signal.source_id)?;
        let facts: Facts =
            signal.signal.facts_json.as_deref().and_then(|json| serde_json::from_str(json).ok()).unwrap_or_default();
        let held = |routine: &&RoutineTriggers| matches!(self.runner.holder(&routine.id), Holder::Here { .. });
        let takers = routines
            .iter()
            .filter(|routine| source.as_ref().is_some_and(|source| takes(routine, source, &signal.signal.kind)))
            .filter(held);
        for routine in takers {
            let decided = self.decide(tx, out, routine, &signal, &facts)?;
            self.record_in(tx, out, routine, &signal, decided)?;
        }
        tx.signals().mark_routed(id)
    }

    /// Keeps the routine's decision on the signal, with what it brings: the
    /// batch closed when full, the day's over-limit notice, and
    /// `signals:change`.
    pub(crate) fn record_in(
        &self,
        tx: &dyn Tx,
        out: &mut Outbox,
        routine: &RoutineTriggers,
        signal: &StoredSignal,
        (decision, reason, run_id): (Decision, Option<String>, Option<String>),
    ) -> Result<(), Error> {
        tx.signal_routes().insert(&StoredSignalRoute {
            signal_id: signal.id,
            routine_id: routine.id.clone(),
            routine_version: routine.version.clone(),
            decision,
            reason,
            run_id,
            model_asked: false,
            decided_at: self.now,
        })?;
        tracing::info!(signal_id = signal.id, routine_id = %routine.id, decision = decision.as_str(), "a signal was decided");
        match decision {
            Decision::Batched => {
                batch::close_in(tx, out, self.intake.as_ref(), routine, self.now)?;
            }
            Decision::OverLimit => {
                let at = Opening {
                    now: self.now,
                    ids: self.ids.as_ref(),
                    zone: self.zone.as_ref(),
                    control: self.control.as_ref(),
                };
                notice_over_limit_in(tx, out, &at, &routine.id)?;
            }
            _ => {}
        }
        let change = SignalChange {
            routine_id: Some(routine.id.clone()),
            source_id: Some(signal.signal.source_id.clone()),
            what: SignalChangeWhat::Routed,
        };
        out.push(SIGNALS_CHANGE.name(), &change);
        Ok(())
    }
}

impl Router {
    /// Routes every `received` signal, oldest first; answers how many. A
    /// signal whose write fails is logged and left for a later pass, at most
    /// once every [`RETRY_MS`], while the ones after it are routed.
    pub(crate) async fn pass(&self) -> Result<usize, Error> {
        let routines = Arc::new(self.directory.triggers().await?);
        let mut routed = 0;
        let mut after = 0;
        loop {
            let waiting = self.store.read(move |tx| tx.signals().received(after, BATCH)).await?;
            let Some(last) = waiting.last() else {
                self.close_due_batches(&routines).await?;
                return Ok(routed);
            };
            after = last.id;
            for signal in waiting {
                if !self.due_again(signal.id) {
                    continue;
                }
                let routing = self.routing();
                let routines = routines.clone();
                match self.store.write(move |tx, out| routing.route_in(tx, out, signal.id, &routines)).await {
                    Ok(()) => {
                        self.failed().remove(&signal.id);
                        routed += 1;
                    }
                    Err(error) => {
                        tracing::warn!(
                            signal_id = signal.id,
                            error = error_kind(&error),
                            "a signal could not be routed"
                        );
                        self.failed().insert(signal.id, self.clock.now_ms());
                    }
                }
            }
        }
    }

    /// Whether the signal never failed to route, or failed over
    /// [`RETRY_MS`] ago.
    fn due_again(&self, signal_id: i64) -> bool {
        let now = self.clock.now_ms();
        self.failed().get(&signal_id).is_none_or(|at| now - at >= RETRY_MS)
    }

    fn failed(&self) -> MutexGuard<'_, HashMap<i64, i64>> {
        self.failed.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn routing(&self) -> Routing {
        Routing {
            runner: self.runner.clone(),
            intake: self.intake.clone(),
            autostart: self.autostart,
            now: self.clock.now_ms(),
            ids: self.ids.clone(),
            zone: self.zone.clone(),
            control: self.control.clone(),
        }
    }

    /// Closes the batches of the active routines held here that came due,
    /// one write each.
    async fn close_due_batches(&self, routines: &[RoutineTriggers]) -> Result<(), Error> {
        if !self.autostart {
            return Ok(());
        }
        let held = |routine: &&RoutineTriggers| matches!(self.runner.holder(&routine.id), Holder::Here { .. });
        let batching = routines.iter().filter(|routine| routine.when.batch.is_some()).filter(held);
        for routine in batching.filter(|routine| routine.state == RoutineState::Active) {
            let (intake, routine, now) = (self.intake.clone(), routine.clone(), self.clock.now_ms());
            self.store.write(move |tx, out| batch::close_in(tx, out, intake.as_ref(), &routine, now)).await?;
        }
        Ok(())
    }

    /// Routes until stopped: at once (what a crash left `received`), then
    /// on each kick.
    pub(crate) async fn run(self: Arc<Self>) {
        loop {
            match self.pass().await {
                Ok(0) => {}
                Ok(routed) => tracing::info!(routed, "signals were routed"),
                Err(error) => tracing::warn!(%error, "signals could not be routed"),
            }
            self.kick.notified().await;
        }
    }
}
