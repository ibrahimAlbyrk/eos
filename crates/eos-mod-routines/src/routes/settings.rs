//! `GET`/`PUT /api/routines/settings`: the settings for all routines, flat
//! keys of `settings.json` that only this route writes (the flat settings
//! route refuses them). A value that is missing or malformed reads as its
//! default.

use std::sync::Arc;

use eos_contracts::{Num, RoutineSettings, RoutineSettingsPatch, SettingValue, UserSettings};
use eos_core::Error;
use eos_domain::routine::limits::day_key;
use eos_runtime::access::Access;
use eos_runtime::http::{Request, Response};
use eos_runtime::module::ProtectedSettings;
use eos_runtime::router::RouteDef;

use crate::engine::Engine;

const MAX_PARALLEL: &str = "routines.maxParallelRuns";

/// The default (D6).
const MAX_PARALLEL_RUNS: i64 = 3;

pub(crate) fn protected_settings() -> ProtectedSettings {
    ProtectedSettings { keys: vec![MAX_PARALLEL], via: "PUT /api/routines/settings" }
}

fn whole(settings: &UserSettings, key: &str, min: i64, max: i64, default: i64) -> i64 {
    let value = match settings.get(key) {
        Some(SettingValue::Number(Num(value))) if value.is_finite() && value.fract() == 0.0 => Some(*value as i64),
        _ => None,
    };
    value.filter(|value| (min..=max).contains(value)).unwrap_or(default)
}

/// The local day it is now on the user's clock.
pub(crate) fn today(engine: &Engine) -> String {
    let now = engine.clock.now_ms();
    day_key(now, engine.zone.offset_minutes_at(now))
}

/// The settings as they read now.
pub(crate) fn current(engine: &Engine) -> RoutineSettings {
    let settings = engine.settings.read();
    RoutineSettings { max_parallel_runs: whole(&settings, MAX_PARALLEL, 1, 3, MAX_PARALLEL_RUNS) }
}

fn stored(patch: RoutineSettingsPatch) -> UserSettings {
    let mut partial = UserSettings::new();
    if let Some(runs) = patch.max_parallel_runs {
        partial.insert(MAX_PARALLEL.to_owned(), SettingValue::Number(Num(runs as f64)));
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
            // More slots may start a waiting run.
            engine.wake.notify_one();
            Ok(Response::json(200, &current(&engine)))
        }
    });
    vec![get.access(Access::open()), put.access(Access::ui_token())]
}
