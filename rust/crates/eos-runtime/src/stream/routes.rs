//! `GET /stream` and `POST /stream/focus`.

use serde::{Deserialize, Serialize};

use super::{AttachOptions, StreamFocus, StreamHub};
use crate::access::Access;
use crate::http::{ApiError, Request, Response};
use crate::live_text::{LiveBlock, LiveText};
use crate::router::RouteDef;

/// The body of `POST /stream/focus`. The wire shape is `eos-contracts`'
/// `StreamFocusRequest`; it lives here until that type exists.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FocusRequest {
    client_id: String,
    workers: Vec<String>,
    ptys: Vec<String>,
}

#[derive(Serialize)]
struct FocusResponse {
    live: Vec<LiveBlock>,
}

const MAX_CLIENT_ID_CHARS: usize = 128;
const MAX_FOCUS_ITEMS: usize = 64;

fn check_focus(body: &FocusRequest) -> Result<(), ApiError> {
    let mut issues = Vec::new();
    let id_chars = body.client_id.chars().count();
    if id_chars == 0 {
        issues.push(("clientId", "String must contain at least 1 character(s)"));
    } else if id_chars > MAX_CLIENT_ID_CHARS {
        issues.push(("clientId", "String must contain at most 128 character(s)"));
    }
    for (field, list) in [("workers", &body.workers), ("ptys", &body.ptys)] {
        if list.len() > MAX_FOCUS_ITEMS {
            issues.push((field, "Array must contain at most 64 element(s)"));
        }
    }
    if issues.is_empty() { Ok(()) } else { Err(ApiError::invalid(issues)) }
}

/// The stream's two routes. Any local page may open the stream and a paired
/// computer's dashboard may; the phone has its own channel and is refused.
pub fn routes(hub: StreamHub, live: LiveText) -> Vec<RouteDef> {
    let stream = hub.clone();
    let open = move |req: Request| {
        let hub = stream.clone();
        async move {
            let query = req.query();
            // Resume point: our own reconnect passes ?since; a native
            // EventSource retry sends Last-Event-ID.
            let since = query
                .get("since")
                .map(|s| s.into_owned())
                .or_else(|| req.headers.get("last-event-id").map(str::to_owned));
            let topics = query.has("topics").then(|| query.list("topics"));
            // ?focus= (even empty) = the tab says what it has on screen;
            // POST /stream/focus keeps it current.
            let focus =
                query.has("focus").then(|| StreamFocus { workers: query.list("focus"), ptys: query.list("ptys") });
            let client_id = query.get("clientId").map(|c| c.into_owned());
            let attached = hub.attach(AttachOptions { since, topics, client_id, focus });
            let body = attached.map_err(|e| ApiError::status_with(503, e.to_string()))?;
            Ok(Response::new(200)
                .header("content-type", "text/event-stream")
                .header("cache-control", "no-cache, no-transform")
                .header("x-accel-buffering", "no")
                .body(body))
        }
    };
    // What a tab has on screen changed. The answer seeds the panes that just
    // came into view with the text their workers already streamed.
    let focus = move |req: Request| {
        let (hub, live) = (hub.clone(), live.clone());
        async move {
            let body: FocusRequest = req.json()?;
            check_focus(&body)?;
            let client_id = body.client_id;
            let focus = StreamFocus { workers: body.workers, ptys: body.ptys };
            hub.set_focus(&client_id, &focus);
            let live = focus.workers.iter().flat_map(|id| live.blocks_for(id)).collect();
            Ok(Response::json(200, &FocusResponse { live }))
        }
    };
    vec![
        RouteDef::get("/stream", open).access(Access::open()),
        RouteDef::post("/stream/focus", focus).access(Access::open()),
    ]
}
