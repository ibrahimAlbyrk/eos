//! The routes over one delivery: read it, stop it in its hold, take it back,
//! say it was wrong, or try a failed one again (03 §6).

use std::sync::Arc;

use eos_contracts::{Delivery, RetryRequest, UndoAnswer};
use eos_core::store::StoredDelivery;
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use serde_json::Value;

use super::{answered, answered_by, item_id, refused};
use crate::Shared;

/// A delivery as the dashboard reads it; the receipt shows only where the
/// user sees what went out.
pub(super) fn delivery(row: StoredDelivery) -> Result<Delivery, ApiError> {
    let body = serde_json::from_str(&row.body).map_err(|e| eos_core::Error::storage(e.to_string()))?;
    let receipt = row.receipt.as_deref().and_then(|text| serde_json::from_str::<Value>(text).ok());
    Ok(Delivery {
        id: row.id,
        item_id: row.item_id,
        run_id: row.run_id,
        routine_id: row.routine_id,
        channel: row.channel,
        action: row.action,
        target_ref: row.target_ref,
        class: row.class,
        mode: row.mode,
        state: row.state,
        body,
        send_at: row.send_at,
        attempts: row.attempts,
        last_error_kind: row.last_error_kind,
        receipt_url: receipt.and_then(|receipt| receipt["url"].as_str().map(str::to_owned)),
        sent_at: row.sent_at,
        undo_until: row.undo_until,
        undone_at: row.undone_at,
        approved_at: row.approved_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

/// The row as a write left it, or the 409 that says why it did not.
fn moved(result: Result<StoredDelivery, eos_inbox::Error>) -> Result<Response, ApiError> {
    match result {
        Ok(row) => Ok(Response::json(200, &delivery(row)?)),
        Err(error) => refused(error),
    }
}

pub(super) fn all(shared: &Arc<Shared>) -> Vec<RouteDef> {
    let at = shared.clone();
    let read = RouteDef::get("/api/inbox/deliveries/{id}", move |req: Request| {
        let at = at.clone();
        async move {
            let id = item_id(&req);
            let lookup = id.clone();
            let row = at.store.read(move |tx| tx.inbox_deliveries().find(&lookup)).await?;
            let row = row.ok_or_else(|| eos_core::Error::not_found("delivery", &id))?;
            Ok(Response::json(200, &delivery(row)?))
        }
    });
    let at = shared.clone();
    let stop = RouteDef::post("/api/inbox/deliveries/{id}/stop", move |req: Request| {
        let at = at.clone();
        async move { moved(at.items.stop_delivery(&item_id(&req)).await) }
    });
    let at = shared.clone();
    let undo = RouteDef::post("/api/inbox/deliveries/{id}/undo", move |req: Request| {
        let at = at.clone();
        async move {
            let undone = at.items.undo(&item_id(&req)).await;
            answered(undone, |partial| {
                let answer =
                    UndoAnswer { state: eos_inbox::delivery::UNDONE.to_owned(), partial: partial.then_some(true) };
                Response::json(200, &answer)
            })
        }
    });
    let at = shared.clone();
    let wrong = RouteDef::post("/api/inbox/deliveries/{id}/wrong", move |req: Request| {
        let at = at.clone();
        async move { moved(at.items.wrong(&item_id(&req)).await) }
    });
    let at = shared.clone();
    let retry = RouteDef::post("/api/inbox/deliveries/{id}/retry", move |req: Request| {
        let at = at.clone();
        async move {
            let body: RetryRequest = req.parse()?;
            moved(at.items.retry(&item_id(&req), body.doc, answered_by(&req.caller)).await)
        }
    });
    let user = |tier| Access::ui_token().phone_user(tier);
    vec![
        read.access(user(Tier::Read)),
        stop.access(user(Tier::Low)),
        undo.access(user(Tier::High)),
        retry.access(user(Tier::High)),
        wrong.access(user(Tier::Low)),
    ]
}
