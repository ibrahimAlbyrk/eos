//! The relay's sync vault, in memory: the same store rules and the same HTTP
//! answers as `relay/vault/VaultStore.ts` and `relay/vault/routes.ts`, so the
//! sync code is tested against what the real relay does without a network.
//!
//! - [`FakeVault`]: the store (`authorize`, `changes`, `put`) and the routes
//!   ([`FakeVault::handle`]).
//! - [`FakeVault::serve`]: the routes on a loopback port, for the HTTP client.
//! - [`FakeVault::client`]: the vault as the sync engine's port, in process,
//!   with faults a test can inject.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, STANDARD};
use eos_core::net::sync::{PutOutcome, SyncVault, VaultChanges, VaultEntry};
use eos_core::{BoxFuture, Error};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Notify;

/// The relay's limits (`relay/config.ts`: 16 vaults, 256 MiB each, 8 MiB a blob).
#[derive(Debug, Clone, Copy)]
pub struct VaultLimits {
    pub max_vaults: usize,
    pub max_vault_bytes: usize,
    pub max_blob_bytes: usize,
}

impl Default for VaultLimits {
    fn default() -> Self {
        Self { max_vaults: 16, max_vault_bytes: 256 * 1024 * 1024, max_blob_bytes: 8 * 1024 * 1024 }
    }
}

/// A page stops early past this many blob bytes (always at least one entry).
const PAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_WAIT_S: u64 = 25;
const DEFAULT_LIMIT: u64 = 100;
const MAX_LIMIT: u64 = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Authorized {
    Ok,
    Forbidden,
    Full,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StorePut {
    Stored {
        seq: u64,
    },
    /// The base was stale; `entry` is what the key holds (`None`: the vault
    /// never saw the key).
    Conflict {
        entry: Option<VaultEntry>,
    },
    Quota,
}

#[derive(Default)]
struct Vault {
    auth_hash: [u8; 32],
    head_seq: u64,
    bytes: usize,
    /// key → (seq, data)
    records: HashMap<String, (u64, Vec<u8>)>,
    /// seq → key, for paging in order.
    by_seq: BTreeMap<u64, String>,
}

#[derive(Default)]
struct Parked {
    wake: Arc<Notify>,
    waiting: usize,
}

pub struct FakeVault {
    limits: VaultLimits,
    vaults: Mutex<HashMap<String, Vault>>,
    parked: Mutex<HashMap<String, Parked>>,
}

impl std::fmt::Debug for FakeVault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FakeVault").field("limits", &self.limits).finish_non_exhaustive()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What a route answers: status, extra headers, JSON body.
#[derive(Debug, Clone, PartialEq)]
pub struct VaultResponse {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Value,
}

impl VaultResponse {
    fn new(status: u16, body: Value) -> Self {
        Self { status, headers: Vec::new(), body }
    }

    fn error(status: u16, message: &str) -> Self {
        Self::new(status, json!({ "error": message }))
    }
}

/// A request as the routes see it.
#[derive(Debug, Clone, Default)]
pub struct VaultRequest<'a> {
    pub method: &'a str,
    /// Path and query.
    pub target: &'a str,
    pub authorization: Option<&'a str>,
    pub content_length: Option<usize>,
    pub body: &'a [u8],
}

/// Node's `Buffer.from(text, "base64")` accepts loose trailing bits.
const LENIENT: GeneralPurpose =
    GeneralPurpose::new(&base64::alphabet::STANDARD, GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true));

fn is_hex(text: &str, len: usize) -> bool {
    text.len() == len && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `^Bearer ([A-Za-z0-9_-]{16,128})$`
fn bearer(header: Option<&str>) -> Option<&str> {
    let token = header?.strip_prefix("Bearer ")?;
    let ok =
        (16..=128).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    ok.then_some(token)
}

/// `^[A-Za-z0-9+/]*={0,2}$`, in whole quartets.
fn is_base64(text: &str) -> bool {
    let body = text.trim_end_matches('=');
    text.len().is_multiple_of(4)
        && text.len() - body.len() <= 2
        && body.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

/// A query number as `Number(v)` reads it: a non-negative safe integer, the
/// fallback when absent or empty, `None` when it is anything else.
fn int_param(value: Option<&str>, fallback: u64) -> Option<u64> {
    let Some(text) = value.filter(|v| !v.is_empty()) else { return Some(fallback) };
    let number: f64 = text.trim().parse().ok()?;
    (number >= 0.0 && number.fract() == 0.0 && number <= 9_007_199_254_740_991.0).then_some(number as u64)
}

fn query(target: &str) -> (&str, HashMap<String, String>) {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let pairs = query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (key.to_owned(), value.to_owned())
        })
        .collect();
    (path, pairs)
}

