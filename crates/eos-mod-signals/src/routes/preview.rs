//! The editor's two previews: a schedule's next times, and a Which tried on
//! recent signals by its rules only. Neither writes or asks the model.

use std::collections::BTreeMap;
use std::sync::Arc;

use eos_contracts::{
    Facts, Issues, RuleMisses, SchedulePreviewRequest, SchedulePreviewResponse, ValidationError, WhichPreviewRequest,
    WhichPreviewResponse,
};
use eos_domain::signals::schedule;
use eos_domain::signals::which::{self, Verdict, evaluate};
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;

use super::Routes;
use super::status::next_at;

fn refused(cx: Issues) -> Result<(), ApiError> {
    if cx.is_empty() { Ok(()) } else { Err(ValidationError { issues: cx.into_vec() }.into()) }
}

/// `POST /api/signals/schedule/preview {schedule, count}`: the next `count`
/// slots after now, soonest first.
pub(super) fn schedule(routes: &Arc<Routes>) -> RouteDef {
    let routes = routes.clone();
    RouteDef::post("/api/signals/schedule/preview", move |req: Request| {
        let routes = routes.clone();
        async move {
            let asked: SchedulePreviewRequest = req.parse()?;
            let mut cx = Issues::default();
            let known = |zone: &str| routes.zones.known(zone);
            cx.at("schedule", |cx| schedule::validate(&asked.schedule, &known, cx));
            refused(cx)?;
            let mut next = Vec::new();
            let mut after = routes.clock.now_ms();
            while (next.len() as i64) < asked.count {
                let Some(slot) = next_at(routes.zones.as_ref(), &asked.schedule, after) else { break };
                next.push(slot);
                after = slot;
            }
            Ok(Response::json(200, &SchedulePreviewResponse { next }))
        }
    })
    .access(Access::ui_token().phone_user(Tier::Read))
}

/// `POST /api/signals/which/preview {routineId?, which, limit}`: which of
/// the latest `limit` signals (the routine's, or anyone's) its rules take.
pub(super) fn which(routes: &Arc<Routes>) -> RouteDef {
    let routes = routes.clone();
    RouteDef::post("/api/signals/which/preview", move |req: Request| {
        let routes = routes.clone();
        async move {
            let asked: WhichPreviewRequest = req.parse()?;
            let mut cx = Issues::default();
            cx.at("which", |cx| which::validate(&asked.which, cx));
            refused(cx)?;
            let (routine, limit) = (asked.routine_id.clone(), asked.limit);
            let signals = routes.store.read(move |tx| tx.signals().page(routine.as_deref(), None, None, limit)).await?;
            let mut answer = WhichPreviewResponse {
                matched: Vec::new(),
                unmatched: Vec::new(),
                undecided: Vec::new(),
                would_ask: 0,
            };
            let mut misses: BTreeMap<usize, Vec<i64>> = BTreeMap::new();
            for signal in signals {
                let facts: Facts = signal
                    .signal
                    .facts_json
                    .as_deref()
                    .and_then(|json| serde_json::from_str(json).ok())
                    .unwrap_or_default();
                match asked.which.rule.as_ref().map_or(Verdict::Pass, |rule| evaluate(rule, &facts)) {
                    Verdict::Pass => answer.matched.push(signal.id),
                    Verdict::Fail(index) => misses.entry(index).or_default().push(signal.id),
                    Verdict::Missing(_) => answer.undecided.push(signal.id),
                }
            }
            answer.unmatched =
                misses.into_iter().map(|(rule, signal_ids)| RuleMisses { rule: rule as i64, signal_ids }).collect();
            if asked.which.ask.is_some() {
                answer.would_ask = answer.matched.len() as i64;
            }
            Ok(Response::json(200, &answer))
        }
    })
    .access(Access::ui_token())
}
