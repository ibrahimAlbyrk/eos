//! A routine's numbers (01 §4.14): the share of its results the user sent
//! as they were, this week and in its first full week, its runs and spend
//! of the week and what setting it up cost; and the runs that ended since
//! a time, counted by how (`GET /api/runs/summary`).

use eos_contracts::{Num, RoutineStats, RunsSummary};
use eos_core::Error;
use eos_core::store::{StoredRoutine, Tx};
use eos_domain::routine::numbers::{Ended, Outcome, baseline_first_week, sent_unedited_7d};
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;

use crate::engine::Engine;

const WEEK_MS: i64 = 7 * 24 * 60 * 60 * 1000;

fn ended(tx: &dyn Tx, routine_id: &str, from: i64, until: i64) -> Result<Vec<Ended>, Error> {
    let outcomes = tx.inbox_outcomes().between(routine_id, from, until)?;
    // Outcomes the share does not weigh (`auto_clean`, `held_flags`) have no word here.
    Ok(outcomes
        .into_iter()
        .filter_map(|row| Outcome::parse(&row.outcome.outcome).map(|outcome| Ended { at: row.outcome.at, outcome }))
        .collect())
}

/// The routine row's numbers, `runs7d` being what the row counted.
pub(crate) fn stats_in(tx: &dyn Tx, routine: &StoredRoutine, runs7d: i64, now: i64) -> Result<RoutineStats, Error> {
    let week = ended(tx, &routine.id, now - WEEK_MS, now + 1)?;
    let baseline = match routine.started_at {
        Some(started) if now >= started + WEEK_MS => {
            baseline_first_week(&ended(tx, &routine.id, started, started + WEEK_MS)?, started, now)
        }
        _ => None,
    };
    Ok(RoutineStats {
        sent_unedited7d: sent_unedited_7d(&week, now).map(Num),
        baseline_first_week: baseline.map(Num),
        runs7d,
        cost7d: Num(tx.runs().cost_since(&routine.id, now - WEEK_MS)?),
        setup_usd: Num(tx.routine_spend().total(&routine.id, "architect")?),
    })
}

fn summary_in(tx: &dyn Tx, since: i64) -> Result<RunsSummary, Error> {
    let mut summary = RunsSummary { since, ..RunsSummary::default() };
    for row in tx.runs().ended_counts(since)? {
        *summary.by_outcome.entry(row.ended.clone()).or_default() += row.count;
        *summary.by_routine.entry(row.routine_id).or_default().entry(row.ended).or_default() += row.count;
    }
    Ok(summary)
}

pub(crate) fn summary_route(engine: &std::sync::Arc<Engine>) -> RouteDef {
    let store = engine.store.clone();
    RouteDef::get("/api/runs/summary", move |req: Request| {
        let store = store.clone();
        async move {
            let since = req.query().get("since").map(|text| text.parse::<i64>());
            let since = match since {
                Some(Ok(since)) => since,
                Some(Err(_)) => return Err(ApiError::Validation("invalid request: since".into())),
                None => return Err(ApiError::Validation("invalid request: since is required".into())),
            };
            Ok(Response::json(200, &store.read(move |tx| summary_in(tx, since)).await?))
        }
    })
    // Counts by outcome word and routine id: no text of the user's.
    .access(Access::open().phone(Tier::Read))
}
