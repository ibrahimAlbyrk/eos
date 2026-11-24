//! What the tools of a run's lead do ([`RoutineTools`]). The caller is
//! known by its worker id: only a run's lead, while its run is at work, is
//! heard. A project's lead hands in each milestone instead of one result
//! (`project`). A result is copied, files and all, before the run moves on, so
//! what is checked is what the lead handed in, whatever it does next.

use std::sync::Arc;

use eos_contracts::CheckVerdict;
use eos_contracts::Milestone;
use eos_core::routine::{MilestoneDone, RoutineTools, RunRef, Specialist, SubmittedResult};
use eos_core::store::{RunMove, StoredRunResult};
use eos_core::{BoxFuture, Error};
use eos_domain::routine::run::{Reason, RunState, Station};
use eos_domain::run_scope::RunRole;
use serde_json::json;

use super::{Engine, check, fail, move_run, project, shape, team};

/// The largest result body kept, in bytes of its JSON.
pub(crate) const RESULT_BODY_MAX_BYTES: usize = 512 * 1024;

pub(crate) struct Tools(pub(crate) Arc<Engine>);

impl Tools {
    /// The run `worker_id` leads, while it is at work.
    async fn working_run(&self, worker_id: &str) -> Result<RunRef, Error> {
        let id = worker_id.to_owned();
        let found = self
            .0
            .store
            .read(move |tx| {
                let Some(run_ref) = tx.routine_sessions().run_of(&id)? else { return Ok(None) };
                let run = tx.runs().find(&run_ref.run_id)?;
                Ok(Some((run_ref, run)))
            })
            .await?;
        let Some((run_ref, run)) = found else {
            return Err(Error::Conflict("this session works for no run".into()));
        };
        if !matches!(run_ref.role, RunRole::Solo | RunRole::Lead | RunRole::Script) {
            return Err(Error::Conflict("only the run's lead hands in its result".into()));
        }
        let at_work = run.is_some_and(|run| run.state == RunState::Running && run.station == Some(Station::Work));
        if !at_work {
            return Err(Error::Conflict("the run is not at work".into()));
        }
        Ok(run_ref)
    }

    async fn hand_in(&self, worker_id: &str, run: RunRef, result: SubmittedResult) -> Result<(), Error> {
        hand_in(&self.0, Some(worker_id), &run.run_id, &run.routine_id, result).await
    }
    /// What a project run makes and the milestone it works on; none for a
    /// run that is no project's.
    async fn milestone(&self, run_id: &str) -> Result<Option<(String, Milestone)>, Error> {
        let id = run_id.to_owned();
        self.0
            .store
            .read(move |tx| {
                let Some(run) = tx.runs().find(&id)? else { return Ok(None) };
                let Some(blueprint) = project::blueprint_in(tx, &run)? else { return Ok(None) };
                let milestone = project::current(&blueprint, &run).cloned();
                Ok(milestone.map(|milestone| (blueprint.makes.kind.clone(), milestone)))
            })
            .await
    }
}

