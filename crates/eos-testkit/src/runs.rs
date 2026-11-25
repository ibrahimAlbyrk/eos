//! The run ports other areas call, answered from what the test sets: starts,
//! admissions and the routines' triggers; the gate routines call, and what
//! Needs you reports back of a result.

use std::sync::{Mutex, MutexGuard};

use eos_core::routine::{
    Admission, AdmitOutcome, AdmitRefusal, FinishedRun, GateDecision, GateInput, NewRun, RoutineDirectory, RoutineLoad,
    RoutineTriggers, RunCreated, RunGate, RunIntake, RunOutcomes, RunStarter, StartError,
};
use eos_core::store::{Outbox, Tx};
use eos_core::{BoxFuture, Error};
use eos_domain::routine::numbers::Outcome;
use eos_domain::routine::run::{Reason, RunState};

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Queues every start as runs `rn-1`, `rn-2`, … (one per item), unless the
/// test set a refusal. Records starts and stops.
#[derive(Debug, Default)]
pub struct FakeRunStarter {
    refusal: Mutex<Option<StartError>>,
    started: Mutex<Vec<NewRun>>,
    stopped: Mutex<Vec<(String, Reason)>>,
    made: Mutex<u32>,
}

impl FakeRunStarter {
    pub fn new() -> Self {
        Self::default()
    }

    /// The next start is refused with `error`.
    pub fn refuse(&self, error: StartError) {
        *locked(&self.refusal) = Some(error);
    }

    pub fn started(&self) -> Vec<NewRun> {
        locked(&self.started).clone()
    }

    pub fn stopped(&self) -> Vec<(String, Reason)> {
        locked(&self.stopped).clone()
    }
}

impl RunStarter for FakeRunStarter {
    fn start(&self, run: NewRun) -> BoxFuture<'_, Result<Vec<RunCreated>, StartError>> {
        let answer = match locked(&self.refusal).take() {
            Some(error) => Err(error),
            None => {
                let mut made = locked(&self.made);
                let runs = (0..run.items.len().max(1))
                    .map(|_| {
                        *made += 1;
                        RunCreated { id: format!("rn-{made}"), state: RunState::Queued, not_before: run.input.at }
                    })
                    .collect();
                locked(&self.started).push(run);
                Ok(runs)
            }
        };
        Box::pin(std::future::ready(answer))
    }

    fn stop<'a>(&'a self, run_id: &'a str, why: Reason) -> BoxFuture<'a, Result<(), Error>> {
        locked(&self.stopped).push((run_id.to_owned(), why));
        Box::pin(std::future::ready(Ok(())))
    }
}

/// Starts every App reviewer as `w-reviewer1`, `w-reviewer2`, … and
/// records each start and each note to a builder.
#[derive(Debug, Default)]
pub struct FakeAppReviews {
    started: Mutex<Vec<eos_core::routine::AppReviewStart>>,
    told: Mutex<Vec<(String, String, String)>>,
}

impl FakeAppReviews {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn started(&self) -> Vec<eos_core::routine::AppReviewStart> {
        locked(&self.started).clone()
    }

    /// Each note as (run, worker, text).
    pub fn told(&self) -> Vec<(String, String, String)> {
        locked(&self.told).clone()
    }
}

impl eos_core::routine::AppReviews for FakeAppReviews {
    fn start_reviewer(&self, start: eos_core::routine::AppReviewStart) -> BoxFuture<'_, Result<Option<String>, Error>> {
        let mut started = locked(&self.started);
        started.push(start);
        let id = format!("w-reviewer{}", started.len());
        Box::pin(std::future::ready(Ok(Some(id))))
    }

    fn tell<'a>(&'a self, run_id: &'a str, worker_id: &'a str, text: String) -> BoxFuture<'a, Result<(), Error>> {
        locked(&self.told).push((run_id.to_owned(), worker_id.to_owned(), text));
        Box::pin(std::future::ready(Ok(())))
    }
}

/// Admits every run as `rn-1`, `rn-2`, … unless the test set a refusal;
/// writes nothing. Answers the load and ended runs the test gives, and
/// records admissions and supersedes.
#[derive(Debug, Default)]
pub struct FakeRunIntake {
    refusal: Mutex<Option<AdmitRefusal>>,
    load: Mutex<Option<RoutineLoad>>,
    finished: Mutex<Vec<FinishedRun>>,
    admitted: Mutex<Vec<Admission>>,
    superseded: Mutex<Vec<String>>,
}

impl FakeRunIntake {
    pub fn new() -> Self {
        Self::default()
    }

    /// Every admission from now on is refused for `reason`.
    pub fn refuse(&self, reason: AdmitRefusal) {
        *locked(&self.refusal) = Some(reason);
    }

    /// What `load` answers for every routine.
    pub fn set_load(&self, load: RoutineLoad) {
        *locked(&self.load) = Some(load);
    }

    /// Runs that ended, in the order they ended.
    pub fn set_finished(&self, runs: Vec<FinishedRun>) {
        *locked(&self.finished) = runs;
    }

    pub fn admitted(&self) -> Vec<Admission> {
        locked(&self.admitted).clone()
    }

    pub fn superseded(&self) -> Vec<String> {
        locked(&self.superseded).clone()
    }
}

impl RunIntake for FakeRunIntake {
    fn admit(&self, _tx: &dyn Tx, _out: &mut Outbox, admission: &Admission) -> Result<AdmitOutcome, Error> {
        if let Some(reason) = *locked(&self.refusal) {
            return Ok(AdmitOutcome::Refused { reason });
        }
        let mut admitted = locked(&self.admitted);
        admitted.push(admission.clone());
        Ok(AdmitOutcome::Queued { run_id: format!("rn-{}", admitted.len()) })
    }

