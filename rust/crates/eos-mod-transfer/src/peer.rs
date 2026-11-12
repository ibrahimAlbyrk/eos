//! A paired computer's disk as a transfer endpoint
//! (`manager/modules/transfer/PeerEndpoint.ts`): each call is one request on
//! the link to that computer's `/transfer/*` routes, sent as the user of
//! this one.

use std::sync::Arc;

use bytes::Bytes;
use eos_contracts::{
    HostInfo, Num, TransferCommitRequest, TransferCommitResult, TransferErrorBody, TransferErrorCode as Code,
    TransferKeyResponse, TransferListing, TransferLocateResponse, TransferManifest, TransferPrepareRequest,
    TransferPrepareResult, Validate, routes,
};
use eos_core::BoxFuture;
use eos_core::net::machines::{Machines, PeerRequest};
use eos_core::net::transfer::{ByteRange, FileStamp, TransferEndpoint, WriteAt};
use eos_domain::transfer::TransferError;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

/// Long enough to ride out a network switch; the engine retries past it.
const READY_MS: u64 = 15_000;
/// A chunk is sized to about a second; this only catches a request that went silent.
const REQUEST_MS: u64 = 120_000;

pub struct PeerEndpoint {
    machines: Arc<dyn Machines>,
    host_id: String,
}

impl std::fmt::Debug for PeerEndpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PeerEndpoint").field("host_id", &self.host_id).finish_non_exhaustive()
    }
}

fn query(pairs: &[(&str, &str)]) -> String {
    url::form_urlencoded::Serializer::new(String::new()).extend_pairs(pairs).finish()
}

fn unreachable(message: impl Into<String>) -> TransferError {
    TransferError::new(Code::Unreachable, message)
}

/// What a refusal from the other computer means here.
fn error_from(status: u16, body: &[u8]) -> TransferError {
    let known =
        serde_json::from_slice::<Value>(body).ok().and_then(|v| eos_contracts::parse::<TransferErrorBody>(&v).ok());
    if let Some(known) = known {
        let have = known.have.and_then(|have| u64::try_from(have).ok());
        return TransferError { code: Some(known.code), message: known.error, have };
    }
    match status {
        // No /transfer/* there at all: an Eos from before file transfer.
        404 => TransferError::new(Code::NeedsUpdate, "Eos on that computer is too old to send files — update it"),
        403 => TransferError::new(Code::Forbidden, "that computer refused the transfer"),
        _ => unreachable(format!("the other computer answered {status}")),
    }
}

impl PeerEndpoint {
    pub fn new(machines: Arc<dyn Machines>, host_id: impl Into<String>) -> Self {
        Self { machines, host_id: host_id.into() }
    }

    async fn call(
        &self,
        method: &'static str,
        target: String,
        content_type: Option<&'static str>,
        body: Bytes,
    ) -> Result<Bytes, TransferError> {
        let request = PeerRequest { method, target, content_type, body, ready_ms: READY_MS, timeout_ms: REQUEST_MS };
        let response = self.machines.call(&self.host_id, request).await.map_err(|e| unreachable(e.to_string()))?;
        if (200..300).contains(&response.status) {
            Ok(response.body)
        } else {
            Err(error_from(response.status, &response.body))
        }
    }

    async fn json<T: DeserializeOwned + Validate>(
        &self,
        method: &'static str,
        target: String,
        body: Option<&(impl Serialize + Sync)>,
    ) -> Result<T, TransferError> {
        let (content_type, payload) = match body {
            Some(body) => {
                (Some("application/json"), Bytes::from(serde_json::to_vec(body).map_err(TransferError::failed)?))
            }
            None => (None, Bytes::new()),
        };
        let raw = self.call(method, target, content_type, payload).await?;
        let value: Value =
            if raw.is_empty() { Value::Null } else { serde_json::from_slice(&raw).unwrap_or(Value::Null) };
        eos_contracts::parse(&value).map_err(|_| {
            let message = "the other computer answered in a format this Eos doesn't know — update both";
            TransferError::new(Code::NeedsUpdate, message)
        })
    }
}

const NO_BODY: Option<&Value> = None;

