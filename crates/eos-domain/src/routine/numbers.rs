//! What a routine's runs add up to: how a run ended for the user, what a run
//! will likely cost and take, and the share of results the user sent as
//! they were.

use eos_contracts::{ModelPricing, RoutineOption};
use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::cost::cost_usd;
use crate::sync::stable::stable_stringify;
use crate::worker::Usage;

const WEEK_MS: i64 = 7 * 24 * 60 * 60 * 1000;

words! {
    /// How a run that ended `done` went: what became of its result at the
    /// gate, or that it was only shown or had nothing to send.
    pub enum Outcome {
        SentUnedited = "sent_unedited",
        SentEdited = "sent_edited",
        Discarded = "discarded",
        /// Sent without asking, as the routine's Freedom allows.
        AutoSent = "auto_sent",
        Expired = "expired",
        /// A newer result on the same subject took its place.
        Replaced = "replaced",
        Undone = "undone",
        /// The user said a sent result was wrong: an outcome row only, never
        /// how a run ended.
        Wrong = "wrong",
        /// Shown in Eos and sent nowhere.
        Shown = "shown",
        Nothing = "nothing",
    }
}

/// The middle of `values`, or the mean of the middle two; `None` for none.
pub fn median(values: impl IntoIterator<Item = f64>) -> Option<f64> {
    let mut values: Vec<f64> = values.into_iter().collect();
    values.sort_by(f64::total_cmp);
    let mid = values.len() / 2;
    match values.len() {
        0 => None,
        n if n % 2 == 1 => Some(values[mid]),
        _ => Some((values[mid - 1] + values[mid]) / 2.0),
    }
}

/// What one run cost and how long it worked.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Spend {
    pub usd: f64,
    pub ms: i64,
}

words! {
    /// What an estimate was taken from.
    pub enum Basis {
        /// The routine's own finished runs.
        History = "history",
        Trials = "trials",
        /// Each agent's usual tokens at its model's price.
        Table = "table",
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Estimate {
    pub usd: f64,
    pub ms: i64,
    pub basis: Basis,
    /// How many runs it was taken over; none for the table.
    pub n: usize,
}

/// How many runs a usual cost and time are taken over.
pub const USUAL_RUNS: usize = 20;

/// What a run will likely cost and take: the median of the routine's last
/// `done` runs with the run's option signature (`done`, newest first);
/// without any, of its trial runs; else `table`.
pub fn estimate(done: &[Spend], trials: &[Spend], table: Spend) -> Estimate {
    let (runs, basis) = match (done, trials) {
        ([_, ..], _) => (done, Basis::History),
        ([], [_, ..]) => (trials, Basis::Trials),
        ([], []) => return Estimate { usd: table.usd, ms: table.ms, basis: Basis::Table, n: 0 },
    };
    let runs = &runs[..runs.len().min(USUAL_RUNS)];
    let usd = median(runs.iter().map(|run| run.usd)).unwrap_or_default();
    let ms = median(runs.iter().map(|run| run.ms as f64)).unwrap_or_default();
    Estimate { usd, ms: ms.round() as i64, basis, n: runs.len() }
}

/// A run's cost by the table: each agent's usual tokens for its role at its
/// model's price.
pub fn table_usd<'a>(agents: impl IntoIterator<Item = (&'a Usage, Option<&'a ModelPricing>)>) -> f64 {
    agents.into_iter().map(|(tokens, pricing)| cost_usd(pricing, tokens)).sum()
}

/// The option values a run goes with, as one text: every option of the
/// blueprint at the run's value or its default. Runs with the same
/// signature share a usual cost.
pub fn option_signature(options: &[RoutineOption], values: &IndexMap<String, Value>) -> String {
    let chosen: Map<String, Value> = options
        .iter()
        .map(|option| (option.key.clone(), values.get(&option.key).unwrap_or(&option.default).clone()))
        .collect();
    stable_stringify(&Value::Object(chosen))
}

/// A run that ended `done`: when, and how.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Ended {
    pub at: i64,
    pub outcome: Outcome,
}

/// The share of results sent without edits, from 0 to 1: unedited over
/// unedited, edited and discarded. `None` when the user judged none.
fn sent_unedited<'a>(runs: impl Iterator<Item = &'a Ended>) -> Option<f64> {
    let (mut unedited, mut judged) = (0_u32, 0_u32);
    for run in runs {
        match run.outcome {
            Outcome::SentUnedited => (unedited, judged) = (unedited + 1, judged + 1),
            Outcome::SentEdited | Outcome::Discarded => judged += 1,
            _ => {}
        }
    }
    (judged > 0).then(|| f64::from(unedited) / f64::from(judged))
}

/// The share over the seven days up to `now`.
pub fn sent_unedited_7d(runs: &[Ended], now: i64) -> Option<f64> {
    sent_unedited(runs.iter().filter(|run| run.at > now - WEEK_MS && run.at <= now))
}

/// The share over the routine's first full week: the seven days from
/// `started_at`, once they are over.
pub fn baseline_first_week(runs: &[Ended], started_at: i64, now: i64) -> Option<f64> {
    let end = started_at + WEEK_MS;
    if now < end {
        return None;
    }
    sent_unedited(runs.iter().filter(|run| run.at >= started_at && run.at < end))
}

#[cfg(test)]
mod tests;
