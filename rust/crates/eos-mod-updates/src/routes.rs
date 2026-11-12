//! In-app updates over the wire (`manager/modules/updates/routes.ts`). All the
//! dashboard's (ui-token) and local-only: another computer never updates or
//! restarts this one.
//!
//! ```text
//! GET  /api/update              the update state
//! POST /api/update/check        {trigger?} — look for a new release (manual = always)
//! POST /api/update/download     fetch the offered release (auto-download off)
//! POST /api/update/restart      {when: "now" | "idle"} — swap in the staged release
//! POST /api/update/later        stop waiting for agents
//! POST /api/update/dismiss      hide how the last swap ended
//! PUT  /api/settings/updates    {autoDownload}
//! ```

use std::sync::Arc;

use eos_contracts::routes as table;
use eos_contracts::update::{UpdateCheckRequest, UpdateCheckTrigger, UpdateRestartRequest, UpdateSettingsPatch};
use eos_core::store::ConfigSource;
use eos_runtime::access::Access;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;

use crate::service::{CheckTrigger, UpdateService};

/// This computer's own app: another computer may not update or restart it.
const ACCESS: Access = Access::ui_token().local_only();

fn state(updates: &UpdateService, status: u16) -> Response {
    Response::json(status, &updates.state())
}

pub(crate) fn all(updates: &Arc<UpdateService>, config: &Arc<dyn ConfigSource>) -> Vec<RouteDef> {
    let read = {
        let updates = updates.clone();
        move |_req: Request| {
            let updates = updates.clone();
            async move { Ok(state(&updates, 200)) }
        }
    };
    let check = {
        let updates = updates.clone();
        move |req: Request| {
            let updates = updates.clone();
            async move {
                let body: UpdateCheckRequest = req.parse()?;
                updates.check_in_background(match body.trigger {
                    UpdateCheckTrigger::Manual => CheckTrigger::Manual,
                    UpdateCheckTrigger::Opened => CheckTrigger::Opened,
                    UpdateCheckTrigger::Woke => CheckTrigger::Woke,
                });
                Ok(state(&updates, 202))
            }
        }
    };
    let download = {
        let updates = updates.clone();
        move |_req: Request| {
            let updates = updates.clone();
            async move {
                updates.download_in_background();
                Ok(state(&updates, 202))
            }
        }
    };
    let restart = {
        let updates = updates.clone();
        move |req: Request| {
            let updates = updates.clone();
            async move {
                let body: UpdateRestartRequest = req.parse()?;
                if !updates.restart(body.when).await {
                    return Err(ApiError::Conflict("no update is ready to restart into".into()));
                }
                Ok(state(&updates, 202))
            }
        }
    };
    let later = {
        let updates = updates.clone();
        move |_req: Request| {
            let updates = updates.clone();
            async move {
                updates.later();
                Ok(state(&updates, 200))
            }
        }
    };
    let dismiss = {
        let updates = updates.clone();
        move |_req: Request| {
            let updates = updates.clone();
            async move {
                updates.dismiss_notice().await;
                Ok(state(&updates, 200))
            }
        }
    };
    let settings = {
        let (updates, config) = (updates.clone(), config.clone());
        move |req: Request| {
            let (updates, config) = (updates.clone(), config.clone());
            async move {
                let body: UpdateSettingsPatch = req.parse()?;
                let mut patch = serde_json::Map::new();
                if let Some(auto_download) = body.auto_download {
                    patch.insert("autoDownload".to_owned(), serde_json::Value::Bool(auto_download));
                }
                // Writes config.json: off the async threads.
                let written = tokio::task::spawn_blocking(move || config.patch("updates", patch).map(|_| ())).await;
                match written {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) => return Err(failed_to_write(&e)),
                    Err(e) => return Err(failed_to_write(&e)),
                }
                updates.settings_changed();
                Ok(state(&updates, 200))
            }
        }
    };
    vec![
        RouteDef::get(table::UPDATE.path, read).access(ACCESS),
        RouteDef::post(table::UPDATE_CHECK.path, check).access(ACCESS),
        RouteDef::post(table::UPDATE_DOWNLOAD.path, download).access(ACCESS),
        RouteDef::post(table::UPDATE_RESTART.path, restart).access(ACCESS),
        RouteDef::post(table::UPDATE_LATER.path, later).access(ACCESS),
        RouteDef::post(table::UPDATE_DISMISS.path, dismiss).access(ACCESS),
        RouteDef::put(table::SETTINGS_UPDATES.path, settings).access(ACCESS),
    ]
}

fn failed_to_write(cause: &dyn std::fmt::Display) -> ApiError {
    ApiError::Status { status: 500, message: format!("failed to write config: {cause}"), code: None }
}
