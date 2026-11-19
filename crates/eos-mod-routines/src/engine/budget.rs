//! Budgets (01 §4.10). A run's spend is the sum of its sessions' cost and
//! its working time the stretches its timeline spends running or checking
//! (G30: not while a question of it waits for the user). Each
//! `usage:recorded` of a routine session books its cost on the local day of
//! the spend (G31) and holds the run to its cost cap: at 90 % the lead is
//! told to wrap up, at 100 % the run fails `budget_run`. The supervisor's
//! loop holds runs to their time cap the same way, failing them
//! `budget_time` two minutes after the cap, and writes each working run's
//! spend every 30 s; every move of a run writes it too. Runs from triggers
//! are skipped while the routine's or everything's day budget is spent,
//! with one notice, and wait while the plan has no headroom (G28).

use std::collections::HashMap;
use std::sync::Arc;

use eos_contracts::RoutineKind;
use eos_contracts::stream::topics::USAGE_RECORDED;
use eos_core::Error;
use eos_core::store::{Outbox, RUN_STATE_EVENT, StoredRun, StoredRunEvent, Tx};
use eos_domain::inbox::ItemKind;
use eos_domain::routine::limits::{Budget, budget};
use eos_domain::routine::run::{Reason, RunState};
use eos_inbox::{NewItem, Opening, open_in};
use serde::Deserialize;
use serde_json::json;

use super::control::Control;
use super::{Engine, fail, note};
use crate::routes::{current_settings, readable, today};

/// How often a working run's spend is written while nothing moves it.
const WRITE_EVERY_MS: i64 = 30_000;
/// How long a run may still work once its time is up.
const GRACE_MS: i64 = 2 * 60_000;
const MINUTE_MS: i64 = 60_000;
/// The subject of the notice that a day budget is spent.
const DAY_CAP: &str = "day_cap";

const WRAP_UP_COST: &str = "This run has used 90% of what it may spend. Wrap up now: hand in your result with \
                            what you have, and say what is left undone.";
const WRAP_UP_TIME: &str = "This run has used 90% of its working time. Wrap up now: hand in your result with \
                            what you have, and say what is left undone.";

/// What a working run was told, and when its spend was last written. In
/// memory only: after a restart a run may be told once more.
#[derive(Debug, Default)]
pub(crate) struct Meter {
    wrapped_cost: bool,
    wrapped_time: bool,
    time_up_at: Option<i64>,
    written_at: i64,
}

/// A run's caps, from the version it runs: a project has none of its own.
struct Caps {
    usd: f64,
    ms: i64,
}

fn caps_of(tx: &dyn Tx, run: &StoredRun) -> Result<Option<Caps>, Error> {
    let Some(version_id) = &run.version_id else { return Ok(None) };
    let Some(version) = tx.routine_versions().find(&run.routine_id, version_id)? else { return Ok(None) };
    let Some(blueprint) = readable(&version)? else { return Ok(None) };
    if blueprint.kind == RoutineKind::Project {
        return Ok(None);
    }
    Ok(Some(Caps { usd: blueprint.limits.per_run_usd.0, ms: blueprint.limits.per_run_minutes * MINUTE_MS }))
}

/// What a run's sessions cost.
pub(crate) fn cost_in(tx: &dyn Tx, run_id: &str) -> Result<f64, Error> {
    let mut cost = 0.0;
    for session in tx.routine_sessions().by_run(run_id)? {
        cost += tx.workers().find(&session.worker_id)?.map_or(0.0, |worker| worker.usage.cost_usd);
    }
    Ok(cost)
}

/// The time the timeline spends running or checking: each such stretch up
/// to the next move. A stretch still open counts up to `until`, or without
/// it, up to its last event.
pub(crate) fn work_ms(events: &[StoredRunEvent], until: Option<i64>) -> i64 {
    let mut total = 0;
    let mut since: Option<i64> = None;
    for event in events {
        if let Some(start) = since {
            total += event.at - start;
            since = Some(event.at);
        }
        if event.kind == RUN_STATE_EVENT {
            let state = event.data.as_deref().and_then(|data| serde_json::from_str::<serde_json::Value>(data).ok());
            let state = state.as_ref().and_then(|data| data["state"].as_str().map(str::to_owned));
            since = matches!(state.as_deref(), Some("running" | "checking")).then_some(event.at);
        }
    }
    match (since, until) {
        (Some(start), Some(until)) => total + (until - start).max(0),
        _ => total,
    }
}

