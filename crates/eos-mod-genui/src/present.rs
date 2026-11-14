//! The one write path for visual answers: the user's switches, the full check,
//! a fresh view id, the stored record. A rejection carries every problem with
//! its path, so the model fixes them all in one more call.

use std::sync::Arc;

use eos_contracts::{FOCUSED_ROLE, GenuiLevel, Num, ViewId, ViewRecord, ViewRecordApp, ViewRecordView};
use eos_core::genui::{PresentRefusal, PresentedApp, PresentedView, VisualAnswers};
use eos_core::store::{Store, agent_caller};
use eos_core::{BoxFuture, Clock, Error, Ids};
use eos_genui::catalog::PRESENT_KEYS;
use eos_genui::spec::GENUI_OFF_TEXT;
use eos_genui::{AppValidation, Object, ViewProblem, ViewValidation, validate_app, validate_view};
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::settings::Switches;

const APPS_OFF_TEXT: &str = "Apps are turned off in Settings — use present or plain text";

const APP_KEYS: &[&str] = &["title", "html", "summary", "height"];
/// A collision in 62^12 is a bug elsewhere, not bad luck: give up instead of spinning.
const MAX_ID_TRIES: usize = 4;

#[derive(Clone)]
pub(crate) struct Presenter {
    pub(crate) store: Arc<dyn Store>,
    pub(crate) switches: Switches,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) ids: Arc<dyn Ids>,
}

/// The tool's input as the checks read it: object keys in JavaScript's order.
fn read(input: &Value) -> eos_genui::Value {
    eos_genui::Value::deserialize(input).unwrap_or(eos_genui::Value::Null)
}

/// Only the tool's own fields are stored: the check already warned about the rest.
fn pick(input: &Object, keys: &[&str]) -> Map<String, Value> {
    let mut spec = Map::new();
    for key in keys {
        if let Some(Ok(value)) = input.get(key).map(serde_json::to_value) {
            spec.insert((*key).to_owned(), value);
        }
    }
    spec
}

fn title_of(spec: &Map<String, Value>) -> String {
    spec.get("title").and_then(Value::as_str).unwrap_or_default().to_owned()
}

impl Presenter {
    /// Who may present: an orchestrator or a focused session, never a spawned
    /// worker (it reports to its orchestrator, which presents). `agent` is
    /// what the caller declared itself to be; `None` when it may not.
    pub(crate) async fn presenter_of(&self, agent: Option<String>) -> Result<Option<String>, Error> {
        self.store
            .read(move |tx| {
                let workers = tx.workers();
                let Some(caller) = agent_caller(workers, agent.as_deref())? else { return Ok(None) };
                let worker = workers.find(&caller.id)?;
                Ok(worker.filter(|w| w.is_orchestrator || w.agent_role.as_deref() == Some(FOCUSED_ROLE)).map(|w| w.id))
            })
            .await
    }

    /// Saves `record` under an id no view has, made by `record_for`.
    async fn save(
        &self,
        worker_id: &str,
        replaces: Option<String>,
        record_for: impl FnOnce(ViewId, Num) -> ViewRecord + Send + 'static,
    ) -> Result<(String, Option<ViewProblem>), Error> {
        let (ids, now, worker_id) = (self.ids.clone(), self.clock.now_ms(), worker_id.to_owned());
        self.store
            .write(move |tx, _out| {
                let views = tx.genui_views();
                let mut warning = None;
                if let Some(replaces) = replaces {
                    let own = views.get(&replaces)?.is_some_and(|earlier| match &earlier {
                        ViewRecord::View(v) => v.worker_id == worker_id,
                        ViewRecord::App(v) => v.worker_id == worker_id,
                    });
                    if !own {
                        let message = format!("{replaces} is not one of your views — shown as a new view");
                        warning = Some(ViewProblem { path: "replaces".to_owned(), message });
                    }
                }
                for _ in 0..MAX_ID_TRIES {
                    let id = ids.view_id();
                    if views.get(&id)?.is_none() {
                        #[allow(clippy::cast_precision_loss)]
                        views.save(&record_for(ViewId(id.clone()), Num(now as f64)))?;
                        return Ok((id, warning));
                    }
                }
                Err(Error::Storage("could not mint a fresh view id".into()))
            })
            .await
    }

    pub(crate) async fn view(&self, worker_id: &str, input: &Value) -> Result<PresentedView, PresentRefusal> {
        if self.switches.read().level == GenuiLevel::Text {
            return Err(PresentRefusal::SwitchedOff(GENUI_OFF_TEXT));
        }
        let input = read(input);
        let (mut warnings, stats) = match validate_view(&input) {
            ViewValidation::Ok { warnings, stats } => (warnings, stats),
            ViewValidation::Rejected { problems, .. } => return Err(PresentRefusal::Rejected(problems)),
        };
        // Accepted, so it is an object.
        let spec = input.as_object().map(|input| pick(input, PRESENT_KEYS)).unwrap_or_default();
        let replaces = spec.get("replaces").and_then(Value::as_str).filter(|id| !id.is_empty()).map(str::to_owned);
        let (title, owner) = (title_of(&spec), worker_id.to_owned());
        let (view_id, warning) = self
            .save(worker_id, replaces, move |id, created_at| {
                ViewRecord::View(ViewRecordView { id, worker_id: owner, title, created_at, spec: Value::Object(spec) })
            })
            .await?;
        warnings.extend(warning);
        Ok(PresentedView { view_id, warnings, stats })
    }

    pub(crate) async fn app(&self, worker_id: &str, input: &Value) -> Result<PresentedApp, PresentRefusal> {
        let switches = self.switches.read();
        if switches.level == GenuiLevel::Text {
            return Err(PresentRefusal::SwitchedOff(GENUI_OFF_TEXT));
        }
        if !switches.apps {
            return Err(PresentRefusal::SwitchedOff(APPS_OFF_TEXT));
        }
        let input = read(input);
        let warnings = match validate_app(&input) {
            AppValidation::Ok { warnings, .. } => warnings,
            AppValidation::Rejected { problems, .. } => return Err(PresentRefusal::Rejected(problems)),
        };
        let spec = input.as_object().map(|input| pick(input, APP_KEYS)).unwrap_or_default();
        let (title, owner) = (title_of(&spec), worker_id.to_owned());
        let (view_id, _) = self
            .save(worker_id, None, move |id, created_at| {
                ViewRecord::App(ViewRecordApp { id, worker_id: owner, title, created_at, spec: Value::Object(spec) })
            })
            .await?;
        Ok(PresentedApp { view_id, warnings })
    }
}

impl VisualAnswers for Presenter {
    fn present_view<'a>(
        &'a self,
        worker_id: &'a str,
        input: Value,
    ) -> BoxFuture<'a, Result<PresentedView, PresentRefusal>> {
        Box::pin(async move {
            let presenter = self.presenter_of(Some(worker_id.to_owned())).await?;
            let presenter = presenter.ok_or(PresentRefusal::NotPresenter)?;
            self.view(&presenter, &input).await
        })
    }

    fn present_app<'a>(
        &'a self,
        worker_id: &'a str,
        input: Value,
    ) -> BoxFuture<'a, Result<PresentedApp, PresentRefusal>> {
        Box::pin(async move {
            let presenter = self.presenter_of(Some(worker_id.to_owned())).await?;
            let presenter = presenter.ok_or(PresentRefusal::NotPresenter)?;
            self.app(&presenter, &input).await
        })
    }
}
