//! The map behind visual answers: OpenFreeMap's `dark` style, its TileJSON,
//! tiles, glyphs and sprites, fetched on demand
//! (`infra/src/genui/OpenFreeMapProxy.ts`). Only the map's origin is ever
//! contacted. JSON documents (the style, TileJSON) come back with every URL of
//! that origin rewritten to the proxy's path, so the map keeps asking the app.
//! Nothing is fetched ahead: OpenFreeMap's terms ask for on-demand use.
//! Changing providers is a change here only.

use std::collections::VecDeque;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use bytes::Bytes;
use eos_core::net::{MapResponse, MapTiles};
use eos_core::{BoxFuture, Clock};
use eos_genui::{Object, Value};
use regress::Regex;
use reqwest::header::{CONTENT_LENGTH, CONTENT_TYPE, LOCATION, USER_AGENT};
use url::Url;

use crate::inflight::Inflight;

pub const OPENFREEMAP_ORIGIN: &str = "https://tiles.openfreemap.org";
const STYLE_PATH: &str = "styles/dark";
const ATTRIBUTION: &str = "OpenFreeMap © OpenMapTiles Data from OpenStreetMap";
/// Where the dashboard reaches the proxy.
const PROXY_PREFIX: &str = "/api/genui/map/t";

const MAX_BYTES: usize = 8 * 1024 * 1024;
const JSON_TTL_MS: i64 = 60 * 60 * 1000;
const JSON_MAX_ENTRIES: usize = 32;
const TIMEOUT: Duration = Duration::from_secs(8);
const MAX_REDIRECTS: usize = 3;
/// Map resources being fetched at once; a map asks for a few dozen tiles.
/// Beyond it a tile is answered as an upstream failure, and the map asks again.
const MAX_IN_FLIGHT: usize = 256;

static PATH: LazyLock<Regex> = LazyLock::new(|| {
    let pattern = r"^[A-Za-z0-9_.~%@,+{}-][A-Za-z0-9_.~%@,+{}/ -]*$";
    Regex::new(pattern).unwrap_or_else(|e| panic!("pattern {pattern}: {e}"))
});

/// Every string that starts with the map's origin, anywhere in a JSON value,
/// is pointed at `prefix` (tile templates keep their `{z}/{x}/{y}`).
pub(crate) fn rewrite_map_urls(value: Value, origin: &str, prefix: &str) -> Value {
    match value {
        Value::String(text) => match text.strip_prefix(origin).and_then(|rest| rest.strip_prefix('/')) {
            Some(rest) => Value::String(format!("{prefix}/{rest}")),
            None => Value::String(text),
        },
        Value::Array(items) => {
            Value::Array(items.into_iter().map(|item| rewrite_map_urls(item, origin, prefix)).collect())
        }
        Value::Object(fields) => {
            let mut out = Object::new();
            for (key, field) in fields.iter().filter(|(key, _)| *key != "__proto__") {
                out.insert(key, rewrite_map_urls(field.clone(), origin, prefix));
            }
            Value::Object(out)
        }
        other => other,
    }
}

/// `decodeURIComponent(path)`, or `None` where that throws.
fn percent_decoded(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = path.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The upstream URL for a proxied path, or `None` when it would leave the
/// map's origin (an absolute URL, a scheme-relative one, a dot segment, a
/// stray character).
pub(crate) fn upstream_url(origin: &str, path: &str) -> Option<String> {
    if path.is_empty() || path.encode_utf16().count() > 512 || PATH.find(path).is_none() {
        return None;
    }
    if path.split('/').any(|segment| segment == ".." || segment == ".") {
        return None;
    }
    let decoded = percent_decoded(path)?;
    if decoded.contains("..") || decoded.contains('\\') || decoded.starts_with('/') {
        return None;
    }
    let url = Url::parse(&format!("{origin}/{path}")).ok()?;
    (url.origin() == Url::parse(origin).ok()?.origin()).then(|| url.to_string())
}

fn answer(status: u16, reason: &str, cache_control: &'static str) -> MapResponse {
    let body = serde_json::json!({ "error": reason }).to_string();
    MapResponse { status, content_type: "application/json".to_owned(), body: body.into(), cache_control }
}

fn not_found(reason: &str) -> MapResponse {
    answer(404, reason, "private, max-age=300")
}

fn upstream_failed(reason: &str) -> MapResponse {
    answer(502, reason, "no-store")
}

struct Inner {
    client: reqwest::Client,
    clock: Arc<dyn Clock>,
    origin: String,
    user_agent: String,
    /// Rewritten JSON documents by upstream URL, oldest first.
    json: Mutex<VecDeque<(String, i64, MapResponse)>>,
    inflight: Inflight<MapResponse>,
}

/// Cheap to clone; clones share the connections and the cached documents.
#[derive(Clone)]
pub struct OpenFreeMapProxy {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for OpenFreeMapProxy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenFreeMapProxy").field("origin", &self.inner.origin).finish_non_exhaustive()
    }
}

impl OpenFreeMapProxy {
    /// `client` must not follow redirects: every hop is checked here.
    pub(crate) fn new(client: reqwest::Client, clock: Arc<dyn Clock>, origin: &str, user_agent: String) -> Self {
        let origin = origin.trim_end_matches('/').to_owned();
        let inflight = Inflight::new(MAX_IN_FLIGHT);
        Self { inner: Arc::new(Inner { client, clock, origin, user_agent, json: Mutex::default(), inflight }) }
    }

