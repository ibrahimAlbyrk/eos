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
use eos_domain::routine::limits::{Budget, budget, cap};
use eos_domain::routine::run::{Reason, RunState};
use eos_inbox::{NewItem, Opening, notice_in, open_in};
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
/// The subject of the notice that most of today's budget is spent.
const DAY_BUDGET: &str = "day-budget";
/// The share of today's budget whose spending is told (01 §4.10).
const DAY_NOTICE_SHARE: f64 = 0.9;

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

/// On a run's timeline: a question of the run waits for the user since `data.at`
/// (G30), until the next [`ANSWERED`]. Neither the wait nor what it covers is
/// working time, also across a pause or a restart.
pub(crate) const ASKED: &str = "asked";
/// On a run's timeline: the first turn that found its questions answered.
pub(crate) const ANSWERED: &str = "answered";

/// A run's caps, from the version it runs; a spend cap left out is endless.
/// A project has none of its own:
/// the milestone it works on may name some, counted from the spend and the
/// working time the run had when that milestone began.
struct Caps {
    usd: f64,
    ms: i64,
    base_usd: f64,
    base_ms: i64,
}

fn caps_of(tx: &dyn Tx, run: &StoredRun) -> Result<Option<Caps>, Error> {
    let Some(version_id) = &run.version_id else { return Ok(None) };
    let Some(version) = tx.routine_versions().find(&run.routine_id, version_id)? else { return Ok(None) };
    let Some(blueprint) = readable(&version)? else { return Ok(None) };
    if blueprint.kind != RoutineKind::Project {
        let usd = cap(blueprint.limits.per_run_usd.map(|usd| usd.0));
        let ms = blueprint.limits.per_run_minutes * MINUTE_MS;
        return Ok(Some(Caps { usd, ms, base_usd: 0.0, base_ms: 0 }));
    }
    let Some(limits) = super::project::current(&blueprint, run).and_then(|milestone| milestone.limits) else {
        return Ok(None);
    };
    let events = tx.runs().events(&run.id)?;
    let began = events.iter().rposition(|event| event.kind == super::project::MILESTONE_BEGAN);
    let (base_usd, base_ms) = match began {
        Some(at) => {
            let data = events[at].data.as_deref().and_then(|data| serde_json::from_str::<serde_json::Value>(data).ok());
            let cost = data.and_then(|data| data["costUsd"].as_f64()).unwrap_or(0.0);
            (cost, work_ms(&events[..at], Some(events[at].at)))
        }
        None => (0.0, 0),
    };
    Ok(Some(Caps { usd: limits.usd, ms: limits.minutes * MINUTE_MS, base_usd, base_ms }))
}

/// What a run's sessions cost.
pub(crate) fn cost_in(tx: &dyn Tx, run_id: &str) -> Result<f64, Error> {
    let mut cost = 0.0;
    for session in tx.routine_sessions().by_run(run_id)? {
        cost += tx.workers().find(&session.worker_id)?.map_or(0.0, |worker| worker.usage.cost_usd);
    }
    Ok(cost)
}

/// The time the timeline spends running or checking while no question of
/// the run waits: each such stretch up to the next move. A stretch still
/// open counts up to `until`, or without it, up to its last event.
pub(crate) fn work_ms(events: &[StoredRunEvent], until: Option<i64>) -> i64 {
    let mut total = 0;
    let mut since: Option<i64> = None;
    let mut asked = false;
    for event in events {
        let data = event.data.as_deref().and_then(|data| serde_json::from_str::<serde_json::Value>(data).ok());
        // A wait begins when its question was asked, which may be before the turn that saw it.
        let at = match event.kind.as_str() {
            ASKED => data.as_ref().and_then(|data| data["at"].as_i64()).map_or(event.at, |at| at.min(event.at)),
            _ => event.at,
        };
        if let Some(start) = since {
            if !asked {
                total += (at - start).max(0);
            }
            since = Some(at.max(start));
        }
        match event.kind.as_str() {
            RUN_STATE_EVENT => {
                let state = data.as_ref().and_then(|data| data["state"].as_str());
                since = matches!(state, Some("running" | "checking")).then_some(event.at);
            }
            ASKED => asked = true,
            ANSWERED => asked = false,
            _ => {}
        }
    }
    match (since, until) {
        (Some(start), Some(until)) if !asked => total + (until - start).max(0),
        _ => total,
    }
}

