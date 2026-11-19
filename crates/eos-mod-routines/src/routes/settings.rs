//! `GET`/`PUT /api/routines/settings`: the budgets for all routines, flat
//! keys of `settings.json` that only this route writes (the flat settings
//! route refuses them). A value that is missing or malformed reads as its
//! default; today's raise reads only on the local day it was made for.

use std::sync::Arc;

use eos_contracts::{Num, RaisedToday, RoutineSettings, RoutineSettingsPatch, SettingValue, UserSettings};
use eos_core::Error;
use eos_domain::routine::limits::day_key;
use eos_runtime::access::Access;
use eos_runtime::http::{Request, Response};
use eos_runtime::module::ProtectedSettings;
use eos_runtime::router::RouteDef;

use crate::engine::Engine;

const DAY_BUDGET: &str = "routines.dayBudgetUsd";
const MAX_PARALLEL: &str = "routines.maxParallelRuns";
const PLAN_HEADROOM: &str = "routines.planHeadroomPct";
const RAISED_TODAY: &str = "routines.raisedToday";

/// The defaults (D6, D7).
const DAY_BUDGET_USD: f64 = 20.0;
const MAX_PARALLEL_RUNS: i64 = 3;
const PLAN_HEADROOM_PCT: i64 = 80;

pub(crate) fn protected_settings() -> ProtectedSettings {
    ProtectedSettings {
        keys: vec![DAY_BUDGET, MAX_PARALLEL, PLAN_HEADROOM, RAISED_TODAY],
        via: "PUT /api/routines/settings",
    }
}

fn number(settings: &UserSettings, key: &str) -> Option<f64> {
    match settings.get(key) {
        Some(SettingValue::Number(Num(value))) if value.is_finite() => Some(*value),
        _ => None,
    }
}

fn whole(settings: &UserSettings, key: &str, min: i64, max: i64, default: i64) -> i64 {
    let value = number(settings, key).filter(|value| value.fract() == 0.0).map(|value| value as i64);
    value.filter(|value| (min..=max).contains(value)).unwrap_or(default)
}

fn raised(settings: &UserSettings, today: &str) -> Option<RaisedToday> {
    let Some(SettingValue::Map(raise)) = settings.get(RAISED_TODAY) else { return None };
    let usd = raise.get("usd")?.parse::<f64>().ok().filter(|usd| usd.is_finite() && *usd >= 0.0)?;
    (raise.get("day")? == today).then(|| RaisedToday { day: today.to_owned(), usd: Num(usd) })
}

/// The local day it is now on the user's clock.
pub(crate) fn today(engine: &Engine) -> String {
    let now = engine.clock.now_ms();
    day_key(now, engine.zone.offset_minutes_at(now))
}

/// The settings as they read now.
pub(crate) fn current(engine: &Engine) -> RoutineSettings {
    let settings = engine.settings.read();
    let day = number(&settings, DAY_BUDGET).filter(|usd| *usd > 0.0).unwrap_or(DAY_BUDGET_USD);
    RoutineSettings {
        day_budget_usd: Num(day),
        max_parallel_runs: whole(&settings, MAX_PARALLEL, 1, 3, MAX_PARALLEL_RUNS),
        plan_headroom_pct: whole(&settings, PLAN_HEADROOM, 1, 100, PLAN_HEADROOM_PCT),
        raised_today: raised(&settings, &today(engine)),
    }
}

fn stored(patch: RoutineSettingsPatch) -> UserSettings {
    let mut partial = UserSettings::new();
    if let Some(usd) = patch.day_budget_usd {
        partial.insert(DAY_BUDGET.to_owned(), SettingValue::Number(usd));
    }
    if let Some(runs) = patch.max_parallel_runs {
        partial.insert(MAX_PARALLEL.to_owned(), SettingValue::Number(Num(runs as f64)));
    }
    if let Some(pct) = patch.plan_headroom_pct {
        partial.insert(PLAN_HEADROOM.to_owned(), SettingValue::Number(Num(pct as f64)));
    }
    if let Some(raise) = patch.raised_today {
        let fields = [("day".to_owned(), raise.day), ("usd".to_owned(), raise.usd.to_string())].into_iter().collect();
        partial.insert(RAISED_TODAY.to_owned(), SettingValue::Map(fields));
    }
    partial
}

pub(crate) fn all(engine: &Arc<Engine>) -> Vec<RouteDef> {
    let reading = engine.clone();
    let get = RouteDef::get("/api/routines/settings", move |_req: Request| {
        let engine = reading.clone();
        async move { Ok(Response::json(200, &current(&engine))) }
    });
    let writing = engine.clone();
    let put = RouteDef::put("/api/routines/settings", move |req: Request| {
        let engine = writing.clone();
        async move {
            let patch: RoutineSettingsPatch = req.parse()?;
            let partial = stored(patch);
            let keys: Vec<String> = partial.keys().cloned().collect();
            let store = engine.settings.clone();
            tokio::task::spawn_blocking(move || store.patch(partial))
                .await
                .map_err(|error| Error::storage(error.to_string()))??;
            tracing::info!(?keys, "the routines' settings changed");
            // A wider cap or more slots may start a waiting run.
            engine.wake.notify_one();
            Ok(Response::json(200, &current(&engine)))
        }
    });
    vec![get.access(Access::open()), put.access(Access::ui_token())]
}
