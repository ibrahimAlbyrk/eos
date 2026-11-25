//! From a source's page to runs, exactly once (02 §3 B).
//!
//! Ingest (`ingest`) is one write: the page's signals are kept as `received` (a key
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
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard};

use eos_contracts::{
    Fact, Facts, FolderEvent, ItemRef, ResultMode, RoutineState, RunInput, RunTrigger, SignalChange, SignalChangeWhat,
    Trigger,
};
use eos_core::os::TimeZone;
use eos_core::routine::{
    Admission, AdmitOutcome, AdmitRefusal, RoutineControl, RoutineDirectory, RoutineTriggers, RunIntake,
};
use eos_core::signals::SignalSources;
use eos_core::store::{Outbox, Store, StoredSignal, StoredSignalRoute, StoredSignalSource, Tx};
use eos_core::{Clock, Error, Ids};
use eos_domain::signals::decision::Decision;
use eos_domain::signals::glob;
use eos_domain::signals::key::capability_scope;
use eos_domain::signals::which::{Verdict, evaluate};
use eos_inbox::Opening;

use tokio::sync::Notify;

use crate::SIGNALS_CHANGE;
use crate::holding::{Holding, Place};
use crate::limits::{fits_in, notice_over_limit_in, stale_in, supersede_in};
use crate::{after, ask, batch, local};

/// The kind of a schedule's slot, as signal and source.
pub(crate) const CLOCK: &str = "clock";

/// The signals one read takes to route.
const BATCH: i64 = 100;
/// A signal whose write failed is tried again at most this often.
const RETRY_MS: i64 = 60_000;

/// Whether Needs you's stop switch is on.
pub(crate) fn halted_in(tx: &dyn Tx) -> Result<bool, Error> {
    Ok(tx.inbox_halt().get()?.on)
}

/// What kind of failure an error is, for the log: its text may name the
/// user's things.
pub(crate) fn error_kind(error: &Error) -> &'static str {
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

/// Whether a routine's When reads the source the signal came from, for
/// what happened to it (a run upstream: how it ended; a file: added,
/// changed or removed, its name matching the routine's).
fn takes(routine: &RoutineTriggers, source: &StoredSignalSource, kind: &str, facts: &Facts) -> bool {
    routine.when.on.iter().any(|trigger| match trigger {
        Trigger::Source { source: name, scope, events, .. } => {
            source.source.as_deref() == Some(name.as_str())
                && capability_scope(name, scope).1 == source.scope_hash
                && (events.is_empty() || events.iter().any(|event| event == kind))
        }
        Trigger::Folder { folder, .. } => {
            let name = match facts.get("name") {
                Some(Fact::Text(name)) => name.as_str(),
                _ => "",
            };
            source.kind == local::FOLDER
                && source.scope_hash == local::folder_scope(&folder.path)
                && folder.events.iter().any(|event| folder_event(*event) == kind)
                && folder.names.as_deref().is_none_or(|names| glob::matches(names, name))
        }
        Trigger::Git { git, .. } => {
            source.kind == local::GIT && source.scope_hash == local::git_scope(&git.repo, &git.branch)
        }
        Trigger::After { after, .. } => {
            source.kind == after::AFTER
                && source.scope_hash == after::scope_hash(&after.routine)
                && after::takes(after.outcome, kind)
        }
        _ => false,
    })
}

/// The kind of a folder's signal for `event`.
fn folder_event(event: FolderEvent) -> &'static str {
    match event {
        FolderEvent::Added => "added",
        FolderEvent::Changed => "changed",
        FolderEvent::Removed => "removed",
    }
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
        surface: None,
        chat: None,
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
    pub(crate) holding: Arc<Holding>,
    pub(crate) intake: Arc<dyn RunIntake>,
    pub(crate) directory: Arc<dyn RoutineDirectory>,
    /// What says which events end their subject.
    pub(crate) sources: Arc<dyn SignalSources>,
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
    /// More signals wait to be routed than ingest takes more of.
    pub(crate) backed_up: AtomicBool,
    /// The model's stage of Which.
    pub(crate) asks: ask::Asks,
}