/// Whether the timeline holds a wait for the user that no turn found answered yet.
fn asking(events: &[StoredRunEvent]) -> bool {
    events.iter().rev().find(|event| event.kind == ASKED || event.kind == ANSWERED).is_some_and(|e| e.kind == ASKED)
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

/// What booking a run's spend came to.
enum Booked {
    Working(Box<Spending>),
    /// A project run that spent the day's budget, paused till tomorrow.
    Paused(String),
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
    let Day { day, cap_usd, .. } = self::day(engine);
    let job = engine.clone();
    let spending = engine
        .store
        .write(move |tx, out| {
            let before = spent_in(tx, &day)?.total;
            let Some(session) = tx.routine_sessions().find(&worker_id)? else { return Ok(None) };
            if before < DAY_NOTICE_SHARE * cap_usd && before + delta >= DAY_NOTICE_SHARE * cap_usd {
                day_share_notice_in(tx, out, &job, before + delta, cap_usd)?;
            }
            let Some(run) = session.run_id.as_ref().map(|id| tx.runs().find(id)).transpose()?.flatten() else {
                // The architect's setup spend (G32).
                tx.routine_spend().add(&day, &session.routine_id, "architect", delta)?;
                return Ok(None);
            };
            tx.routine_spend().add(&day, &run.routine_id, spend_kind(&run.kind), delta)?;
            if !matches!(run.state, RunState::Running | RunState::Checking) {
                return Ok(None);
            }
            if super::project::pause_at_day_cap_in(&job, tx, out, &run, &day, cap_usd)? {
                return Ok(Some(Booked::Paused(run.id)));
            }
            let (cost, caps) = (cost_in(tx, &run.id)?, caps_of(tx, &run)?);
            Ok(Some(Booked::Working(Box::new(Spending { run, cost, caps }))))
        })
        .await?;
    let spending = match spending {
        Some(Booked::Paused(run_id)) => {
            super::steer::quiet(engine, &run_id).await;
            return Ok(());
        }
        Some(Booked::Working(spending)) => *spending,
        None => return Ok(()),
    };
    let Spending { run, cost, caps: Some(caps) } = spending else { return Ok(()) };
    match budget(cost - caps.base_usd, caps.usd) {
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
    /// Its working time up to now, waits for the user left out.
    worked: i64,
    caps: Option<Caps>,
}

/// When the oldest question of `run` that still waits for the user was asked.
fn asked_at(tx: &dyn Tx, run: &StoredRun) -> Result<Option<i64>, Error> {
    let waiting = tx.inbox_items().waiting_of_routine(&run.routine_id)?;
    let questions = waiting.iter().filter(|item| item.kind == ItemKind::Question);
    Ok(questions.filter(|item| item.run_id.as_deref() == Some(run.id.as_str())).map(|item| item.created_at).min())
}

/// Puts on each working run's timeline a wait for the user that began or
/// ended since the last turn. True when it put one.
fn mark_waits_in(tx: &dyn Tx, now: i64) -> Result<bool, Error> {
    let mut marked = false;
    for run in tx.runs().at_work()? {
        let (asked_at, asking) = (asked_at(tx, &run)?, asking(&tx.runs().events(&run.id)?));
        match (asked_at, asking) {
            (Some(at), false) => tx.runs().append_event(&run.id, now, ASKED, Some(&json!({"at": at}).to_string()))?,
            (None, true) => tx.runs().append_event(&run.id, now, ANSWERED, None)?,
            _ => continue,
        }
        marked = true;
    }
    Ok(marked)
}

/// The working runs, or none when a wait began or ended since the last turn.
fn working_in(tx: &dyn Tx, now: i64) -> Result<Option<Vec<AtWork>>, Error> {
    let mut working = Vec::new();
    for run in tx.runs().at_work()? {
        let events = tx.runs().events(&run.id)?;
        if asked_at(tx, &run)?.is_some() != asking(&events) {
            return Ok(None);
        }
        let worked = work_ms(&events, Some(now));
        let caps = caps_of(tx, &run)?;
        working.push(AtWork { run, worked, caps });
    }
    Ok(Some(working))
}

/// Holds every working run to its time cap and writes the spend of those
/// not written for 30 s. True while some run works.
pub(crate) async fn tick(engine: &Arc<Engine>) -> bool {
    let now = engine.clock.now_ms();
    let read = async {
        if let Some(working) = engine.store.read(move |tx| working_in(tx, now)).await? {
            return Ok(working);
        }
        engine.store.write(move |tx, _| mark_waits_in(tx, now)).await?;
        let read = engine.store.read(move |tx| working_in(tx, now)).await?;
        read.ok_or_else(|| Error::Conflict("a wait changed again while it was marked".into()))
    };
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
    let (worked, write, wrap_up, time_up) = {
        let mut meters = Engine::locked(&engine.meters);
        let meter = meters.entry(run_id.clone()).or_insert_with(|| Meter { written_at: now, ..Meter::default() });
        let write = now - meter.written_at >= WRITE_EVERY_MS;
        if write {
            meter.written_at = now;
        }
        let worked = at.worked;
        let state =
            at.caps.as_ref().map_or(Budget::Within, |caps| budget((worked - caps.base_ms) as f64, caps.ms as f64));
        let wrap_up = state != Budget::Within && !std::mem::replace(&mut meter.wrapped_time, true);
        let time_up = state == Budget::Reached && now - *meter.time_up_at.get_or_insert(now) >= GRACE_MS;
        (worked, write, wrap_up, time_up)
    };
    if time_up {
        tracing::info!(run_id = %run_id, work_ms = worked, "a run's working time is up");
        return fail(engine, &run_id, Reason::BudgetTime, None).await;
    }
    if wrap_up && let Some(lead) = &at.run.lead_id {
        note(engine, lead, &run_id, WRAP_UP_TIME).await?;
    }
    if write {
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
    /// What all routines together may spend today, today's raise included;
    /// endless without a day budget.
    pub(crate) cap_usd: f64,
    /// Runs whose agents work at once, over every routine.
    pub(crate) slots: i64,
    /// The plan has no headroom: runs from triggers wait.
    pub(crate) plan_busy: bool,
}

pub(crate) fn day(engine: &Engine) -> Day {
    let settings = current_settings(engine);
    // A raise lifts a day budget; with none there is nothing to raise.
    let budget = settings.day_budget_usd.map(|usd| settings.raised_today.map_or(usd.0, |raised| raised.usd.0));
    Day {
        day: today(engine),
        cap_usd: cap(budget),
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

/// A notice, once a local day, that routines spent [`DAY_NOTICE_SHARE`] of
/// what they may spend today.
fn day_share_notice_in(tx: &dyn Tx, out: &mut Outbox, engine: &Arc<Engine>, spent: f64, cap: f64) -> Result<(), Error> {
    let now = engine.clock.now_ms();
    let control = Control(engine.clone());
    let at = Opening { now, ids: engine.ids.as_ref(), zone: engine.zone.as_ref(), control: &control };
    let item = NewItem {
        kind: ItemKind::Notice,
        producer: "routines".into(),
        routine_id: None,
        run_id: None,
        subject_key: Some(DAY_BUDGET.into()),
        // Whole dollars, never more than was spent.
        title: format!("Routines have spent ${:.0} of today's ${cap:.0}", spent.floor()),
        summary: "Runs from triggers stop once today's budget is spent.".into(),
        payload: json!({"actionLabel": "Raise today's cap"}),
        by_hand: false,
    };
    tracing::info!(spent_usd = spent, cap_usd = cap, "routines spent most of today's budget");
    notice_in(tx, out, &at, item).map(drop)
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