    fn supersede(&self, _tx: &dyn Tx, _out: &mut Outbox, run_id: &str) -> Result<bool, Error> {
        locked(&self.superseded).push(run_id.to_owned());
        Ok(true)
    }

    fn load(&self, _tx: &dyn Tx, _routine_id: &str, _since: i64) -> Result<RoutineLoad, Error> {
        Ok(locked(&self.load).unwrap_or(RoutineLoad { queued: 0, started_since: 0, active: 0 }))
    }

    fn finished_after(
        &self,
        _tx: &dyn Tx,
        _routine_id: &str,
        after_seq: i64,
        limit: i64,
    ) -> Result<Vec<FinishedRun>, Error> {
        let finished = locked(&self.finished);
        let later = finished.iter().filter(|run| run.seq > after_seq);
        Ok(later.take(usize::try_from(limit).unwrap_or_default()).cloned().collect())
    }
}

/// The routines' triggers the test gives.
#[derive(Debug, Default)]
pub struct FakeRoutineDirectory {
    triggers: Mutex<Vec<RoutineTriggers>>,
}

impl FakeRoutineDirectory {
    pub fn new(triggers: Vec<RoutineTriggers>) -> Self {
        Self { triggers: Mutex::new(triggers) }
    }

    /// What the next read answers.
    pub fn set(&self, triggers: Vec<RoutineTriggers>) {
        *locked(&self.triggers) = triggers;
    }
}

impl RoutineDirectory for FakeRoutineDirectory {
    fn triggers(&self) -> BoxFuture<'_, Result<Vec<RoutineTriggers>, Error>> {
        Box::pin(std::future::ready(Ok(locked(&self.triggers).clone())))
    }
}

/// The gate as the test scripts it: each result takes the next decision
/// set, else is shown. Records what it was given, the runs withdrawn and how
/// many deliveries it handed out.
#[derive(Debug, Default)]
pub struct FakeRunGate {
    decisions: Mutex<std::collections::VecDeque<GateDecision>>,
    inputs: Mutex<Vec<GateInput>>,
    withdrawn: Mutex<Vec<String>>,
    deliveries: Mutex<usize>,
}

impl FakeRunGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// The next result gets `decision`.
    pub fn decide(&self, decision: GateDecision) {
        locked(&self.decisions).push_back(decision);
    }

    /// What each call was given, in order.
    pub fn inputs(&self) -> Vec<GateInput> {
        locked(&self.inputs).clone()
    }

    pub fn withdrawn(&self) -> Vec<String> {
        locked(&self.withdrawn).clone()
    }

    /// The deliveries its decisions made.
    pub fn deliveries(&self) -> usize {
        *locked(&self.deliveries)
    }
}

impl RunGate for FakeRunGate {
    fn apply_in(
        &self,
        _tx: &dyn Tx,
        _out: &mut Outbox,
        _now: i64,
        _ids: &dyn eos_core::Ids,
        input: &GateInput,
    ) -> Result<GateDecision, Error> {
        locked(&self.inputs).push(input.clone());
        let decision = locked(&self.decisions).pop_front().unwrap_or(GateDecision::Shown);
        if let GateDecision::Delivering { delivery_ids } = &decision {
            *locked(&self.deliveries) += delivery_ids.len();
        }
        Ok(decision)
    }

    fn withdraw_in(&self, _tx: &dyn Tx, _out: &mut Outbox, run_id: &str) -> Result<(), Error> {
        locked(&self.withdrawn).push(run_id.to_owned());
        Ok(())
    }
}

/// One report [`FakeRunOutcomes`] was given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OutcomeCall {
    Held { run_id: String, item_id: String },
    Delivering(String),
    Finished { run_id: String, outcome: Outcome },
    DeliveryFailed { run_id: String, reason: String },
    Revise(String),
}

/// Records every report, in order; moves no run.
#[derive(Debug, Default)]
pub struct FakeRunOutcomes(Mutex<Vec<OutcomeCall>>);

impl FakeRunOutcomes {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn calls(&self) -> Vec<OutcomeCall> {
        locked(&self.0).clone()
    }

    fn record(&self, call: OutcomeCall) -> Result<(), Error> {
        locked(&self.0).push(call);
        Ok(())
    }
}

impl RunOutcomes for FakeRunOutcomes {
    fn held(&self, _: &dyn Tx, _: &mut Outbox, run_id: &str, inbox_id: &str) -> Result<(), Error> {
        self.record(OutcomeCall::Held { run_id: run_id.to_owned(), item_id: inbox_id.to_owned() })
    }

    fn delivering(&self, _: &dyn Tx, _: &mut Outbox, run_id: &str) -> Result<(), Error> {
        self.record(OutcomeCall::Delivering(run_id.to_owned()))
    }

    fn finished(&self, _: &dyn Tx, _: &mut Outbox, run_id: &str, outcome: Outcome) -> Result<(), Error> {
        self.record(OutcomeCall::Finished { run_id: run_id.to_owned(), outcome })
    }

    fn delivery_failed(&self, _: &dyn Tx, _: &mut Outbox, run_id: &str, reason: &str) -> Result<(), Error> {
        self.record(OutcomeCall::DeliveryFailed { run_id: run_id.to_owned(), reason: reason.to_owned() })
    }

    fn revise(&self, _: &dyn Tx, _: &mut Outbox, run_id: &str, _text: &str) -> Result<(), Error> {
        self.record(OutcomeCall::Revise(run_id.to_owned()))
    }
}