/// What one signal's routing needs inside its write.
pub(crate) struct Routing {
    holding: Arc<Holding>,
    pub(crate) intake: Arc<dyn RunIntake>,
    pub(crate) autostart: bool,
    pub(crate) now: i64,
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
        if signal.signal.depth > after::CHAIN_MAX {
            return Ok((Decision::Refused, Some("depth".into()), None));
        }
        let verdict = routine.which.rule.as_ref().map_or(Verdict::Pass, |rule| evaluate(rule, facts));
        match verdict {
            Verdict::Fail(index) => return Ok((Decision::Unmatched, Some(index.to_string()), None)),
            Verdict::Missing(_) => return Ok((Decision::Undecided, Some("missing".into()), None)),
            // Outside the installed app the model is never asked.
            Verdict::Pass if routine.which.ask.is_some() && !self.autostart => {
                return Ok((Decision::Undecided, Some(ask::DEV_RUN.into()), None));
            }
            // The model's stage of Which decides it (`ask`).
            Verdict::Pass if routine.which.ask.is_some() => {
                return Ok((Decision::Undecided, Some(ask::ASK.into()), None));
            }
            Verdict::Pass => {}
        }
        self.admit_in(tx, out, routine, signal)
    }

    /// The decision of a signal that matched: held outside the installed
    /// app, else the subject's waiting runs superseded and the run admitted,
    /// or batched.
    pub(crate) fn admit_in(
        &self,
        tx: &dyn Tx,
        out: &mut Outbox,
        routine: &RoutineTriggers,
        signal: &StoredSignal,
    ) -> Result<(Decision, Option<String>, Option<String>), Error> {
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

    /// Routes one received signal inside a write job; a `baseline` one is
    /// decided so for every routine, with no run.
    pub(crate) fn route_in(
        &self,
        tx: &dyn Tx,
        out: &mut Outbox,
        id: i64,
        routines: &[RoutineTriggers],
        baseline: bool,
    ) -> Result<(), Error> {
        let Some(signal) = tx.signals().find(id)?.filter(|signal| !signal.routed) else { return Ok(()) };
        if !baseline && halted_in(tx)? {
            return Ok(());
        }
        let source = tx.signal_sources().find(&signal.signal.source_id)?;
        let facts: Facts =
            signal.signal.facts_json.as_deref().and_then(|json| serde_json::from_str(json).ok()).unwrap_or_default();
        let matching: Vec<(&RoutineTriggers, Place)> = routines
            .iter()
            .filter(|routine| source.as_ref().is_some_and(|source| takes(routine, source, &signal.signal.kind, &facts)))
            .map(|routine| (routine, self.holding.place(&routine.id)))
            .collect();
        // A routine whose holder is not known yet keeps the signal waiting.
        if matching.iter().any(|(_, place)| *place == Place::Waiting) {
            return Ok(());
        }
        for (routine, place) in matching {
            if place == Place::Elsewhere {
                // Kept so a move here can take it up; the baseline of a source is no one's work.
                if !baseline {
                    self.record_in(tx, out, routine, &signal, (Decision::Elsewhere, None, None))?;
                }
                continue;
            }
            let decided = if baseline {
                (Decision::Baseline, None, None)
            } else {
                self.decide(tx, out, routine, &signal, &facts)?
            };
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
        let route = StoredSignalRoute {
            signal_id: signal.id,
            routine_id: routine.id.clone(),
            routine_version: routine.version.clone(),
            decision,
            reason,
            run_id,
            model_asked: false,
            decided_at: self.now,
        };
        self.keep_in(tx, out, routine, signal, route, true)
    }

    /// Keeps `route`, a new decision when `first` (else one in place of the
    /// undecided one before), with what it brings.
    pub(crate) fn keep_in(
        &self,
        tx: &dyn Tx,
        out: &mut Outbox,
        routine: &RoutineTriggers,
        signal: &StoredSignal,
        route: StoredSignalRoute,
        first: bool,
    ) -> Result<(), Error> {
        let decision = route.decision;
        if first {
            tx.signal_routes().insert(&route)?;
        } else {
            tx.signal_routes().put(&route)?;
        }
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
        if self.store.read(halted_in).await? {
            return Ok(0);
        }
        let routines = Arc::new(self.directory.triggers().await?);
        let mut routed = 0;
        let mut after = 0;
        loop {
            let waiting = self.store.read(move |tx| tx.signals().received(after, BATCH)).await?;
            let Some(last) = waiting.last() else {
                self.close_due_batches(&routines).await;
                return Ok(routed);
            };
            after = last.id;
            for signal in waiting {
                if !self.due_again(signal.id) {
                    continue;
                }
                let routing = self.routing();
                let routines = routines.clone();
                match self.store.write(move |tx, out| routing.route_in(tx, out, signal.id, &routines, false)).await {
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
            holding: self.holding.clone(),
            intake: self.intake.clone(),
            autostart: self.autostart,
            now: self.clock.now_ms(),
            ids: self.ids.clone(),
            zone: self.zone.clone(),
            control: self.control.clone(),
        }
    }

    /// Closes the batches of the active routines held here that came due,
    /// one write each; one whose write fails is logged and tried again next
    /// pass, while the others close.
    async fn close_due_batches(&self, routines: &[RoutineTriggers]) {
        if !self.autostart {
            return;
        }
        let held = |routine: &&RoutineTriggers| self.holding.acts(&routine.id);
        let batching = routines.iter().filter(|routine| routine.when.batch.is_some()).filter(held);
        for routine in batching.filter(|routine| routine.state == RoutineState::Active) {
            let (intake, closing, now) = (self.intake.clone(), routine.clone(), self.clock.now_ms());
            let closed = self.store.write(move |tx, out| batch::close_in(tx, out, intake.as_ref(), &closing, now));
            if let Err(error) = closed.await {
                tracing::warn!(routine_id = %routine.id, error = error_kind(&error), "a batch could not be closed");
            }
        }
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
            if let Err(error) = self.ask_pass().await {
                tracing::warn!(error = error_kind(&error), "questions for the model could not be read");
            }
            self.kick.notified().await;
        }
    }
}