fn wire(entry: &VaultEntry) -> Value {
    json!({ "key": entry.key, "seq": entry.seq, "data": STANDARD.encode(&entry.data) })
}

/// Counts a parked long-poll for as long as it waits, also when the caller
/// goes away.
struct ParkedGuard<'a> {
    vault: &'a FakeVault,
    id: &'a str,
}

impl Drop for ParkedGuard<'_> {
    fn drop(&mut self) {
        let mut parked = lock(&self.vault.parked);
        if let Some(entry) = parked.get_mut(self.id) {
            entry.waiting -= 1;
            if entry.waiting == 0 {
                parked.remove(self.id);
            }
        }
    }
}

impl FakeVault {
    pub fn new(limits: VaultLimits) -> Arc<Self> {
        Arc::new(Self { limits, vaults: Mutex::default(), parked: Mutex::default() })
    }

    // ---- the store (VaultStore.ts) -------------------------------------------

    /// First sight pins the token's hash, as rooms do.
    pub fn authorize(&self, vault: &str, token: &str) -> Authorized {
        let hash: [u8; 32] = Sha256::digest(token.as_bytes()).into();
        let mut vaults = lock(&self.vaults);
        if let Some(known) = vaults.get(vault) {
            return if known.auth_hash == hash { Authorized::Ok } else { Authorized::Forbidden };
        }
        if vaults.len() >= self.limits.max_vaults {
            return Authorized::Full;
        }
        vaults.insert(vault.to_owned(), Vault { auth_hash: hash, ..Vault::default() });
        Authorized::Ok
    }

    pub fn changes(&self, vault: &str, since: u64, limit: usize) -> VaultChanges {
        let vaults = lock(&self.vaults);
        let Some(vault) = vaults.get(vault) else { return VaultChanges { head: 0, entries: Vec::new(), more: false } };
        let mut entries = Vec::new();
        let (mut bytes, mut more) = (0usize, false);
        for (seq, key) in vault.by_seq.range(since + 1..) {
            let data = &vault.records[key].1;
            if entries.len() == limit || (!entries.is_empty() && bytes + data.len() > PAGE_BYTES) {
                more = true;
                break;
            }
            bytes += data.len();
            entries.push(VaultEntry { key: key.clone(), seq: *seq, data: data.clone() });
        }
        VaultChanges { head: vault.head_seq, entries, more }
    }

    /// The caller must have authorized the vault (that is what creates it).
    pub fn put(&self, vault: &str, key: &str, base_seq: u64, data: &[u8]) -> StorePut {
        let stored = {
            let mut vaults = lock(&self.vaults);
            let Some(vault) = vaults.get_mut(vault) else { panic!("unknown vault {vault}") };
            let current = vault.records.get(key).map(|(seq, data)| (*seq, data.len()));
            let current_seq = current.map_or(0, |(seq, _)| seq);
            if current_seq != base_seq {
                let entry = vault.records.get(key).map(|(seq, data)| VaultEntry {
                    key: key.to_owned(),
                    seq: *seq,
                    data: data.clone(),
                });
                return StorePut::Conflict { entry };
            }
            let bytes = vault.bytes - current.map_or(0, |(_, size)| size) + data.len();
            if bytes > self.limits.max_vault_bytes {
                return StorePut::Quota;
            }
            let seq = vault.head_seq + 1;
            if current_seq > 0 {
                vault.by_seq.remove(&current_seq);
            }
            vault.by_seq.insert(seq, key.to_owned());
            vault.records.insert(key.to_owned(), (seq, data.to_vec()));
            vault.head_seq = seq;
            vault.bytes = bytes;
            seq
        };
        self.wake(vault);
        StorePut::Stored { seq: stored }
    }

    /// Long-polls parked on `vault` right now.
    pub fn parked(&self, vault: &str) -> usize {
        lock(&self.parked).get(vault).map_or(0, |p| p.waiting)
    }