    fn cached(&self, url: &str) -> Option<MapResponse> {
        let now = self.inner.clock.now_ms();
        let json = self.inner.json.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        json.iter().find(|(cached, at, _)| cached == url && now - at < JSON_TTL_MS).map(|(_, _, res)| res.clone())
    }

    async fn resource(&self, path: &str) -> MapResponse {
        let Some(url) = upstream_url(&self.inner.origin, path) else { return not_found("not an OpenFreeMap path") };
        if let Some(cached) = self.cached(&url) {
            return cached;
        }
        let work = || {
            let (this, url) = (self.clone(), url.clone());
            async move {
                match tokio::time::timeout(TIMEOUT, this.load(&url)).await {
                    Ok(response) => response,
                    Err(_) => upstream_failed("OpenFreeMap timed out"),
                }
            }
        };
        self.inner.inflight.once(&url, work).await.unwrap_or_else(|| upstream_failed("too many map requests at once"))
    }

    async fn load(&self, url: &str) -> MapResponse {
        let Ok(origin) = Url::parse(&self.inner.origin) else { return upstream_failed("no map origin") };
        let Ok(mut target) = Url::parse(url) else { return not_found("not an OpenFreeMap path") };
        let mut hop = 0;
        loop {
            let sent = self.inner.client.get(target.clone()).header(USER_AGENT, &self.inner.user_agent).send().await;
            let mut response = match sent {
                Ok(response) => response,
                Err(e) => return upstream_failed(&root_cause(&e)),
            };
            let status = response.status().as_u16();
            if (300..400).contains(&status) {
                let location = response.headers().get(LOCATION).and_then(|v| v.to_str().ok());
                let next = location.and_then(|location| target.join(location).ok());
                match next {
                    Some(next) if next.origin() == origin.origin() && hop < MAX_REDIRECTS => {
                        target = next;
                        hop += 1;
                        continue;
                    }
                    Some(next) => {
                        return upstream_failed(&format!("redirect to {}", next.origin().ascii_serialization()));
                    }
                    None => return upstream_failed("redirect to nowhere"),
                }
            }
            if status == 404 || status == 204 {
                return not_found("no such map resource");
            }
            if !(200..300).contains(&status) {
                return upstream_failed(&format!("OpenFreeMap answered {status}"));
            }
            let header = |name| response.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
            if header(CONTENT_LENGTH).and_then(|n| n.parse::<u64>().ok()).is_some_and(|n| n > MAX_BYTES as u64) {
                return upstream_failed("response too large");
            }
            let content_type = header(CONTENT_TYPE).unwrap_or_else(|| "application/octet-stream".to_owned());
            let content_type = content_type.split(';').next().unwrap_or_default().trim().to_ascii_lowercase();
            let mut body = Vec::new();
            loop {
                match response.chunk().await {
                    Ok(Some(chunk)) if body.len() + chunk.len() > MAX_BYTES => {
                        return upstream_failed("response too large");
                    }
                    Ok(Some(chunk)) => body.extend_from_slice(&chunk),
                    Ok(None) => break,
                    Err(e) => return upstream_failed(&root_cause(&e)),
                }
            }
            if content_type.contains("json") || url.ends_with(STYLE_PATH) {
                return self.rewrite_json(url, &body);
            }
            // Tile, glyph and sprite URLs are versioned upstream, so they keep.
            return MapResponse {
                status: 200,
                content_type,
                body: Bytes::from(body),
                cache_control: "private, max-age=604800",
            };
        }
    }

    fn rewrite_json(&self, url: &str, body: &[u8]) -> MapResponse {
        let Ok(parsed) = serde_json::from_slice::<Value>(body) else {
            return upstream_failed("OpenFreeMap sent invalid JSON");
        };
        let mut rewritten = rewrite_map_urls(parsed, &self.inner.origin, PROXY_PREFIX);
        if url.ends_with(STYLE_PATH)
            && let Value::Object(style) = &mut rewritten
        {
            let mut metadata = match style.get("metadata") {
                Some(Value::Object(metadata)) => metadata.clone(),
                // `{ ...list }`: a list's items under their indexes.
                Some(Value::Array(items)) => {
                    items.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect()
                }
                _ => Object::new(),
            };
            metadata.insert("eos:attribution", Value::String(ATTRIBUTION.to_owned()));
            style.insert("metadata", Value::Object(metadata));
        }
        let response = MapResponse {
            status: 200,
            content_type: "application/json".to_owned(),
            body: rewritten.to_json().into(),
            cache_control: "private, max-age=3600",
        };
        let entry = (url.to_owned(), self.inner.clock.now_ms(), response.clone());
        let mut json = self.inner.json.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match json.iter_mut().find(|(cached, _, _)| cached == url) {
            Some(known) => *known = entry,
            None => json.push_back(entry),
        }
        if json.len() > JSON_MAX_ENTRIES {
            json.pop_front();
        }
        response
    }
}

/// The innermost cause of a failed request: what went wrong, not which layer saw it.
pub(crate) fn root_cause(error: &reqwest::Error) -> String {
    let mut source: &dyn std::error::Error = error;
    while let Some(inner) = source.source() {
        source = inner;
    }
    source.to_string()
}

impl MapTiles for OpenFreeMapProxy {
    fn style(&self) -> BoxFuture<'_, MapResponse> {
        Box::pin(self.resource(STYLE_PATH))
    }

    fn get<'a>(&'a self, path: &'a str) -> BoxFuture<'a, MapResponse> {
        Box::pin(self.resource(path))
    }
}
