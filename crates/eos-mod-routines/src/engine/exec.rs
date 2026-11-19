//! What the tools of a run's lead do ([`RoutineTools`]). The caller is
//! known by its worker id: only a run's lead, while its run is at work, is
//! heard. A result is copied, files and all, before the run moves on, so
//! what is checked is what the lead handed in, whatever it does next.

use std::sync::Arc;

use eos_contracts::CheckVerdict;
use eos_core::routine::{RoutineTools, RunRef, Specialist, SubmittedResult};
use eos_core::store::{RunMove, StoredRunResult};
use eos_core::{BoxFuture, Error};
use eos_domain::routine::run::{Reason, RunState, Station};
use eos_domain::run_scope::RunRole;
use serde_json::json;

use super::{Engine, check, fail, move_run, team};

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
            let engine = &self.0;
            let run = self.working_run(worker_id).await?;
            let body = result.body.to_string();
            if body.len() > RESULT_BODY_MAX_BYTES {
                return Err(Error::Validation(format!("body: at most {RESULT_BODY_MAX_BYTES} bytes")));
            }
            let kept = engine.folders.keep_files(&run.routine_id, &run.run_id, &result.files).await?;
            let files: Vec<_> = kept.iter().map(|file| json!({"name": file.name, "bytes": file.bytes})).collect();
            let (id, now) = (run.run_id.clone(), engine.clock.now_ms());
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
                    let check =
                        RunMove { state: RunState::Checking, station: Some(Station::Check), reason: None, at: now };
                    move_run(tx, out, &run, check).map(drop)
                })
                .await?;
            Engine::locked(&engine.progress).remove(&run.run_id);
            // Held until the check lets it go: what the user says meanwhile waits.
            Engine::locked(&engine.held).insert(worker_id.to_owned());
            check::begin(engine, &run.run_id);
            tracing::info!(run_id = %run.run_id, worker_id, bytes = size, files = kept.len(), "a run's result was handed in");
            Ok(())
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
