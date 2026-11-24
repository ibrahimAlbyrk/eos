//! [`HookInbox`] over the relay's hook API (07 §4.7, `relay/hooks/`): plain
//! HTTPS beside the room's socket, needing no room and no phone. The inbox's
//! identity comes from the phone link's files (`remote/hooks.json`).

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use eos_core::net::hooks::{HookBatch, HookEvent, HookInbox, HookUrl};
use eos_core::store::{HookIdentity, RemoteStore};
use eos_core::{BoxFuture, Error};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::push::http_origin;
use crate::seal;

/// The relay holds a long-poll at most this long.
const MAX_WAIT_S: u64 = 25;
/// Headroom over the wait before a request counts as hung.
const REQUEST_SLACK: Duration = Duration::from_secs(20);
/// The relay's page holds at most 16 MiB of sealed events, as base64 in JSON.
const MAX_ANSWER_BYTES: usize = 32 * 1024 * 1024;

/// Where the relay is right now: the phone link's relay URL (`wss://…`),
/// `None` while none is set.
pub type RelayUrl = Arc<dyn Fn() -> Option<String> + Send + Sync>;

pub struct RelayHookInbox {
    http: reqwest::Client,
    relay_url: RelayUrl,
    store: Arc<dyn RemoteStore>,
}

impl std::fmt::Debug for RelayHookInbox {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RelayHookInbox")
    }
}

#[derive(Deserialize)]
struct Page {
    head: u64,
    entries: Vec<Entry>,
    dropped: u64,
}

#[derive(Deserialize)]
struct Entry {
    seq: u64,
    sealed: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Opened {
    hook: String,
    received_at: i64,
    headers: serde_json::Map<String, Value>,
    body: String,
}

/// One entry opened with this computer's key; `None` when it does not open
/// or is not an event, which is never guessed at.
fn open(secret: &[u8; 32], entry: &Entry) -> Option<HookEvent> {
    let sealed = STANDARD.decode(entry.sealed.as_bytes()).ok()?;
    let plaintext = seal::open(secret, &sealed)?;
    let opened: Opened = serde_json::from_slice(&plaintext).ok()?;
    let headers = opened
        .headers
        .into_iter()
        .map(|(name, value)| Some((name, value.as_str()?.to_owned())))
        .collect::<Option<_>>()?;
    let body = STANDARD.decode(opened.body.as_bytes()).ok()?;
    Some(HookEvent { seq: entry.seq, hook: opened.hook, received_at: opened.received_at, headers, body })
}

fn unexpected() -> Error {
    Error::Unreachable("hook inbox (an answer in a shape this Eos doesn't know)".into())
}

fn hook_id() -> Result<String, Error> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(Error::storage)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// How the installed app reaches the relay's hook inbox: an HTTP client of
/// its own. Only the host makes one; an app handed none has no inbox.
#[derive(Clone)]
pub struct HookClient(reqwest::Client);

impl HookClient {
    pub fn new() -> Self {
        // The relay is the one the user's own phone link names: no guard for agent-written URLs.
        Self(eos_kit_net::http_client(&eos_kit_net::ClientOptions::new("Eos")).unwrap_or_default())
    }

    /// The inbox at the relay `relay_url` names, under the identity `store` keeps.
    pub fn inbox(&self, relay_url: RelayUrl, store: Arc<dyn RemoteStore>) -> RelayHookInbox {
        RelayHookInbox::new(self.0.clone(), relay_url, store)
    }
}

impl Default for HookClient {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for HookClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("HookClient")
    }
}

impl RelayHookInbox {
    pub fn new(http: reqwest::Client, relay_url: RelayUrl, store: Arc<dyn RemoteStore>) -> Self {
        Self { http, relay_url, store }
    }

    /// The inbox's base URL and its identity.
    fn inbox(&self) -> Result<(String, HookIdentity), Error> {
        let relay = (self.relay_url)().filter(|url| !url.is_empty());
        let relay = relay.ok_or_else(|| Error::Validation("no relay is set for the hook inbox".into()))?;
        let origin = http_origin(&relay).ok_or_else(|| Error::Validation("not a relay URL".into()))?;
        let identity = self.store.hook_identity()?;
        Ok((format!("{origin}/hooks/v1/{}", identity.inbox), identity))
    }