impl TransferEndpoint for PeerEndpoint {
    fn list<'a>(&'a self, dir: &'a str, hidden: bool) -> BoxFuture<'a, Result<TransferListing, TransferError>> {
        let mut pairs = vec![("path", dir)];
        if hidden {
            pairs.push(("hidden", "1"));
        }
        let target = format!("{}?{}", routes::TRANSFER_LIST.path, query(&pairs));
        Box::pin(self.json("GET", target, NO_BODY))
    }

    fn scan<'a>(&'a self, paths: &'a [String]) -> BoxFuture<'a, Result<TransferManifest, TransferError>> {
        Box::pin(async move {
            self.json("POST", routes::TRANSFER_SCAN.path.to_owned(), Some(&json!({ "paths": paths }))).await
        })
    }

    fn read<'a>(
        &'a self,
        path: &'a str,
        range: ByteRange,
        expect: FileStamp,
    ) -> BoxFuture<'a, Result<Bytes, TransferError>> {
        let (offset, length) = (range.offset.to_string(), range.length.to_string());
        let (size, mtime) = (expect.size.to_string(), Num(expect.mtime_ms).to_string());
        let pairs = [("path", path), ("offset", &offset), ("length", &length), ("size", &size), ("mtime", &mtime)];
        let target = format!("{}?{}", routes::TRANSFER_READ.path, query(&pairs));
        Box::pin(self.call("GET", target, None, Bytes::new()))
    }

    fn prepare<'a>(
        &'a self,
        request: &'a TransferPrepareRequest,
    ) -> BoxFuture<'a, Result<TransferPrepareResult, TransferError>> {
        Box::pin(self.json("POST", routes::TRANSFER_PREPARE.path.to_owned(), Some(request)))
    }

    fn write<'a>(&'a self, at: &'a WriteAt, data: Bytes) -> BoxFuture<'a, Result<u64, TransferError>> {
        let offset = at.offset.to_string();
        let pairs = [("id", at.id.as_str()), ("dest", &at.dest_dir), ("rel", &at.rel), ("offset", &offset)];
        let target = format!("{}?{}", routes::TRANSFER_WRITE.path, query(&pairs));
        Box::pin(async move {
            let raw = self.call("PUT", target, Some("application/octet-stream"), data).await?;
            let size = serde_json::from_slice::<Value>(&raw).ok().and_then(|body| body.get("size")?.as_u64());
            size.ok_or_else(|| unreachable("unexpected answer from the other computer"))
        })
    }

    fn commit<'a>(
        &'a self,
        request: &'a TransferCommitRequest,
    ) -> BoxFuture<'a, Result<TransferCommitResult, TransferError>> {
        Box::pin(self.json("POST", routes::TRANSFER_COMMIT.path.to_owned(), Some(request)))
    }

    fn abort<'a>(&'a self, id: &'a str, dest_dir: &'a str) -> BoxFuture<'a, Result<(), TransferError>> {
        Box::pin(async move {
            let body = Bytes::from(json!({ "id": id, "destDir": dest_dir }).to_string());
            self.call("POST", routes::TRANSFER_ABORT.path.to_owned(), Some("application/json"), body).await.map(drop)
        })
    }

    fn project_key<'a>(&'a self, dir: &'a str) -> BoxFuture<'a, Result<Option<String>, TransferError>> {
        Box::pin(async move {
            let target = routes::TRANSFER_KEY.path.to_owned();
            Ok(self.json::<TransferKeyResponse>("POST", target, Some(&json!({ "path": dir }))).await?.key)
        })
    }

    fn locate<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Option<String>, TransferError>> {
        Box::pin(async move {
            let target = routes::TRANSFER_LOCATE.path.to_owned();
            Ok(self.json::<TransferLocateResponse>("POST", target, Some(&json!({ "key": key }))).await?.path)
        })
    }

    /// The other computer's home as its link last reported it, else asked of it.
    fn home(&self) -> BoxFuture<'_, Result<String, TransferError>> {
        Box::pin(async move {
            if let Some(info) = self.machines.get(&self.host_id).and_then(|host| host.info) {
                return Ok(info.home);
            }
            Ok(self.json::<HostInfo>("GET", routes::HOST_INFO.path.to_owned(), NO_BODY).await?.home)
        })
    }
}
