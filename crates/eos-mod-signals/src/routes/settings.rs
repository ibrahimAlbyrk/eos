//! `GET`/`PUT /api/signals/settings`: keep the computer awake on mains power
//! while a schedule is armed. The flag is a key of `settings.json` only the
//! `PUT` writes; both answer the setting as it reads then.

use std::sync::Arc;

use eos_contracts::{SettingValue, SignalSettings};
use eos_core::Error;
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{Request, Response};
use eos_runtime::router::RouteDef;

use super::Routes;
use crate::awake::{KEEP_AWAKE, flag};

pub(super) fn read(routes: &Arc<Routes>) -> RouteDef {
    let routes = routes.clone();
    RouteDef::get("/api/signals/settings", move |_req: Request| {
        let routes = routes.clone();
        async move {
            let store = routes.settings.clone();
            let settings = tokio::task::spawn_blocking(move || store.read())
                .await
                .map_err(|error| Error::Storage(error.to_string()))?;
            Ok(Response::json(200, &SignalSettings { keep_awake_for_schedules: flag(&settings, KEEP_AWAKE) }))
        }
    })
    .access(Access::ui_token().phone_user(Tier::Read))
}

pub(super) fn route(routes: &Arc<Routes>) -> RouteDef {
    let routes = routes.clone();
    RouteDef::put("/api/signals/settings", move |req: Request| {
        let routes = routes.clone();
        async move {
            let asked: SignalSettings = req.parse()?;
            let partial = [(KEEP_AWAKE.to_owned(), SettingValue::Flag(asked.keep_awake_for_schedules))].into();
            let store = routes.settings.clone();
            let settings = tokio::task::spawn_blocking(move || store.patch(partial))
                .await
                .map_err(|error| Error::Storage(error.to_string()))??;
            let current = SignalSettings { keep_awake_for_schedules: flag(&settings, KEEP_AWAKE) };
            tracing::info!(keep_awake = current.keep_awake_for_schedules, "the signals' settings changed");
            routes.kick.notify_one();
            Ok(Response::json(200, &current))
        }
    })
    .access(Access::ui_token().phone_user(Tier::Low))
}
