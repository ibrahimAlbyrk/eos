//! The relay vault over HTTPS (`infra/src/sync/HttpSyncVault.ts`). The relay
//! URL in the sync key is the WebSocket URL the phone and peer relay already
//! use; the vault is served by the same host.

use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use eos_contracts::{VaultChangesWire, VaultEntryWire};
use eos_core::net::sync::{PutOutcome, SyncVault, VaultChanges, VaultEntry};
use eos_core::{BoxFuture, Error};
use serde_json::{Value, json};

const PAGE_LIMIT: u32 = 200;
/// Headroom over the long-poll wait before a request counts as hung.
const REQUEST_SLACK: Duration = Duration::from_secs(20);
/// A page holds at most 16 MiB of blobs (the relay's rule), base64 and JSON
/// around them: anything past this is not a vault answering.
const MAX_ANSWER_BYTES: usize = 64 * 1024 * 1024;

pub struct HttpSyncVault {
    http: reqwest::Client,
    base: String,
    host: String,
    auth_token: String,
}

// The bearer never reaches a log.
impl std::fmt::Debug for HttpSyncVault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpSyncVault").field("host", &self.host).finish_non_exhaustive()
    }
}

/// `ws://` → `http://`, `wss://` → `https://`, no trailing slash.
fn http_base(relay_url: &str) -> String {
    let http = match relay_url.strip_prefix("wss:") {
        Some(rest) => format!("https:{rest}"),
        None => match relay_url.strip_prefix("ws:") {
            Some(rest) => format!("http:{rest}"),
            None => relay_url.to_owned(),
        },
    };
    http.trim_end_matches('/').to_owned()
}

fn from_wire(entry: VaultEntryWire) -> Result<VaultEntry, Error> {
    let data = STANDARD.decode(entry.data.as_bytes()).map_err(|_| unexpected("a record that is not base64"))?;
    let seq = u64::try_from(entry.seq).map_err(|_| unexpected("a negative sequence number"))?;
    Ok(VaultEntry { key: entry.key, seq, data })
}

fn unexpected(what: &str) -> Error {
    Error::Storage(format!("sync vault: the relay sent {what}"))
}

impl HttpSyncVault {
    pub fn new(http: reqwest::Client, relay_url: &str, vault_id: &str, auth_token: &str) -> Self {
        let root = http_base(relay_url);
        let host = root.split_once("://").map_or(root.as_str(), |(_, rest)| rest).to_owned();
        Self { http, base: format!("{root}/vault/v1/{vault_id}"), host, auth_token: auth_token.to_owned() }
    }

    /// The answer's status and JSON body; an error for any status not in `ok`.
    async fn send(&self, request: reqwest::RequestBuilder, wait: Duration, ok: &[u16]) -> Result<(u16, Value), Error> {
        let unreachable = |e: reqwest::Error| {
            tracing::debug!(error = %e, host = %self.host, "sync vault: request failed");
            let why = if e.is_timeout() { "did not answer in time" } else { "can't be reached" };
            Error::Storage(format!("sync vault: {} {why}", self.host))
        };
        let mut response =
            request.bearer_auth(&self.auth_token).timeout(wait + REQUEST_SLACK).send().await.map_err(unreachable)?;
        let status = response.status();
        let mut raw = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(unreachable)? {
            if raw.len() + chunk.len() > MAX_ANSWER_BYTES {
                return Err(unexpected("more than a page can hold"));
            }
            raw.extend_from_slice(&chunk);
        }
        // A body that is not JSON reads as `{}`, as today.
        let body: Value = serde_json::from_slice(&raw).unwrap_or_else(|_| json!({}));
        if !ok.contains(&status.as_u16()) {
            let reason =
                body.get("error").and_then(Value::as_str).or_else(|| status.canonical_reason()).unwrap_or_default();
            return Err(Error::Storage(format!("sync vault: {} {reason}", status.as_u16())));
        }
        Ok((status.as_u16(), body))
    }

    async fn put_once(&self, key: &str, base_seq: u64, data: &str) -> Result<(u16, Value), Error> {
        let body = json!({ "baseSeq": base_seq, "data": data }).to_string();
        let request =
            self.http.put(format!("{}/records/{key}", self.base)).header("content-type", "application/json").body(body);
        self.send(request, Duration::ZERO, &[200, 409]).await
    }
}

impl SyncVault for HttpSyncVault {
    fn changes(&self, since: u64, wait_ms: u64) -> BoxFuture<'_, Result<VaultChanges, Error>> {
        Box::pin(async move {
            let wait = wait_ms.div_ceil(1000);
            let url = format!("{}/changes?since={since}&wait={wait}&limit={PAGE_LIMIT}", self.base);
            let (_, body) = self.send(self.http.get(url), Duration::from_millis(wait_ms), &[200]).await?;
            let page: VaultChangesWire = eos_contracts::validate::parse(&body)
                .map_err(|_| unexpected("changes in a shape this Eos doesn't know"))?;
            let head = u64::try_from(page.head).map_err(|_| unexpected("a negative head"))?;
            let entries = page.entries.into_iter().map(from_wire).collect::<Result<_, _>>()?;
            Ok(VaultChanges { head, entries, more: page.more })
        })
    }

    fn put<'a>(&'a self, key: &'a str, base_seq: u64, data: &'a [u8]) -> BoxFuture<'a, Result<PutOutcome, Error>> {
        Box::pin(async move {
            let encoded = STANDARD.encode(data);
            let mut base = base_seq;
            loop {
                let (status, body) = self.put_once(key, base, &encoded).await?;
                if status == 200 {
                    let seq =
                        body.get("seq").and_then(Value::as_u64).ok_or_else(|| unexpected("no sequence number"))?;
                    return Ok(PutOutcome::Stored { seq });
                }
                match body.get("entry") {
                    Some(entry) if !entry.is_null() => {
                        let entry: VaultEntryWire = eos_contracts::validate::parse(entry)
                            .map_err(|_| unexpected("a record in a shape this Eos doesn't know"))?;
                        return Ok(PutOutcome::Conflict { entry: from_wire(entry)? });
                    }
                    // The vault lost the record this computer last saw (a reset relay): write it afresh.
                    _ if base != 0 => base = 0,
                    _ => return Err(Error::Storage("sync vault: vault refused a new record".into())),
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_vault_is_served_beside_the_relays_socket() {
        assert_eq!(http_base("wss://relay.example/"), "https://relay.example");
        assert_eq!(http_base("ws://127.0.0.1:8080//"), "http://127.0.0.1:8080");
        assert_eq!(http_base("https://relay.example/eos/"), "https://relay.example/eos");
    }
}
