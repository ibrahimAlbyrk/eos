//! `POST /api/runs/estimate`: what a number of runs will likely cost and how
//! long one takes (01 G8): the median of the routine's last finished runs
//! with the same option values; else of its trial runs; else each agent's
//! usual tokens for its role at its model's price.

use std::sync::Arc;

use eos_contracts::{Blueprint, EstimateRequest, EstimateResponse, Num, RunInput, WhoDepth};
use eos_core::Error;
use eos_core::store::{StoredRun, Tx};
use eos_domain::config::price_for_model;
use eos_domain::routine::numbers::{Estimate, Spend, estimate, option_signature, table_usd};
use eos_domain::routine::run::RunState;
use eos_domain::worker::Usage;
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{Request, Response};
use eos_runtime::router::RouteDef;

use super::{readable, showing_version};
use crate::engine::{Engine, model_of};

/// How many of a routine's runs the history is read from.
const HISTORY_READ: i64 = 200;
const MINUTE_MS: i64 = 60_000;

/// One agent's usual run by its role: input, cache read and output tokens,
/// and minutes. A starting point, measured against real runs as they come.
struct RoleTable {
    tokens_in: i64,
    cache_read: i64,
    tokens_out: i64,
    minutes: i64,
}

const LEAD: RoleTable = RoleTable { tokens_in: 20_000, cache_read: 60_000, tokens_out: 6_000, minutes: 6 };
const SPECIALIST: RoleTable = RoleTable { tokens_in: 15_000, cache_read: 40_000, tokens_out: 4_000, minutes: 4 };
const CHECKER: RoleTable = RoleTable { tokens_in: 10_000, cache_read: 20_000, tokens_out: 1_500, minutes: 2 };

impl RoleTable {
    fn usage(&self) -> Usage {
        Usage {
            tokens_in: self.tokens_in,
            tokens_out: self.tokens_out,
            tokens_cache_read: self.cache_read,
            tokens_cache_create: 0,
            tokens_cache_create_1h: 0,
            cost_usd: 0.0,
        }
    }
}

pub(crate) fn route(engine: &Arc<Engine>) -> RouteDef {
    let engine = engine.clone();
    RouteDef::post("/api/runs/estimate", move |req: Request| {
        let engine = engine.clone();
        async move {
            let asked: EstimateRequest = req.parse()?;
            let count = asked.count.max(1);
            let config = engine.config.current();
            let id = asked.routine_id.clone();
            let found = engine
                .store
                .read(move |tx| {
                    let Some(version) = showing_version(tx, &id)? else { return Ok(None) };
                    let Some(blueprint) = readable(&version)? else { return Ok(None) };
                    let runs = tx.runs().by_routine(&id, HISTORY_READ)?;
                    Ok(Some((blueprint, runs)))
                })
                .await?;
            let (blueprint, runs) = found.ok_or_else(|| Error::not_found("routine", asked.routine_id.clone()))?;
            let price = |model: &str| price_for_model(&config, Some(model)).cloned();
            let one = usual(&blueprint, &runs, &asked.input, price);
            Ok(Response::json(
                200,
                &EstimateResponse {
                    usd: Num(one.usd * count as f64),
                    ms: one.ms,
                    basis: one.basis.as_str().to_owned(),
                    n: one.n as i64,
                },
            ))
        }
    })
    .access(Access::open().phone(Tier::Read))
}

/// One run of `input`, by the routine's history, its trials or the table.
pub(crate) fn usual(
    blueprint: &Blueprint,
    runs: &[StoredRun],
    input: &RunInput,
    price: impl Fn(&str) -> Option<eos_contracts::ModelPricing>,
) -> Estimate {
    let signature = option_signature(&blueprint.options, &input.options);
    let spend = |run: &StoredRun| Spend { usd: run.cost_usd, ms: run.work_ms };
    let finished = |run: &&StoredRun| run.state == RunState::Done;
    let done: Vec<Spend> = runs
        .iter()
        .filter(finished)
        .filter(|run| run.kind != "trial" && signature_of(blueprint, run).as_deref() == Some(signature.as_str()))
        .map(spend)
        .collect();
    let trials: Vec<Spend> = runs.iter().filter(finished).filter(|run| run.kind == "trial").map(spend).collect();
    estimate(&done, &trials, table(blueprint, input, price))
}

fn signature_of(blueprint: &Blueprint, run: &StoredRun) -> Option<String> {
    let input: RunInput = serde_json::from_str(&run.input).ok()?;
    Some(option_signature(&blueprint.options, &input.options))
}

/// Each agent's usual tokens at its model's price; the time is the lead's
/// and the checker's, as the specialists work beside the lead.
fn table(
    blueprint: &Blueprint,
    input: &RunInput,
    price: impl Fn(&str) -> Option<eos_contracts::ModelPricing>,
) -> Spend {
    let mut agents: Vec<(Usage, Option<eos_contracts::ModelPricing>)> = Vec::new();
    let mut minutes = 0;
    for agent in &blueprint.who.agents {
        let leads = blueprint.who.depth == WhoDepth::Solo || agent.lead;
        let role = if leads { &LEAD } else { &SPECIALIST };
        let (model, _) = model_of(blueprint, agent, input);
        agents.push((role.usage(), price(&model)));
        if leads {
            minutes += role.minutes;
        }
    }
    if blueprint.how.check_agent {
        agents.push((CHECKER.usage(), price(&blueprint.who.checker.model)));
        minutes += CHECKER.minutes;
    }
    let usd = table_usd(agents.iter().map(|(usage, pricing)| (usage, pricing.as_ref())));
    Spend { usd, ms: minutes * MINUTE_MS }
}

/// The usual cost of a run of the routine with the options of `run`, from
/// its own history only.
pub(crate) fn usual_of(tx: &dyn Tx, blueprint: &Blueprint, run: &StoredRun) -> Result<Option<Estimate>, Error> {
    let input: RunInput = serde_json::from_str(&run.input).map_err(|_| Error::storage("a run without input"))?;
    let runs = tx.runs().by_routine(&run.routine_id, HISTORY_READ)?;
    let found = usual(blueprint, &runs, &input, |_| None);
    Ok((found.basis == eos_domain::routine::numbers::Basis::History).then_some(found))
}
