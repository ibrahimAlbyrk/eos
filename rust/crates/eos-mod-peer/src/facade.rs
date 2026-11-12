//! The host facade (`manager/peer/facade.ts`): `/h/<hostId>/<path>` on this
//! computer **is** that host's app.
//!
//! A view that controls another computer points its requests at this prefix,
//! so the page only ever talks to its own app — its images, frames and event
//! stream work exactly as for this computer — while each request rides the
//! secure link as one HTTP/2 stream. Answers stream back, so the event stream
//! and ranged reads behave as they do locally; a dropped link ends the event
//! stream and the dashboard's reconnect resumes it from its last event id.

use std::sync::Arc;

use eos_contracts::route_planes::is_peer_open_route;
use eos_core::net::peer::{ByteStream, HostLinks, LinkError, LinkRequest};
use eos_domain::peer::is_fingerprint;
use eos_runtime::access::Access;
use eos_runtime::http::{ApiError, Body, Method, Request, Response};
use eos_runtime::router::{Methods, RouteDef};

/// A transfer's chunk is the largest body the dashboard sends to a host.
const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;
/// How many pieces of an answer wait for a slow reader before the link is
/// held back.
const BODY_QUEUE: usize = 8;

/// The request headers a host's routes read; everything else is this
/// computer's own business (its token, its cookies, where the page lives).
const FORWARDED: &[&str] =
    &["content-type", "if-none-match", "last-event-id", "range", "sec-fetch-dest", "x-filename", "x-request-id"];

fn unreachable(code: &str) -> ApiError {
    ApiError::coded(503, "that computer is not reachable right now", code.to_owned())
}

/// Carries a link's answer body to the caller here. When the caller goes
/// away (a closed tab, a stream reconnect) the body is dropped, which cancels
/// the stream on the host.
fn stream_body(mut body: Box<dyn ByteStream>) -> Body {
    let (tx, out) = Body::channel(BODY_QUEUE);
    tokio::spawn(async move {
        loop {
            let chunk = tokio::select! {
                chunk = body.next() => chunk,
                () = tx.closed() => return,
            };
            match chunk {
                None => return,
                Some(Ok(chunk)) => {
                    if tx.send(chunk).await.is_err() {
                        return;
                    }
                }
                // The link dropped mid-answer: end ours too, or the page waits for ever.
                Some(Err(e)) => return tx.fail(e).await,
            }
        }
    });
    out
}

async fn forward(links: Arc<dyn HostLinks>, req: Request) -> Result<Response, ApiError> {
    let host_id = match req.param("id") {
        Some(id) if is_fingerprint(id) => id.to_owned(),
        _ => return Ok(crate::no_route(req.path())),
    };
    if links.get(&host_id).is_none() {
        return Err(ApiError::coded(404, "unknown computer", "unknown-host"));
    }
    let rest = format!("/{}", req.param("rest").unwrap_or_default());
    // Pairing and tunnels belong to the link itself: no caller here may speak them.
    if rest.starts_with("/peer/") {
        return Err(ApiError::NotFound("not an API route".into()));
    }
    // Any page in this window can reach this route; only the user's dashboard
    // (or that host's own view) may act on another computer through it.
    let human = req.caller.is_human_for_host(&host_id);
    if !human && !is_peer_open_route(req.method.as_str(), &rest) {
        return Err(ApiError::coded(403, "only the Eos window can do this on another computer", "needs-human"));
    }
    let target = if req.query().is_empty() { rest } else { format!("{rest}?{}", req.query().raw()) };
    let headers = FORWARDED
        .iter()
        .filter_map(|name| req.headers.get(name).map(|value| ((*name).to_owned(), value.to_owned())))
        .collect();
    let request =
        LinkRequest { method: req.method.as_str().to_owned(), target, headers, body: req.body.clone(), human };
    let answer = links.forward(&host_id, request).await.map_err(|e| match e {
        LinkError::UnknownHost => ApiError::coded(404, "unknown computer", "unknown-host"),
        LinkError::Unavailable { code } => unreachable(&code),
        LinkError::Failed(reason) => {
            ApiError::coded(502, format!("link to that computer failed: {reason}"), "unreachable")
        }
    })?;
    let mut response = Response::new(answer.status);
    for (name, value) in answer.headers {
        response = response.header(name, value);
    }
    Ok(response.body(stream_body(answer.body)))
}

/// A HEAD is answered without a body, whatever the answer is.
async fn answer(links: Arc<dyn HostLinks>, req: Request) -> Result<Response, ApiError> {
    let head = req.method == Method::Head;
    let response = forward(links, req).await.unwrap_or_else(ApiError::into_response);
    Ok(if head { response.body(Body::Empty) } else { response })
}

/// The facade's routes: the same on the app's router and on the raw-content
/// origin's. Local only by nature — a paired computer never reaches another
/// one through this computer.
pub fn routes(links: Arc<dyn HostLinks>) -> Vec<RouteDef> {
    let mut routes = Vec::new();
    for method in [Method::Get, Method::Post, Method::Put, Method::Delete, Method::Head] {
        for pattern in ["/h/{id}", "/h/{id}/", "/h/{id}/{*rest}"] {
            let links = links.clone();
            routes.push(
                RouteDef::new(Methods::One(method), pattern, move |req: Request| answer(links.clone(), req))
                    .access(Access::open().local_only())
                    .max_body(MAX_BODY_BYTES),
            );
        }
    }
    routes
}
