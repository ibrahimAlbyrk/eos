//! The App reviewer (05 Q7): a read-only session surfaces asks a build run
//! for once an App it handed in passed Eos's scan. It works in a scratch
//! folder of its own, starts only while the run is at work, never leads
//! it, and answers through `app_review`. What became of the App reaches
//! the builder as a note.

use std::sync::Arc;

use eos_core::Error;
use eos_core::routine::AppReviewStart;
use eos_domain::routine::run::RunState;
use eos_domain::run_scope::{RunRole, Trust};

use super::spawn::{self, RunSession};
use super::workspace::Place;
use super::{Engine, note};

/// The definition the reviewer starts as; its tools key on it.
pub(crate) const APP_REVIEWER_DEFINITION: &str = "app-reviewer";

/// The run's routine, where it is and its trust, while it is at work.
async fn at_work(
    engine: &Engine,
    run_id: &str,
) -> Result<Option<(String, eos_domain::routine::run::Station, Trust)>, Error> {
    let id = run_id.to_owned();
    engine
        .store
        .read(move |tx| {
            let Some(run) = tx.runs().find(&id)?.filter(|run| run.state == RunState::Running) else { return Ok(None) };
            let Some(station) = run.station else { return Ok(None) };
            let version_id = run.version_id.clone().unwrap_or_default();
            let trust = tx.routine_versions().find(&run.routine_id, &version_id)?.map(|version| version.trust);
            let input: eos_contracts::RunInput =
                serde_json::from_str(&run.input).map_err(|_| Error::storage(format!("run {id} has no input")))?;
            Ok(Some((run.routine_id, station, eos_domain::routine::trust::of_run(trust, &input))))
        })
        .await
}

pub(crate) async fn start(engine: &Arc<Engine>, start: AppReviewStart) -> Result<Option<String>, Error> {
    let Some((routine_id, station, trust)) = at_work(engine, &start.run_id).await? else { return Ok(None) };
    let session = RunSession {
        run_id: start.run_id,
        routine_id,
        role: RunRole::AppReviewer,
        role_word: "app_reviewer",
        agent_key: None,
        definition: APP_REVIEWER_DEFINITION,
        name: start.name,
        model: start.model,
        effort: start.effort,
        trust,
        fence: Some(start.fence),
        place: Place::Scratch,
        parent_id: None,
        reads_outside: false,
        pack: None,
        at: (RunState::Running, station),
    };
    let brief = start.brief;
    spawn::start(engine, session, move |_| Ok(brief)).await
}

pub(crate) async fn tell(engine: &Engine, run_id: &str, worker_id: &str, text: &str) -> Result<(), Error> {
    note(engine, worker_id, run_id, text).await
}

/// The engine as the port surfaces reaches a build run's sessions through.
pub(crate) struct AppReviews(pub(crate) Arc<Engine>);

impl eos_core::routine::AppReviews for AppReviews {
    fn start_reviewer(&self, start: AppReviewStart) -> eos_core::BoxFuture<'_, Result<Option<String>, Error>> {
        Box::pin(self::start(&self.0, start))
    }

    fn tell<'a>(
        &'a self,
        run_id: &'a str,
        worker_id: &'a str,
        text: String,
    ) -> eos_core::BoxFuture<'a, Result<(), Error>> {
        Box::pin(async move { self::tell(&self.0, run_id, worker_id, &text).await })
    }
}
