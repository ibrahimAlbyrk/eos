//! Settings › Eos › Privacy (04 G37): `POST /api/memory/forget-all`
//! forgets every note Eos learned (the tombstones sync, so the other Macs
//! forget too) and clears what was captured; `{undo: true}` brings the
//! notes back for 30 days. `GET /api/memory/export` answers every live note
//! with its evidence. Both stay on this computer.

use std::sync::Arc;

use eos_contracts::{ForgetAllAnswer, ForgetAllRequest};
use eos_memory::forget::{Restored, forget_all_in, undo_forget_all_in};
use eos_runtime::access::Access;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use serde_json::json;

use super::Api;

async fn forget_all(api: Arc<Api>, body: ForgetAllRequest) -> Result<Response, ApiError> {
    let (now, device) = (api.clock.now_ms(), api.device.clone());
    if body.undo {
        let undone = api.store.write(move |tx, out| undo_forget_all_in(tx, out, &device, now)).await?;
        return match undone {
            Ok(restored) => {
                tracing::info!(restored, "memory: forgetting everything was undone");
                Ok(Response::json(200, &ForgetAllAnswer { restored: Some(restored as i64), ..Default::default() }))
            }
            Err(Restored::TooLate) => Ok(Response::json(409, &json!({ "error": "too_late" }))),
            Err(_) => Err(ApiError::NotFound("nothing was forgotten all at once".into())),
        };
    }
    if !body.confirm {
        return Err(ApiError::status_with(400, "confirm: Required"));
    }
    let forgotten = api.store.write(move |tx, out| forget_all_in(tx, out, now)).await?;
    tracing::info!(forgotten, "memory: everything learned was forgotten");
    Ok(Response::json(200, &ForgetAllAnswer { forgotten: Some(forgotten as i64), ..Default::default() }))
}

pub(super) fn all(api: &Arc<Api>) -> Vec<RouteDef> {
    let at = api.clone();
    let forget = RouteDef::post("/api/memory/forget-all", move |req: Request| {
        let at = at.clone();
        async move {
            let body: ForgetAllRequest = req.parse()?;
            forget_all(at, body).await
        }
    });
    let at = api.clone();
    let export = RouteDef::get("/api/memory/export", move |_req: Request| {
        let at = at.clone();
        async move {
            let now = at.clock.now_ms();
            let export = at.store.read(move |tx| eos_memory::export::export_in(tx, now)).await?;
            tracing::info!(notes = export.notes.len(), "memory: exported");
            Ok(Response::json(200, &export))
        }
    });
    let user = Access::ui_token().local_only();
    vec![forget.access(user), export.access(user)]
}
