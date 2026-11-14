//! File transfer routes:
//!
//! - `/transfer/*`: this computer's disk as an endpoint. The Transfer tab
//!   lists through it, and a paired computer's engine moves bytes with it.
//!   The user's only: from another computer it is that computer's dashboard,
//!   vouched for by the link.
//! - `/api/transfers…`: this computer's engine. The user's, and local-only:
//!   another computer may not start, watch or steer it.
//! - `/workers/{id}/transfers…`: a focused agent's send. Local-only, and
//!   fenced by the engine (this computer → `~/Downloads/Eos` there, nothing
//!   replaced).

use std::sync::Arc;

use eos_contracts::{
    AgentTransferRequest, TRANSFER_MAX_CHUNK, TransferAbortRequest, TransferCommitRequest, TransferDecideRequest,
    TransferDestinationRequest, TransferErrorBody, TransferKeyRequest, TransferKeyResponse, TransferListResponse,
    TransferLocateRequest, TransferLocateResponse, TransferOrigin, TransferOriginKind, TransferPrepareRequest,
    TransferScanRequest, TransferStartRequest, routes,
};
use eos_core::net::transfer::{ByteRange, FileStamp, TransferEndpoint, WriteAt};
use eos_domain::text::js_trim;
use eos_domain::transfer::{TransferError, check_absolute};
use eos_runtime::access::Access;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use serde_json::json;

use crate::{AgentTransferError, TransferService};

/// A manifest of the most items a transfer may have, with room to spare.
const MANIFEST_BODY_BYTES: usize = 48 * 1024 * 1024;

/// Crosses to a paired computer (as its user); the body of the refusal is
/// the transfer routes' own, so the rule is checked in the handler.
const ENDPOINT: Access = Access::open();
const ENGINE: Access = Access::open().local_only();

fn user(req: &Request) -> Result<(), ApiError> {
    if req.speaks_for_user() { Ok(()) } else { Err(ApiError::coded(403, "ui token required", "forbidden")) }
}

/// A refusal as `{error, code, have?}` with the code's status; a failure
/// without a code is a plain 500.
fn refused(e: TransferError) -> Result<Response, ApiError> {
    let Some(code) = e.code else { return Err(ApiError::Internal(e.message)) };
    let have = e.have.and_then(|have| i64::try_from(have).ok());
    Ok(Response::json(e.status(), &TransferErrorBody { error: e.message, code, have }))
}

fn answer<T: serde::Serialize>(status: u16, result: Result<T, TransferError>) -> Result<Response, ApiError> {
    match result {
        Ok(value) => Ok(Response::json(status, &value)),
        Err(e) => refused(e),
    }
}

fn agent_answer<T: serde::Serialize>(status: u16, result: Result<T, AgentTransferError>) -> Result<Response, ApiError> {
    match result {
        Ok(value) => Ok(Response::json(status, &value)),
        Err(AgentTransferError::Transfer(e)) => refused(e),
        Err(AgentTransferError::Refused(e)) => Err(e.into()),
        Err(e @ AgentTransferError::NotFocused) => Err(ApiError::PermissionDenied(e.to_string())),
        Err(e @ AgentTransferError::NotYours) => Err(ApiError::NotFound(e.to_string())),
    }
}

/// A query number as `Number(v)` reads a safe integer; `None` for anything else.
fn int(req: &Request, name: &str) -> Option<u64> {
    let Some(text) = req.query().get(name) else { return Some(0) };
    let number: f64 = if text.trim().is_empty() { 0.0 } else { text.trim().parse().ok()? };
    (number >= 0.0 && number.fract() == 0.0 && number <= 9_007_199_254_740_991.0).then_some(number as u64)
}

fn text(req: &Request, name: &str) -> String {
    req.query().get(name).map(|value| value.into_owned()).unwrap_or_default()
}

