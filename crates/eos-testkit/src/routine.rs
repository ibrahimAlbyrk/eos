//! What routines offer the other areas, answered from what the test sets.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use eos_contracts::Rung;
use eos_core::routine::{Confirmed, RoutineControl, RunLookup, RunRef};
use eos_core::store::{Outbox, Tx};
use eos_core::{BoxFuture, Error};

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// The runs the test gives, by worker. Records each worker it was asked
/// about.
#[derive(Debug, Default)]
pub struct FakeRunLookup {
    runs: HashMap<String, RunRef>,
    asked: Mutex<Vec<String>>,
}

impl FakeRunLookup {
    pub fn new() -> Self {
        Self::default()
    }

    /// `worker_id` works for `run`.
    pub fn with(mut self, worker_id: &str, run: RunRef) -> Self {
        self.runs.insert(worker_id.to_owned(), run);
        self
    }

    pub fn asked(&self) -> Vec<String> {
        locked(&self.asked).clone()
    }
}

impl RunLookup for FakeRunLookup {
    fn run_of<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, Option<RunRef>> {
        locked(&self.asked).push(worker_id.to_owned());
        Box::pin(std::future::ready(self.runs.get(worker_id).cloned()))
    }
}

/// One call [`FakeRoutineControl`] was given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlCall {
    Confirmed(String),
    Raise { routine_id: String, rung: Rung },
    StepDown { routine_id: String, reason: String },
    Pause { routine_id: String, reason: String },
    ResumePaused(String),
    UsingCapability(String),
}

/// Answers what the test gives: each routine's confirmed Freedom and Goes
/// to, and the routines that use each capability. Changes nothing; records
/// every call, in order.
#[derive(Debug, Default)]
pub struct FakeRoutineControl {
    confirmed: HashMap<String, Confirmed>,
    users: HashMap<String, Vec<String>>,
    calls: Mutex<Vec<ControlCall>>,
}

impl FakeRoutineControl {
    pub fn new() -> Self {
        Self::default()
    }

    /// What the user confirmed of `routine_id`; a routine without it is not
    /// found.
    pub fn confirming(mut self, routine_id: &str, confirmed: Confirmed) -> Self {
        self.confirmed.insert(routine_id.to_owned(), confirmed);
        self
    }

    /// The routines that use `capability_id`.
    pub fn using(mut self, capability_id: &str, routine_ids: &[&str]) -> Self {
        self.users.insert(capability_id.to_owned(), routine_ids.iter().map(|id| (*id).to_owned()).collect());
        self
    }

    pub fn calls(&self) -> Vec<ControlCall> {
        locked(&self.calls).clone()
    }

    fn answer(&self, routine_id: &str) -> Result<Confirmed, Error> {
        locked(&self.calls).push(ControlCall::Confirmed(routine_id.to_owned()));
        self.confirmed.get(routine_id).cloned().ok_or_else(|| Error::not_found("routine", routine_id))
    }

    fn done(&self, call: ControlCall) -> BoxFuture<'_, Result<(), Error>> {
        locked(&self.calls).push(call);
        Box::pin(std::future::ready(Ok(())))
    }
}

impl RoutineControl for FakeRoutineControl {
    fn confirmed<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<Confirmed, Error>> {
        Box::pin(std::future::ready(self.answer(routine_id)))
    }

    fn confirmed_in(&self, _tx: &dyn Tx, routine_id: &str) -> Result<Confirmed, Error> {
        self.answer(routine_id)
    }

    fn raise<'a>(&'a self, routine_id: &'a str, rung: Rung) -> BoxFuture<'a, Result<(), Error>> {
        self.done(ControlCall::Raise { routine_id: routine_id.to_owned(), rung })
    }

    fn step_down<'a>(&'a self, routine_id: &'a str, reason: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        self.done(ControlCall::StepDown { routine_id: routine_id.to_owned(), reason: reason.to_owned() })
    }

    fn pause<'a>(&'a self, routine_id: &'a str, reason: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        self.done(ControlCall::Pause { routine_id: routine_id.to_owned(), reason: reason.to_owned() })
    }

    fn pause_in(&self, _tx: &dyn Tx, _out: &mut Outbox, routine_id: &str, reason: &str) -> Result<(), Error> {
        locked(&self.calls).push(ControlCall::Pause { routine_id: routine_id.to_owned(), reason: reason.to_owned() });
        Ok(())
    }

    fn resume_paused<'a>(&'a self, reason: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        self.done(ControlCall::ResumePaused(reason.to_owned()))
    }

    fn using_capability<'a>(&'a self, capability_id: &'a str) -> BoxFuture<'a, Result<Vec<String>, Error>> {
        locked(&self.calls).push(ControlCall::UsingCapability(capability_id.to_owned()));
        Box::pin(std::future::ready(Ok(self.users.get(capability_id).cloned().unwrap_or_default())))
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use eos_contracts::Freedom;
    use eos_domain::run_scope::{RunRole, Trust};
    use serde_json::Map;

    use super::*;

    #[tokio::test]
    async fn a_worker_of_a_run_is_found_and_every_question_is_kept() {
        let run = RunRef {
            run_id: "rn-1".into(),
            routine_id: "rt-1".into(),
            version_id: "rv-1".into(),
            kind: "standing".into(),
            role: RunRole::Lead,
            agent_key: Some("editor".into()),
            trust: Trust::Untrusted,
            origin: "trigger".into(),
            started_at: 100,
            output_dir: PathBuf::from("/tmp/eos/routines/rt-1/runs/rn-1"),
        };
        let lookup = FakeRunLookup::new().with("w-lead", run.clone());
        assert_eq!(lookup.run_of("w-lead").await, Some(run));
        assert_eq!(lookup.run_of("w-chat").await, None);
        assert_eq!(lookup.asked(), ["w-lead", "w-chat"]);
    }

    #[tokio::test]
    async fn control_answers_as_given_and_records_each_call_in_order() {
        let confirmed =
            Confirmed { freedom: Freedom { rung: Rung::Draft, grants: vec![], extra: Map::new() }, goes_to: vec![] };
        let control =
            FakeRoutineControl::new().confirming("rt-1", confirmed.clone()).using("github", &["rt-1", "rt-2"]);
        assert_eq!(control.confirmed("rt-1").await, Ok(confirmed));
        assert_eq!(control.confirmed("rt-x").await, Err(Error::not_found("routine", "rt-x")));
        control.raise("rt-1", Rung::SendThenTell).await.expect("raised");
        control.step_down("rt-1", "undone").await.expect("stepped down");
        control.pause("rt-2", "capability").await.expect("paused");
        control.resume_paused("capability").await.expect("resumed");
        assert_eq!(control.using_capability("github").await, Ok(vec!["rt-1".to_owned(), "rt-2".to_owned()]));
        assert_eq!(control.using_capability("mail").await, Ok(vec![]));
        assert_eq!(
            control.calls(),
            [
                ControlCall::Confirmed("rt-1".into()),
                ControlCall::Confirmed("rt-x".into()),
                ControlCall::Raise { routine_id: "rt-1".into(), rung: Rung::SendThenTell },
                ControlCall::StepDown { routine_id: "rt-1".into(), reason: "undone".into() },
                ControlCall::Pause { routine_id: "rt-2".into(), reason: "capability".into() },
                ControlCall::ResumePaused("capability".into()),
                ControlCall::UsingCapability("github".into()),
                ControlCall::UsingCapability("mail".into()),
            ]
        );
    }
}