    /// Vaults with at least one parked long-poll.
    pub fn parked_vaults(&self) -> usize {
        lock(&self.parked).len()
    }

    /// Every record a vault holds, in sequence order: for a test's own reading.
    pub fn records(&self, vault: &str) -> Vec<VaultEntry> {
        let vaults = lock(&self.vaults);
        let Some(vault) = vaults.get(vault) else { return Vec::new() };
        vault
            .by_seq
            .iter()
            .map(|(seq, key)| VaultEntry { key: key.clone(), seq: *seq, data: vault.records[key].1.clone() })
            .collect()
    }

    fn wake(&self, vault: &str) {
        if let Some(parked) = lock(&self.parked).get(vault) {
            parked.wake.notify_waiters();
        }
    }

    /// A page of changes; with nothing new and a wait, parks until a put
    /// lands on the vault or the wait runs out, then reads again.
    async fn long_poll(&self, vault: &str, since: u64, limit: usize, wait: Duration) -> VaultChanges {
        if wait.is_zero() {
            return self.changes(vault, since, limit);
        }
        let wake = {
            let mut parked = lock(&self.parked);
            let entry = parked.entry(vault.to_owned()).or_default();
            entry.waiting += 1;
            entry.wake.clone()
        };
        let _parked = ParkedGuard { vault: self, id: vault };
        // Listening before the read: a put between the two is not missed.
        let notified = wake.notified();
        let page = self.changes(vault, since, limit);
        if !page.entries.is_empty() {
            return page;
        }
        let _ = tokio::time::timeout(wait, notified).await;
        self.changes(vault, since, limit)
    }

    // ---- the routes (routes.ts) ----------------------------------------------

    /// `None` when the path is not a vault route.
    pub async fn handle(&self, request: VaultRequest<'_>) -> Option<VaultResponse> {
        let (path, params) = query(request.target);
        let rest = path.strip_prefix("/vault/v1/")?;
        let segments: Vec<&str> = rest.split('/').collect();
        let (vault, key) = match segments.as_slice() {
            [vault, "changes"] if !vault.is_empty() => (*vault, None),
            [vault, "records", key] if !vault.is_empty() && !key.is_empty() => (*vault, Some(*key)),
            _ => return Some(VaultResponse::error(404, "not found")),
        };
        let method = if key.is_some() { "PUT" } else { "GET" };
        if request.method != method {
            let mut refused = VaultResponse::error(405, "method not allowed");
            refused.headers.push(("allow", method.to_owned()));
            return Some(refused);
        }
        if !is_hex(vault, 32) || key.is_some_and(|key| !is_hex(key, 64)) {
            return Some(VaultResponse::error(400, "bad vault or key"));
        }
        let Some(token) = bearer(request.authorization) else {
            return Some(VaultResponse::error(401, "unauthorized"));
        };
        match self.authorize(vault, token) {
            Authorized::Forbidden => return Some(VaultResponse::error(403, "forbidden")),
            Authorized::Full => return Some(VaultResponse::error(503, "vault limit")),
            Authorized::Ok => {}
        }
        Some(match key {
            None => self.changes_route(vault, &params).await,
            Some(key) => self.put_route(vault, key, &request),
        })
    }

    async fn changes_route(&self, vault: &str, params: &HashMap<String, String>) -> VaultResponse {
        let get = |name: &str| params.get(name).map(String::as_str);
        let (Some(since), Some(wait), Some(limit)) =
            (int_param(get("since"), 0), int_param(get("wait"), 0), int_param(get("limit"), DEFAULT_LIMIT))
        else {
            return VaultResponse::error(400, "bad query");
        };
        let page_size = limit.clamp(1, MAX_LIMIT) as usize;
        let page = self.long_poll(vault, since, page_size, Duration::from_secs(wait.min(MAX_WAIT_S))).await;
        let entries: Vec<Value> = page.entries.iter().map(wire).collect();
        VaultResponse::new(200, json!({ "head": page.head, "entries": entries, "more": page.more }))
    }