fn endpoint_routes(ep: &Arc<dyn TransferEndpoint>) -> Vec<RouteDef> {
    let e = ep.clone();
    let list = RouteDef::get(routes::TRANSFER_LIST.path, move |req: Request| {
        let ep = e.clone();
        async move {
            user(&req)?;
            let path = match text(&req, "path") {
                path if path.is_empty() => match ep.home().await {
                    Ok(home) => home,
                    Err(e) => return refused(e),
                },
                path => path,
            };
            answer(200, ep.list(&path, text(&req, "hidden") == "1").await)
        }
    });

    let e = ep.clone();
    let scan = RouteDef::post(routes::TRANSFER_SCAN.path, move |req: Request| {
        let ep = e.clone();
        async move {
            user(&req)?;
            let body: TransferScanRequest = req.parse()?;
            answer(200, ep.scan(&body.paths).await)
        }
    });

    let e = ep.clone();
    let read = RouteDef::get(routes::TRANSFER_READ.path, move |req: Request| {
        let ep = e.clone();
        async move {
            user(&req)?;
            let path = text(&req, "path");
            let mtime_ms = match req.query().get("mtime") {
                Some(mtime) if !mtime.trim().is_empty() => mtime.trim().parse().unwrap_or(f64::NAN),
                _ => 0.0,
            };
            let (Some(offset), Some(length), Some(size)) =
                (int(&req, "offset"), int(&req, "length"), int(&req, "size"))
            else {
                return refused(match check_absolute(&path) {
                    Err(e) => e,
                    Ok(()) => {
                        TransferError::new(eos_contracts::TransferErrorCode::BadPath, "that range is outside the file")
                    }
                });
            };
            match ep.read(&path, ByteRange { offset, length }, FileStamp { size, mtime_ms }).await {
                Ok(bytes) => Ok(Response::bytes(200, "application/octet-stream", bytes)),
                Err(e) => refused(e),
            }
        }
    });

    let e = ep.clone();
    let write = RouteDef::put(routes::TRANSFER_WRITE.path, move |req: Request| {
        let ep = e.clone();
        async move {
            user(&req)?;
            let at = WriteAt {
                id: text(&req, "id"),
                dest_dir: text(&req, "dest"),
                rel: text(&req, "rel"),
                // An offset that is not a number can never be the staged size.
                offset: int(&req, "offset").unwrap_or(u64::MAX),
            };
            answer(200, ep.write(&at, req.body.clone()).await.map(|size| json!({ "size": size })))
        }
    })
    .max_body(TRANSFER_MAX_CHUNK as usize);

    let e = ep.clone();
    let prepare = RouteDef::post(routes::TRANSFER_PREPARE.path, move |req: Request| {
        let ep = e.clone();
        async move {
            user(&req)?;
            let body: TransferPrepareRequest = req.parse()?;
            answer(200, ep.prepare(&body).await)
        }
    })
    .max_body(MANIFEST_BODY_BYTES);

    let e = ep.clone();
    let commit = RouteDef::post(routes::TRANSFER_COMMIT.path, move |req: Request| {
        let ep = e.clone();
        async move {
            user(&req)?;
            let body: TransferCommitRequest = req.parse()?;
            answer(200, ep.commit(&body).await)
        }
    });

    let e = ep.clone();
    let abort = RouteDef::post(routes::TRANSFER_ABORT.path, move |req: Request| {
        let ep = e.clone();
        async move {
            user(&req)?;
            let body: TransferAbortRequest = req.parse()?;
            answer(200, ep.abort(&body.id.0, &body.dest_dir).await.map(|()| json!({ "ok": true })))
        }
    });

    let e = ep.clone();
    let key = RouteDef::post(routes::TRANSFER_KEY.path, move |req: Request| {
        let ep = e.clone();
        async move {
            user(&req)?;
            let body: TransferKeyRequest = req.parse()?;
            answer(200, ep.project_key(&body.path).await.map(|key| TransferKeyResponse { key }))
        }
    });

    let e = ep.clone();
    let locate = RouteDef::post(routes::TRANSFER_LOCATE.path, move |req: Request| {
        let ep = e.clone();
        async move {
            user(&req)?;
            let body: TransferLocateRequest = req.parse()?;
            answer(200, ep.locate(&body.key).await.map(|path| TransferLocateResponse { path }))
        }
    });

    [list, scan, read, write, prepare, commit, abort, key, locate]
        .into_iter()
        .map(|route| route.access(ENDPOINT))
        .collect()
}

