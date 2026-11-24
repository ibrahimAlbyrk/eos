//! Memory as routines see it: a pack given by the test, and every outcome,
//! failed check and removed routine recorded.

use std::sync::Mutex;

use eos_core::experience::{
    CheckVerdict, ExperienceFeedback, ExperiencePacks, RunOutcome, RunPack, RunPackRequest, SurfaceSignal,
};
use eos_core::{BoxFuture, Error};

fn locked<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Answers every request with the pack the test set (empty until then).
#[derive(Debug, Default)]
pub struct FakeExperiencePacks {
    pack: Mutex<RunPack>,
    requests: Mutex<Vec<RunPackRequest>>,
}

impl FakeExperiencePacks {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn answering(self, pack: RunPack) -> Self {
        *locked(&self.pack) = pack;
        self
    }

    /// Answers `pack` from now on.
    pub fn set(&self, pack: RunPack) {
        *locked(&self.pack) = pack;
    }

    pub fn requests(&self) -> Vec<RunPackRequest> {
        locked(&self.requests).clone()
    }
}

impl ExperiencePacks for FakeExperiencePacks {
    fn for_run(&self, request: RunPackRequest) -> BoxFuture<'_, Result<RunPack, Error>> {
        locked(&self.requests).push(request);
        let pack = locked(&self.pack).clone();
        Box::pin(std::future::ready(Ok(pack)))
    }
}

/// What routines told memory, in order.
#[derive(Debug, Clone, PartialEq)]
pub enum FeedbackCall {
    RunEnded(RunOutcome),
    CheckFailed(CheckVerdict),
    Surface(SurfaceSignal),
    RoutineRemoved(String),
}

#[derive(Debug, Default)]
pub struct FakeExperienceFeedback {
    calls: Mutex<Vec<FeedbackCall>>,
}

impl FakeExperienceFeedback {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn calls(&self) -> Vec<FeedbackCall> {
        locked(&self.calls).clone()
    }

    fn record(&self, call: FeedbackCall) -> BoxFuture<'_, Result<(), Error>> {
        locked(&self.calls).push(call);
        Box::pin(std::future::ready(Ok(())))
    }
}

impl ExperienceFeedback for FakeExperienceFeedback {
    fn run_ended(&self, outcome: RunOutcome) -> BoxFuture<'_, Result<(), Error>> {
        self.record(FeedbackCall::RunEnded(outcome))
    }

    fn check_failed(&self, verdict: CheckVerdict) -> BoxFuture<'_, Result<(), Error>> {
        self.record(FeedbackCall::CheckFailed(verdict))
    }

    fn surface_signal(&self, signal: SurfaceSignal) -> BoxFuture<'_, Result<(), Error>> {
        self.record(FeedbackCall::Surface(signal))
    }

    fn routine_removed<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        self.record(FeedbackCall::RoutineRemoved(routine_id.to_owned()))
    }
}