    fn put_route(&self, vault: &str, key: &str, request: &VaultRequest<'_>) -> VaultResponse {
        // base64 of the largest blob plus room for the JSON around it.
        let cap = self.limits.max_blob_bytes.div_ceil(3) * 4 + 1024;
        let too_large = || {
            let mut refused = VaultResponse::error(413, "blob too large");
            refused.headers.push(("connection", "close".to_owned()));
            refused
        };
        if request.content_length.unwrap_or(0) > cap || request.body.len() > cap {
            return too_large();
        }
        let Ok(body) = serde_json::from_slice::<Value>(request.body) else {
            return VaultResponse::error(400, "bad json");
        };
        let base_seq = body
            .get("baseSeq")
            .and_then(Value::as_f64)
            .filter(|n| *n >= 0.0 && n.fract() == 0.0 && *n <= 9_007_199_254_740_991.0);
        let Some(base_seq) = base_seq else { return VaultResponse::error(400, "bad baseSeq") };
        let Some(data) = body.get("data").and_then(Value::as_str).filter(|d| is_base64(d)) else {
            return VaultResponse::error(400, "bad data");
        };
        let Ok(blob) = LENIENT.decode(data) else { return VaultResponse::error(400, "bad data") };
        if blob.len() > self.limits.max_blob_bytes {
            return too_large();
        }
        match self.put(vault, key, base_seq as u64, &blob) {
            StorePut::Stored { seq } => VaultResponse::new(200, json!({ "seq": seq })),
            StorePut::Conflict { entry } => VaultResponse::new(409, json!({ "entry": entry.as_ref().map(wire) })),
            StorePut::Quota => VaultResponse::error(507, "vault quota"),
        }
    }

    // ---- over HTTP -------------------------------------------------------------

    /// Serves the routes on a loopback port until the returned value is dropped.
    pub async fn serve(self: &Arc<Self>) -> ServedVault {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("a loopback port");
        let port = listener.local_addr().expect("the bound address").port();
        let vault = self.clone();
        let task = tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                tokio::spawn(connection(vault.clone(), socket));
            }
        });
        ServedVault { port, task }
    }

    /// The vault as the sync engine reaches it, without HTTP.
    pub fn client(self: &Arc<Self>, vault_id: &str, token: &str) -> Arc<FakeVaultClient> {
        Arc::new(FakeVaultClient {
            vault: self.clone(),
            id: vault_id.to_owned(),
            token: token.to_owned(),
            page_limit: Mutex::new(200),
            fault: Mutex::new(None),
        })
    }
}

/// A loopback server of a [`FakeVault`].
#[derive(Debug)]
pub struct ServedVault {
    port: u16,
    task: tokio::task::JoinHandle<()>,
}

impl ServedVault {
    /// `ws://127.0.0.1:<port>/`: the relay URL a sync key would carry.
    pub fn relay_url(&self) -> String {
        format!("ws://127.0.0.1:{}/", self.port)
    }

    pub fn http_base(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

impl Drop for ServedVault {
    fn drop(&mut self) {
        self.task.abort();
    }
}

const READ_CAP: usize = 64 * 1024 * 1024;

/// One request per connection: enough for a client that is told to close.
async fn connection(vault: Arc<FakeVault>, mut socket: tokio::net::TcpStream) {
    let mut raw = Vec::new();
    let mut buf = vec![0u8; 64 * 1024];
    let head_end = loop {
        if let Some(at) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
            break at + 4;
        }
        match socket.read(&mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(n) => raw.extend_from_slice(&buf[..n]),
        }
    };
    let head = String::from_utf8_lossy(&raw[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or_default().split_whitespace();
    let (method, target) = (first.next().unwrap_or_default(), first.next().unwrap_or("/"));
    let headers: HashMap<String, String> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    let content_length = headers.get("content-length").and_then(|v| v.parse::<usize>().ok());
    let mut body = raw[head_end..].to_vec();
    while body.len() < content_length.unwrap_or(0).min(READ_CAP) {
        match socket.read(&mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(n) => body.extend_from_slice(&buf[..n]),
        }
    }
    let request = VaultRequest {
        method,
        target,
        authorization: headers.get("authorization").map(String::as_str),
        content_length,
        body: &body,
    };
    // A client that gives up on a long-poll closes its end: stop waiting then.
    let response = tokio::select! {
        response = vault.handle(request) => response,
        _ = socket.read(&mut buf) => return,
    };
    let response = response.unwrap_or_else(|| VaultResponse::error(404, "not found"));
    let payload = response.body.to_string();
    let mut out = format!(
        "HTTP/1.1 {} {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n",
        response.status,
        reason(response.status),
        payload.len()
    );
    for (name, value) in response.headers.iter().filter(|(name, _)| *name != "connection") {
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    out.push_str("\r\n");
    out.push_str(&payload);
    let _ = socket.write_all(out.as_bytes()).await;
    let _ = socket.shutdown().await;
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        503 => "Service Unavailable",
        507 => "Insufficient Storage",
        _ => "Error",
    }
}

/// A call the engine makes to the vault.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VaultOp {
    Changes,
    Put,
}

/// What a test makes of a call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VaultFault {
    /// The request never reaches the vault.
    Fail,
    /// The vault does the work; its answer is lost on the way back.
    LoseAnswer,
}

type FaultHook = Box<dyn FnMut(VaultOp) -> Option<VaultFault> + Send>;

/// One computer's connection to a [`FakeVault`], with the client rules of the
/// real HTTP adapter (a vault that lost a record is written afresh).
pub struct FakeVaultClient {
    vault: Arc<FakeVault>,
    id: String,
    token: String,
    page_limit: Mutex<usize>,
    fault: Mutex<Option<FaultHook>>,
}

impl std::fmt::Debug for FakeVaultClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FakeVaultClient").field("id", &self.id).finish_non_exhaustive()
    }
}

