//! A need asked of the Forge (`request_capability`, `POST /api/forge`), and
//! the reports its sessions hand in (`forge_report`).

use std::sync::{Arc, OnceLock};

use eos_contracts::{ForgeBuild, ForgeResearch, ForgeReview, Issues, ResultMode, RunInput, Validate};
use eos_core::capability::CapabilityCalls;
use eos_core::forge::{Forge, ForgeAnswer, ForgeCaller, ForgeRequest, ForgeStage};
use eos_core::routine::{NewRun, RunOrigin, RunStarter, StartError};
use eos_core::store::Store;
use eos_core::surface::AppHandOff;
use eos_core::{BoxFuture, Clock, Error};
use eos_domain::capability::health::HealthState;
use eos_domain::run_scope::RunRole;
use serde_json::Value;

use crate::package::{newest, read};
use crate::steps::ForgeSteps;

/// The run event a stage's report is kept as: `forge_research`, …
pub fn report_event(stage: ForgeStage) -> String {
    format!("forge_{}", stage.as_str())
}

pub(crate) struct ForgeService {
    pub(crate) store: Arc<dyn Store>,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) runs: Arc<dyn RunStarter>,
    pub(crate) capabilities: Arc<dyn CapabilityCalls>,
    /// The `forge` routine's id, once it is kept.
    pub(crate) routine: OnceLock<String>,
    /// Reads the package a review passed.
    pub(crate) steps: Arc<ForgeSteps>,
    /// The App the user promotes to an Extension.
    pub(crate) apps: Arc<dyn AppHandOff>,
}

impl ForgeService {
    fn routine(&self) -> Result<&str, Error> {
        self.routine.get().map(String::as_str).ok_or_else(|| Error::Conflict("the Forge is not ready yet".into()))
    }

    pub(crate) async fn request(&self, request: ForgeRequest) -> Result<ForgeAnswer, Error> {
        let need = request.need.trim().to_owned();
        if need.is_empty() || need.len() > eos_contracts::FORGE_NEED_MAX {
            return Err(Error::Validation(format!("need: one to {} characters", eos_contracts::FORGE_NEED_MAX)));
        }
        // A Forge run builds and runs code in its folder: it starts only from
        // words of the user or of the agent itself, never from outside text.
        if eos_domain::untrusted::holds_wrapped(&need) {
            return Err(Error::Validation("need: say it in your own words, not with outside text".into()));
        }
        let mut repair = request.capability_id.clone();
        if let ForgeCaller::Agent { worker_id } = &request.caller
            && repair.is_none()
        {
            let known = self.capabilities.describe(worker_id, None).await?;
            let named = |id: &str, name: &str| need.eq_ignore_ascii_case(id) || need.eq_ignore_ascii_case(name);
            if let Some(found) = known.into_iter().find(|c| named(&c.id, &c.name)) {
                match found.state {
                    HealthState::Ready | HealthState::Degraded => {
                        return Ok(ForgeAnswer::Ready { capability_id: found.id });
                    }
                    HealthState::Broken => repair = Some(found.id),
                    _ => {
                        let step = found.setup.unwrap_or_else(|| "Open it in Eos › Capabilities.".into());
                        return Ok(ForgeAnswer::Setup { capability_id: found.id, step });
                    }
                }
            }
        }
        let app = match &request.from_surface {
            Some(surface_id) => Some(self.apps.promoted(surface_id).await?),
            None => None,
        };
        let note = match &app {
            Some(app) => format!(
                "{need}\n\nThe App to make an Extension of is «{}»: {}. Its code and manifest are in `{}/` of the \
                 build folder; the Extension does what it does, through a capability.",
                app.title,
                app.summary,
                crate::steps::PROMOTED_APP_FOLDER
            ),
            None => need,
        };
        let options = [("routine", &request.routine_id), ("capability", &repair), ("surface", &request.from_surface)];
        let input = RunInput {
            item: None,
            items: None,
            trigger: None,
            options: options
                .into_iter()
                .filter_map(|(key, value)| value.clone().map(|value| (key.to_owned(), Value::String(value))))
                .collect(),
            note: Some(note),
            result: ResultMode::Usual,
            at: None,
            surface: None,
            chat: None,
        };
        let origin = match request.caller {
            ForgeCaller::User => RunOrigin::Hand,
            ForgeCaller::Agent { worker_id } => RunOrigin::Agent { worker_id },
        };
        let new = NewRun {
            routine_id: self.routine()?.to_owned(),
            version: None,
            input,
            items: Vec::new(),
            origin,
            door: None,
            confirm_repeat: false,
            client_request_id: None,
        };
        let made = self.runs.start(new).await.map_err(refused)?;
        let run_id =
            made.into_iter().next().map(|run| run.id).ok_or_else(|| Error::storage("no Forge run was made"))?;
        if let Some(app) = &app {
            self.steps.hand_in_app(&run_id, app).await?;
        }
        tracing::info!(run_id, "a Forge run was asked for");
        Ok(ForgeAnswer::Started { run_id })
    }