/// Writes the run's spend as its sessions and timeline count it.
pub(crate) fn recount_in(tx: &dyn Tx, run_id: &str) -> Result<(), Error> {
    let worked = work_ms(&tx.runs().events(run_id)?, None);
    tx.runs().set_spent(run_id, cost_in(tx, run_id)?, worked)
}

/// The ledger's kind for a run's spend.
fn spend_kind(run_kind: &str) -> &'static str {
    match run_kind {
        "trial" => "trial",
        "once" => "once",
        _ => "run",
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageRecorded {
    worker_id: String,
    delta_cost: f64,
}

/// From now on, what each routine session spends is booked and held to its
/// run's cost cap.
pub(crate) fn watch_usage(engine: &Arc<Engine>) {
    let weak = Arc::downgrade(engine);
    let subscription = engine.bus.on(USAGE_RECORDED, move |event| {
        let Some(engine) = weak.upgrade() else { return };
        let Ok(usage) = event.payload_as::<UsageRecorded>() else { return };
        let Some(tasks) = engine.tasks.clone() else { return };
        tasks.spawn(async move {
            if let Err(error) = spent(&engine, usage.worker_id, usage.delta_cost).await {
                tracing::warn!(%error, "a routine session's spend could not be booked");
            }
        });
    });
    *Engine::locked(&engine.usage) = Some(subscription);
}

/// A working run that just spent, with what it has spent in all.
struct Spending {
    run: StoredRun,
    cost: f64,
    caps: Option<Caps>,
}

async fn spent(engine: &Arc<Engine>, worker_id: String, delta: f64) -> Result<(), Error> {
    if delta <= 0.0 {
        return Ok(());
    }
    let day = today(engine);
    let spending = engine
        .store
        .write(move |tx, _| {
            let Some(session) = tx.routine_sessions().find(&worker_id)? else { return Ok(None) };
            let Some(run) = session.run_id.as_ref().map(|id| tx.runs().find(id)).transpose()?.flatten() else {
                // The architect's setup spend (G32).
                tx.routine_spend().add(&day, &session.routine_id, "architect", delta)?;
                return Ok(None);
            };
            tx.routine_spend().add(&day, &run.routine_id, spend_kind(&run.kind), delta)?;
            if !matches!(run.state, RunState::Running | RunState::Checking) {
                return Ok(None);
            }
            let (cost, caps) = (cost_in(tx, &run.id)?, caps_of(tx, &run)?);
            Ok(Some(Spending { run, cost, caps }))
        })
        .await?;
    let Some(Spending { run, cost, caps: Some(caps) }) = spending else { return Ok(()) };
    match budget(cost, caps.usd) {
        Budget::Within => Ok(()),
        Budget::WrapUp => {
            let first = !std::mem::replace(
                &mut Engine::locked(&engine.meters).entry(run.id.clone()).or_default().wrapped_cost,
                true,
            );
            match run.lead_id.filter(|_| first) {
                Some(lead) => note(engine, &lead, &run.id, WRAP_UP_COST).await,
                None => Ok(()),
            }
        }
        Budget::Reached => {
            tracing::info!(run_id = %run.id, cost_usd = cost, cap_usd = caps.usd, "a run spent its budget");
            fail(engine, &run.id, Reason::BudgetRun, None).await
        }
    }
}

/// A working run as the time check reads it.
struct AtWork {
    run: StoredRun,
    worked: i64,
    caps: Option<Caps>,
}

/// Holds every working run to its time cap and writes the spend of those
/// not written for 30 s. True while some run works.
pub(crate) async fn tick(engine: &Arc<Engine>) -> bool {
    let now = engine.clock.now_ms();
    let read = engine.store.read(move |tx| {
        let mut working = Vec::new();
        for run in tx.runs().at_work()? {
            let asked = tx
                .inbox_items()
                .waiting_of_routine(&run.routine_id)?
                .iter()
                .any(|item| item.kind == ItemKind::Question && item.run_id.as_deref() == Some(run.id.as_str()));
            let worked = work_ms(&tx.runs().events(&run.id)?, (!asked).then_some(now));
            let caps = caps_of(tx, &run)?;
            working.push(AtWork { run, worked, caps });
        }
        Ok(working)
    });
    let working = match read.await {
        Ok(working) => working,
        Err(error) => {
            tracing::warn!(%error, "the working runs could not be read");
            return false;
        }
    };
    Engine::locked(&engine.meters).retain(|id, _| working.iter().any(|at| at.run.id == *id));
    for at in &working {
        if let Err(error) = hold_to_time(engine, at, now).await {
            tracing::warn!(run_id = %at.run.id, %error, "a run's time could not be checked");
        }
    }
    !working.is_empty()
}

async fn hold_to_time(engine: &Arc<Engine>, at: &AtWork, now: i64) -> Result<(), Error> {
    let run_id = at.run.id.clone();
    let (write, wrap_up, time_up) = {
        let mut meters = Engine::locked(&engine.meters);
        let meter = meters.entry(run_id.clone()).or_insert_with(|| Meter { written_at: now, ..Meter::default() });
        let write = now - meter.written_at >= WRITE_EVERY_MS;
        if write {
            meter.written_at = now;
        }
        let state = at.caps.as_ref().map_or(Budget::Within, |caps| budget(at.worked as f64, caps.ms as f64));
        let wrap_up = state != Budget::Within && !std::mem::replace(&mut meter.wrapped_time, true);
        let time_up = state == Budget::Reached && now - *meter.time_up_at.get_or_insert(now) >= GRACE_MS;
        (write, wrap_up, time_up)
    };
    if time_up {
        tracing::info!(run_id = %run_id, work_ms = at.worked, "a run's working time is up");
        return fail(engine, &run_id, Reason::BudgetTime, None).await;
    }
    if wrap_up && let Some(lead) = &at.run.lead_id {
        note(engine, lead, &run_id, WRAP_UP_TIME).await?;
    }
    if write {
        let worked = at.worked;
        engine
            .store
            .write(move |tx, _| {
                let cost = cost_in(tx, &run_id)?;
                tx.runs().set_spent(&run_id, cost, worked)
            })
            .await?;
    }
    Ok(())
}

/// What the day allows, read before a job that starts runs.
#[derive(Debug, Clone)]
pub(crate) struct Day {
    /// The user's local day.
    pub(crate) day: String,
    /// What all routines together may spend today, today's raise included.
    pub(crate) cap_usd: f64,
    /// Runs whose agents work at once, over every routine.
    pub(crate) slots: i64,
    /// The plan has no headroom: runs from triggers wait.
    pub(crate) plan_busy: bool,
}

pub(crate) fn day(engine: &Engine) -> Day {
    let settings = current_settings(engine);
    let cap = settings.raised_today.map_or(settings.day_budget_usd.0, |raised| raised.usd.0);
    Day {
        day: today(engine),
        cap_usd: cap,
        slots: settings.max_parallel_runs,
        plan_busy: engine.headroom.busy(settings.plan_headroom_pct),
    }
}

/// What has been spent today: in all, and by each routine on its runs (the
/// architect's setup counts only in all, G32).
#[derive(Debug, Default)]
pub(crate) struct Spent {
    pub(crate) total: f64,
    by_routine: HashMap<String, f64>,
}

impl Spent {
    pub(crate) fn of_routine(&self, routine_id: &str) -> f64 {
        self.by_routine.get(routine_id).copied().unwrap_or_default()
    }
}

pub(crate) fn spent_in(tx: &dyn Tx, day: &str) -> Result<Spent, Error> {
    let mut spent = Spent::default();
    for row in tx.routine_spend().of_day(day)? {
        spent.total += row.cost_usd;
        if row.kind != "architect" {
            *spent.by_routine.entry(row.routine_id).or_default() += row.cost_usd;
        }
    }
    Ok(spent)
}

/// One notice that a day budget is spent: the routine's, or with no
/// routine, everything's. None while one waits.
pub(crate) fn day_cap_notice_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    engine: &Arc<Engine>,
    routine_id: Option<&str>,
    now: i64,
) -> Result<(), Error> {
    let waiting = tx.inbox_items().waiting_with_subject(DAY_CAP)?;
    if waiting.iter().any(|item| item.producer == "routines" && item.routine_id.as_deref() == routine_id) {
        return Ok(());
    }
    let (title, action) = match routine_id {
        Some(_) => ("This routine spent today's budget", "Change its limits"),
        None => ("Routines spent today's budget", "Raise today's cap"),
    };
    let control = Control(engine.clone());
    let at = Opening { now, ids: engine.ids.as_ref(), zone: engine.zone.as_ref(), control: &control };
    let item = NewItem {
        kind: ItemKind::Notice,
        producer: "routines".into(),
        routine_id: routine_id.map(str::to_owned),
        run_id: None,
        subject_key: Some(DAY_CAP.into()),
        title: title.into(),
        summary: "Runs from triggers are skipped until tomorrow; runs you start still ask first.".into(),
        payload: json!({"actionLabel": action}),
        by_hand: false,
    };
    open_in(tx, out, &at, item).map(drop)
}
