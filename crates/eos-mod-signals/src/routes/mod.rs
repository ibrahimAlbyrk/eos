//! The signal routes (02 §6): when each routine runs next and what starts
//! one routine's runs (`status`), the signal list, replay (`replay`) and
//! the two previews (`preview`), and the keep-awake setting (`settings`). Every one needs the user; the phone reads
//! at `Read` and replays at `High`, and never tries a Which.

mod preview;
mod replay;
mod settings;
mod status;
mod summary;

use std::sync::Arc;

use eos_contracts::{ItemRef, SignalDecision, SignalRow};
use eos_core::os::{TimeZone, ZoneRules};
use eos_core::routine::{RoutineDirectory, RoutineTriggers, RunIntake};
use eos_core::signals::Runner;
use eos_core::store::{Store, StoredSignal, StoredSignalRoute, Tx, UserSettingsStore};
use eos_core::{Clock, Error};
use eos_domain::signals::decision::Decision;
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use tokio::sync::Notify;

/// Signals one page of the list holds unless asked for fewer…
const PAGE_DEFAULT: i64 = 50;
/// …and at most.
const PAGE_MAX: i64 = 200;

/// What the routes read and write through.
pub(crate) struct Routes {
    pub(crate) store: Arc<dyn Store>,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) zones: Arc<dyn ZoneRules>,
    pub(crate) zone: Arc<dyn TimeZone>,
    pub(crate) runner: Arc<dyn Runner>,
    pub(crate) intake: Arc<dyn RunIntake>,
    pub(crate) directory: Arc<dyn RoutineDirectory>,
    pub(crate) settings: Arc<dyn UserSettingsStore>,
    /// Starts a scheduler pass, which counts the work holds again.
    pub(crate) kick: Arc<Notify>,
}

impl Routes {
    /// The routine's triggers, or 404.
    async fn routine(&self, routine_id: &str) -> Result<RoutineTriggers, Error> {
        let routines = self.directory.triggers().await?;
        routines
            .into_iter()
            .find(|routine| routine.id == routine_id)
            .ok_or_else(|| Error::not_found("routine", routine_id))
    }
}

pub(crate) fn all(routes: Routes) -> Vec<RouteDef> {
    let routes = Arc::new(routes);
    vec![
        status::every(&routes),
        status::route(&routes),
        list(&routes),
        replay::route(&routes),
        preview::schedule(&routes),
        preview::which(&routes),
        settings::read(&routes),
        settings::route(&routes),
        summary::route(&routes),
    ]
}

/// `GET /api/signals?routine=&decision=&before=&limit=`: signals newest
/// first, each with its decisions.
fn list(routes: &Arc<Routes>) -> RouteDef {
    let routes = routes.clone();
    RouteDef::get("/api/signals", move |req: Request| {
        let routes = routes.clone();
        async move {
            let query = req.query();
            let routine = query.get("routine").map(|id| id.into_owned());
            let decision = match query.get("decision") {
                Some(word) => Some(
                    Decision::parse(&word)
                        .ok_or_else(|| ApiError::Validation(format!("invalid request: decision: {word}")))?,
                ),
                None => None,
            };
            let number = |name: &str| -> Result<Option<i64>, ApiError> {
                query
                    .get(name)
                    .map(|text| {
                        text.parse::<i64>().map_err(|_| ApiError::Validation(format!("invalid request: {name}")))
                    })
                    .transpose()
            };
            let before = number("before")?;
            let limit = number("limit")?.unwrap_or(PAGE_DEFAULT).clamp(1, PAGE_MAX);
            let rows = routes
                .store
                .read(move |tx| {
                    let signals = tx.signals().page(routine.as_deref(), decision, before, limit)?;
                    let mut rows = Vec::with_capacity(signals.len());
                    for signal in signals {
                        rows.extend(row(tx, signal)?);
                    }
                    Ok(rows)
                })
                .await?;
            Ok(Response::json(200, &rows))
        }
    })
    .access(Access::ui_token().phone_user(Tier::Read))
}

/// A signal as the list shows it; `None` for one whose item this version
/// cannot read.
fn row(tx: &dyn Tx, signal: StoredSignal) -> Result<Option<SignalRow>, Error> {
    let Ok(item) = serde_json::from_str::<ItemRef>(&signal.signal.item_json) else {
        tracing::warn!(signal_id = signal.id, "a signal's item could not be read");
        return Ok(None);
    };
    let decisions = tx.signal_routes().by_signal(signal.id)?.iter().map(decision).collect();
    let signal_row = signal.signal;
    Ok(Some(SignalRow {
        id: signal.id,
        source_id: signal_row.source_id,
        kind: signal_row.kind,
        subject: signal_row.subject,
        version: signal_row.version,
        occurred_at: signal_row.occurred_at,
        received_at: signal_row.received_at,
        state: if signal.routed { "routed" } else { "received" }.to_owned(),
        item,
        decisions,
    }))
}

fn decision(route: &StoredSignalRoute) -> SignalDecision {
    SignalDecision {
        routine_id: route.routine_id.clone(),
        routine_version: route.routine_version.clone(),
        decision: route.decision.as_str().to_owned(),
        reason: route.reason.clone(),
        run_id: route.run_id.clone(),
        model_asked: route.model_asked,
        decided_at: route.decided_at,
    }
}