impl FakeVaultClient {
    /// Entries per page (the real client asks for 200).
    pub fn set_page_limit(&self, limit: usize) {
        *lock(&self.page_limit) = limit.max(1);
    }

    /// Asked before every call; `None` lets it through.
    pub fn set_fault(&self, hook: impl FnMut(VaultOp) -> Option<VaultFault> + Send + 'static) {
        *lock(&self.fault) = Some(Box::new(hook));
    }

    pub fn clear_fault(&self) {
        *lock(&self.fault) = None;
    }

    fn fault(&self, op: VaultOp) -> Option<VaultFault> {
        lock(&self.fault).as_mut().and_then(|hook| hook(op))
    }

    fn authorize(&self) -> Result<(), Error> {
        match self.vault.authorize(&self.id, &self.token) {
            Authorized::Ok => Ok(()),
            Authorized::Forbidden => Err(Error::Unreachable("sync vault: 403 forbidden".into())),
            Authorized::Full => Err(Error::Unreachable("sync vault: 503 vault limit".into())),
        }
    }
}

fn offline() -> Error {
    Error::Unreachable("sync vault: offline".into())
}

impl SyncVault for FakeVaultClient {
    fn changes(&self, since: u64, wait_ms: u64) -> BoxFuture<'_, Result<VaultChanges, Error>> {
        Box::pin(async move {
            let fault = self.fault(VaultOp::Changes);
            if fault == Some(VaultFault::Fail) {
                return Err(offline());
            }
            self.authorize()?;
            let limit = *lock(&self.page_limit);
            let wait = Duration::from_millis(wait_ms).min(Duration::from_secs(MAX_WAIT_S));
            let page = self.vault.long_poll(&self.id, since, limit, wait).await;
            if fault == Some(VaultFault::LoseAnswer) { Err(offline()) } else { Ok(page) }
        })
    }

    fn put<'a>(&'a self, key: &'a str, base_seq: u64, data: &'a [u8]) -> BoxFuture<'a, Result<PutOutcome, Error>> {
        Box::pin(async move {
            let fault = self.fault(VaultOp::Put);
            if fault == Some(VaultFault::Fail) {
                return Err(offline());
            }
            self.authorize()?;
            let outcome = match self.vault.put(&self.id, key, base_seq, data) {
                StorePut::Stored { seq } => Ok(PutOutcome::Stored { seq }),
                StorePut::Conflict { entry: Some(entry) } => Ok(PutOutcome::Conflict { entry }),
                // The vault lost the record this computer last saw: write it afresh.
                StorePut::Conflict { entry: None } => match self.vault.put(&self.id, key, 0, data) {
                    StorePut::Stored { seq } => Ok(PutOutcome::Stored { seq }),
                    _ => Err(Error::Unreachable("sync vault: vault refused a new record".into())),
                },
                StorePut::Quota => Err(Error::Unreachable("sync vault: 507 vault quota".into())),
            };
            if fault == Some(VaultFault::LoseAnswer) { Err(offline()) } else { outcome }
        })
    }
}