impl RoutineTools for Tools {
    fn report_progress<'a>(
        &'a self,
        worker_id: &'a str,
        line: &'a str,
        _milestone: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(async move {
            let run = self.working_run(worker_id).await?;
            Engine::locked(&self.0.progress).insert(run.run_id, line.to_owned());
            Ok(())
        })
    }

    fn submit_result<'a>(&'a self, worker_id: &'a str, result: SubmittedResult) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(async move {
            let run = self.working_run(worker_id).await?;
            if self.milestone(&run.run_id).await?.is_some() {
                return Err(Error::Validation(
                    "This is a project run: hand in the milestone you work on with complete_milestone.".into(),
                ));
            }
            self.hand_in(worker_id, run, result).await
        })
    }

    fn complete_milestone<'a>(&'a self, worker_id: &'a str, done: MilestoneDone) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(async move {
            let run = self.working_run(worker_id).await?;
            let Some((makes, milestone)) = self.milestone(&run.run_id).await? else {
                return Err(Error::Validation(
                    "This run is no project's: hand in its result with submit_result.".into(),
                ));
            };
            if milestone.system.is_some() {
                return Err(Error::Validation(
                    "Eos runs this milestone itself: wait until it tells you how it went.".into(),
                ));
            }
            if milestone.key != done.key {
                return Err(Error::Validation(format!(
                    "key: the milestone at work is `{}` ({}); hand that one in first.",
                    milestone.key, milestone.title
                )));
            }
            let result = SubmittedResult {
                kind: makes,
                headline: milestone.title,
                body: done.summary.into(),
                files: done.files,
            };
            self.hand_in(worker_id, run, result).await
        })
    }

    fn report_failure<'a>(&'a self, worker_id: &'a str, reason: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(async move {
            let run = self.working_run(worker_id).await?;
            fail(&self.0, &run.run_id, Reason::Reported, Some(reason.to_owned())).await
        })
    }

    fn submit_verdict<'a>(&'a self, worker_id: &'a str, verdict: CheckVerdict) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(async move {
            let Some((run_id, attempt)) = check::current_checker(&self.0, worker_id).await? else {
                return Err(Error::Conflict("this session checks no result now".into()));
            };
            check::judged(&self.0, &run_id, attempt, verdict).await
        })
    }

    fn start_specialist<'a>(
        &'a self,
        worker_id: &'a str,
        agent: &'a str,
        task: &'a str,
    ) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(team::start(&self.0, worker_id, agent, task))
    }

    fn message_specialist<'a>(
        &'a self,
        worker_id: &'a str,
        agent: &'a str,
        text: &'a str,
    ) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(team::message(&self.0, worker_id, agent, text))
    }

    fn stop_specialist<'a>(&'a self, worker_id: &'a str, agent: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(team::stop(&self.0, worker_id, agent))
    }

    fn list_specialists<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, Result<Vec<Specialist>, Error>> {
        Box::pin(team::list(&self.0, worker_id))
    }
}

/// Keeps a copy of the result handed in for `run_id` (by its lead, or by a
/// system step without one), then moves the run to its check.
pub(crate) async fn hand_in(
    engine: &Arc<Engine>,
    lead: Option<&str>,
    run_id: &str,
    routine_id: &str,
    result: SubmittedResult,
) -> Result<(), Error> {
    let body = result.body.to_string();
    if body.len() > RESULT_BODY_MAX_BYTES {
        return Err(Error::Validation(format!("body: at most {RESULT_BODY_MAX_BYTES} bytes")));
    }
    shape::refuse_misfit(engine, run_id, &result.kind, &result.body).await?;
    let kept = engine.folders.keep_files(routine_id, run_id, &result.files).await?;
    let files: Vec<_> = kept.iter().map(|file| json!({"name": file.name, "bytes": file.bytes})).collect();
    let (id, now) = (run_id.to_owned(), engine.clock.now_ms());
    let (kind, headline) = (result.kind, result.headline);
    let size = body.len();
    engine
        .store
        .write(move |tx, out| {
            let run = tx.runs().find(&id)?.ok_or_else(|| Error::not_found("run", id.clone()))?;
            if (run.state, run.station) != (RunState::Running, Some(Station::Work)) {
                return Err(Error::Conflict("the run is not at work".into()));
            }
            tx.run_results().insert(&StoredRunResult {
                run_id: id.clone(),
                attempt: run.attempt,
                kind,
                headline: headline.clone(),
                body,
                files: (!files.is_empty()).then(|| json!(files).to_string()),
                verdict: None,
                created_at: now,
            })?;
            tx.runs().set_headline(&id, &headline)?;
            let check = RunMove { state: RunState::Checking, station: Some(Station::Check), reason: None, at: now };
            move_run(tx, out, &run, check).map(drop)
        })
        .await?;
    Engine::locked(&engine.progress).remove(run_id);
    if let Some(lead) = lead {
        // Held until the check lets it go: what the user says meanwhile waits.
        Engine::locked(&engine.held).insert(lead.to_owned());
    }
    check::begin(engine, run_id);
    tracing::info!(run_id, worker_id = ?lead, bytes = size, files = kept.len(), "a run's result was handed in");
    Ok(())
}