    async fn report(&self, worker_id: &str, stage: ForgeStage, mut report: Value) -> Result<(), Error> {
        check(stage, &report)?;
        let routine = self.routine()?.to_owned();
        if stage == ForgeStage::Review && report["verdict"] == "pass" {
            report["hash"] = self.reviewed_hash(worker_id).await?.into();
        }
        let (id, now, data) = (worker_id.to_owned(), self.clock.now_ms(), report.to_string());
        self.store
            .write(move |tx, _| {
                let run = tx.routine_sessions().run_of(&id)?.filter(|run| run.routine_id == routine);
                let Some(run) = run else { return Err(Error::Conflict("this session works for no Forge run".into())) };
                let definition = tx.workers().find(&id)?.and_then(|worker| worker.worker_definition);
                let role = definition.as_deref().and_then(RunRole::of_forge_definition).map(|(_, role)| role);
                if role != Some(role_of(stage)) {
                    return Err(Error::Validation(format!("stage: this session does not report {}", stage.as_str())));
                }
                tx.runs().append_event(&run.run_id, now, &report_event(stage), Some(&data))?;
                tracing::info!(run_id = %run.run_id, stage = stage.as_str(), "a Forge report was kept");
                Ok(())
            })
            .await
    }
}

impl ForgeService {
    /// The hash of the package the reviewer passed, as its files are now:
    /// only those files are proposed.
    async fn reviewed_hash(&self, worker_id: &str) -> Result<String, Error> {
        let id = worker_id.to_owned();
        let run = self.store.read(move |tx| tx.routine_sessions().run_of(&id)).await?;
        let run = run.ok_or_else(|| Error::Conflict("this session works for no Forge run".into()))?;
        let build = newest::<ForgeBuild>(self.store.as_ref(), &run.run_id, &report_event(ForgeStage::Build)).await?;
        let build = build.ok_or_else(|| Error::Validation("report: the builder has reported no package yet".into()))?;
        match read(&self.steps, &run.run_id, &build).await? {
            Ok(built) => Ok(built.hash),
            Err(why) => Err(Error::Validation(format!("report: the package cannot be read: {why}"))),
        }
    }
}

fn role_of(stage: ForgeStage) -> RunRole {
    match stage {
        ForgeStage::Research => RunRole::ForgeResearcher,
        ForgeStage::Build => RunRole::ForgeBuilder,
        ForgeStage::Review => RunRole::ForgeReviewer,
    }
}

/// The report has its stage's shape.
fn check(stage: ForgeStage, report: &Value) -> Result<(), Error> {
    fn shaped<T: serde::de::DeserializeOwned + Validate>(report: &Value) -> Result<(), Error> {
        let typed: T = serde_json::from_value(report.clone()).map_err(|e| Error::Validation(format!("report: {e}")))?;
        let mut issues = Issues::default();
        typed.validate(&mut issues);
        match issues.into_vec().into_iter().next() {
            Some(issue) => Err(Error::Validation(format!("report: {issue}"))),
            None => Ok(()),
        }
    }
    match stage {
        ForgeStage::Research => shaped::<ForgeResearch>(report),
        ForgeStage::Build => shaped::<ForgeBuild>(report),
        ForgeStage::Review => shaped::<ForgeReview>(report),
    }
}

fn refused(refused: StartError) -> Error {
    match refused {
        StartError::Store(error) => error,
        StartError::UnknownRoutine(id) => Error::not_found("routine", id),
        StartError::Invalid(text) => Error::Validation(text),
        StartError::DayCap => Error::Conflict("Routines spent today's budget".into()),
        StartError::Halted => Error::Conflict("Everything is stopped on this Mac".into()),
        StartError::Unready(unready) => Error::Conflict(unready.message()),
        StartError::SameItem { .. } | StartError::RoutineState(_) | StartError::NewerFormat => {
            Error::Conflict("The Forge is not taking runs now".into())
        }
    }
}

/// The port the tools and the routes ask.
pub(crate) struct Port(pub(crate) Arc<ForgeService>);

impl Forge for Port {
    fn request(&self, request: ForgeRequest) -> BoxFuture<'_, Result<ForgeAnswer, Error>> {
        Box::pin(self.0.request(request))
    }

    fn report<'a>(&'a self, worker_id: &'a str, stage: ForgeStage, report: Value) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(self.0.report(worker_id, stage, report))
    }
}