    /// Sends with the inbox's bearer; the JSON body of a 200.
    async fn send(&self, request: reqwest::RequestBuilder, bearer: &str, wait: Duration) -> Result<Value, Error> {
        let unreachable = |e: reqwest::Error| {
            let why = if e.is_timeout() { "did not answer in time" } else { "can't be reached" };
            Error::Unreachable(format!("hook inbox ({why})"))
        };
        let mut response =
            request.bearer_auth(bearer).timeout(wait + REQUEST_SLACK).send().await.map_err(unreachable)?;
        let status = response.status().as_u16();
        let mut raw = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(unreachable)? {
            if raw.len() + chunk.len() > MAX_ANSWER_BYTES {
                return Err(unexpected());
            }
            raw.extend_from_slice(&chunk);
        }
        match status {
            200 => serde_json::from_slice(&raw).map_err(|_| unexpected()),
            401 | 403 => Err(Error::PermissionDenied("the relay refused this computer's hook inbox".into())),
            404 => Err(Error::not_found("hook inbox", "this computer's")),
            409 => Err(Error::Conflict("the relay holds that hook for another inbox".into())),
            503 | 507 => Err(Error::LimitExceeded("the relay holds no more hook inboxes or hooks".into())),
            status => Err(Error::Unreachable(format!("hook inbox (HTTP {status})"))),
        }
    }
}

impl HookInbox for RelayHookInbox {
    fn ensure(&self) -> BoxFuture<'_, Result<(), Error>> {
        Box::pin(async move {
            let (base, identity) = self.inbox()?;
            let body = json!({ "publicKey": STANDARD.encode(seal::public_key(&identity.secret_key)) }).to_string();
            let request = self.http.put(base).header(reqwest::header::CONTENT_TYPE, "application/json").body(body);
            self.send(request, &identity.bearer, Duration::ZERO).await.map(drop)
        })
    }

    fn create_hook(&self) -> BoxFuture<'_, Result<HookUrl, Error>> {
        Box::pin(async move {
            let (base, identity) = self.inbox()?;
            let id = hook_id()?;
            self.send(self.http.put(format!("{base}/hooks/{id}")), &identity.bearer, Duration::ZERO).await?;
            Ok(HookUrl { url: format!("{base}/{id}"), id })
        })
    }

    fn revoke_hook<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(async move {
            let (base, identity) = self.inbox()?;
            self.send(self.http.delete(format!("{base}/hooks/{id}")), &identity.bearer, Duration::ZERO).await.map(drop)
        })
    }

    fn next(&self, since: u64, wait_ms: u64) -> BoxFuture<'_, Result<HookBatch, Error>> {
        Box::pin(async move {
            let (base, identity) = self.inbox()?;
            let wait = wait_ms.div_ceil(1000).min(MAX_WAIT_S);
            let request = self.http.get(format!("{base}/events?since={since}&wait={wait}"));
            let body = self.send(request, &identity.bearer, Duration::from_secs(wait)).await?;
            let page: Page = serde_json::from_value(body).map_err(|_| unexpected())?;
            let through = page.entries.last().map_or(page.head, |entry| entry.seq);
            let mut batch = HookBatch { head: page.head, through, dropped: page.dropped, ..HookBatch::default() };
            for entry in &page.entries {
                match open(&identity.secret_key, entry) {
                    Some(event) => batch.events.push(event),
                    None => batch.unreadable += 1,
                }
            }
            if batch.unreadable > 0 {
                tracing::warn!(unreadable = batch.unreadable, "hook inbox: events that did not open were dropped");
            }
            Ok(batch)
        })
    }

    fn ack(&self, through: u64) -> BoxFuture<'_, Result<(), Error>> {
        Box::pin(async move {
            let (base, identity) = self.inbox()?;
            let body = json!({ "through": through }).to_string();
            let request = self
                .http
                .post(format!("{base}/ack"))
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body);
            self.send(request, &identity.bearer, Duration::ZERO).await.map(drop)
        })
    }
}