fn engine_routes(service: &Arc<TransferService>) -> Vec<RouteDef> {
    let s = service.clone();
    let list = RouteDef::get(routes::TRANSFERS.path, move |req: Request| {
        let service = s.clone();
        async move {
            user(&req)?;
            Ok(Response::json(200, &TransferListResponse { transfers: service.list().await? }))
        }
    });

    let s = service.clone();
    let start = RouteDef::post(routes::TRANSFERS.path, move |req: Request| {
        let service = s.clone();
        async move {
            user(&req)?;
            let body: TransferStartRequest = req.parse()?;
            let origin = TransferOrigin { kind: TransferOriginKind::User, agent_id: None, agent_name: None };
            agent_answer(201, service.start_transfer(body, origin).await)
        }
    });

    let s = service.clone();
    let clear = RouteDef::delete(routes::TRANSFERS.path, move |req: Request| {
        let service = s.clone();
        async move {
            user(&req)?;
            Ok(Response::json(200, &json!({ "removed": service.clear_finished().await? })))
        }
    });

    let s = service.clone();
    let destination = RouteDef::post(routes::TRANSFER_DESTINATION.path, move |req: Request| {
        let service = s.clone();
        async move {
            user(&req)?;
            let body: TransferDestinationRequest = req.parse()?;
            answer(200, service.destination(&body.from, &body.to, &body.paths).await)
        }
    });

    let id_of = |req: &Request| req.param("id").unwrap_or_default().to_owned();
    let s = service.clone();
    let pause = RouteDef::post(routes::TRANSFER_PAUSE.path, move |req: Request| {
        let service = s.clone();
        async move {
            user(&req)?;
            Ok(Response::json(200, &service.pause(&id_of(&req)).await?))
        }
    });
    let s = service.clone();
    let resume = RouteDef::post(routes::TRANSFER_RESUME.path, move |req: Request| {
        let service = s.clone();
        async move {
            user(&req)?;
            Ok(Response::json(200, &service.resume(&id_of(&req)).await?))
        }
    });
    let s = service.clone();
    let cancel = RouteDef::post(routes::TRANSFER_CANCEL.path, move |req: Request| {
        let service = s.clone();
        async move {
            user(&req)?;
            Ok(Response::json(200, &service.cancel(&id_of(&req)).await?))
        }
    });
    let s = service.clone();
    let decide = RouteDef::post(routes::TRANSFER_DECIDE.path, move |req: Request| {
        let service = s.clone();
        async move {
            user(&req)?;
            let body: TransferDecideRequest = req.parse()?;
            Ok(Response::json(200, &service.decide(&id_of(&req), body.decisions).await?))
        }
    });

    [list, start, clear, destination, pause, resume, cancel, decide]
        .into_iter()
        .map(|route| route.access(ENGINE))
        .collect()
}

/// The agent asking is the one in the path. Declared, not proven: what it may
/// do is fenced by the engine, which also checks that it is a focused session.
fn agent_of(req: &Request) -> Result<String, AgentTransferError> {
    let id = req.param("id").unwrap_or_default();
    match req.headers.get("x-eos-agent-id").map(js_trim) {
        Some(caller) if !caller.is_empty() && caller == id => Ok(id.to_owned()),
        _ => Err(AgentTransferError::NotFocused),
    }
}

fn agent_routes(service: &Arc<TransferService>) -> Vec<RouteDef> {
    let s = service.clone();
    let send = RouteDef::post(routes::WORKER_TRANSFERS.path, move |req: Request| {
        let service = s.clone();
        async move {
            let agent = match agent_of(&req) {
                Ok(agent) => agent,
                Err(e) => return agent_answer::<()>(201, Err(e)),
            };
            // Who may ask is settled before what is asked.
            let (name, cwd) = match service.focused(&agent).await {
                Ok(focused) => focused,
                Err(e) => return agent_answer::<()>(201, Err(e)),
            };
            let body: AgentTransferRequest = req.parse()?;
            agent_answer(201, service.send_for_agent(&agent, &name, cwd.as_deref(), body).await)
        }
    });

    let s = service.clone();
    let poll = RouteDef::get(routes::WORKER_TRANSFER.path, move |req: Request| {
        let service = s.clone();
        async move {
            let result = match agent_of(&req) {
                Ok(agent) => service.poll(&agent, req.param("transferId").unwrap_or_default()).await,
                Err(e) => Err(e),
            };
            agent_answer(200, result)
        }
    });

    vec![send.access(ENGINE), poll.access(ENGINE)]
}

pub(crate) fn all(endpoint: &Arc<dyn TransferEndpoint>, service: &Arc<TransferService>) -> Vec<RouteDef> {
    let mut all = endpoint_routes(endpoint);
    all.extend(engine_routes(service));
    all.extend(agent_routes(service));
    all
}
