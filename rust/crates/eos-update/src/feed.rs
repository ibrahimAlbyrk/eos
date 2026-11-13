//! The update feed over HTTPS (`infra/src/update/HttpUpdateFeed.ts`): a signed
//! pointer per platform, the manifests it names and byte ranges of the packs.
//! Transient failures (no network, a 5xx, a rate limit) are retried a few
//! times with backoff; everything is size-capped before it is read, and the
//! manifest is checked against the pointer's hash.

use std::io::Read;
use std::sync::Arc;
use std::time::Duration;

use eos_contracts::update::{SignedUpdatePointer, UpdateManifest, UpdatePlatform, UpdatePointerManifest};
use eos_core::BoxFuture;
use eos_core::net::updates::UpdateFeed;
use eos_domain::update::{UpdateError, parse_manifest, parse_signed_pointer, platform_name};
use eos_kit_net::{ClientOptions, http_client};
use eos_platform::ThreadClass;
use reqwest::header::{CONTENT_LENGTH, RANGE};
use reqwest::{Client, Response, StatusCode};

use crate::error::Error;
use crate::scan::sha256_hex;

const POINTER_MAX_BYTES: usize = 32 * 1024;
/// A manifest unpacks to well under this (a 567 MB bundle's is about 2 MB).
const MANIFEST_MAX_UNPACKED: u64 = 64 * 1024 * 1024;
/// For the whole request, body included.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const BACKOFF: [Duration; 3] = [Duration::from_secs(1), Duration::from_secs(4), Duration::from_secs(10)];

/// Where the feed lives; read on every request, because a pointer may move it.
pub type BaseUrl = Arc<dyn Fn() -> String + Send + Sync>;

pub struct HttpUpdateFeed {
    client: Client,
    base_url: BaseUrl,
    backoff: [Duration; 3],
}

impl std::fmt::Debug for HttpUpdateFeed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpUpdateFeed").field("base_url", &(self.base_url)()).finish_non_exhaustive()
    }
}

impl HttpUpdateFeed {
    /// A feed read over its own `eos-kit-net` client (redirects followed).
    pub fn new(base_url: BaseUrl) -> Result<Self, Error> {
        let options = ClientOptions::new(concat!("Eos/", env!("CARGO_PKG_VERSION")));
        let client = http_client(&options).map_err(|e| Error::Client(e.to_string()))?;
        Ok(Self { client, base_url, backoff: BACKOFF })
    }

    /// The waits before the second, third and fourth attempt.
    pub fn with_backoff(mut self, backoff: [Duration; 3]) -> Self {
        self.backoff = backoff;
        self
    }

    /// A 2xx answer; `None` for a 404 when `optional`.
    async fn get(&self, path: &str, optional: bool, range: Option<String>) -> Result<Option<Response>, UpdateError> {
        let base = (self.base_url)();
        let url = format!("{}/{path}", base.trim_end_matches('/'));
        let mut attempt = 0;
        loop {
            let mut request = self.client.get(&url).timeout(REQUEST_TIMEOUT);
            if let Some(range) = &range {
                request = request.header(RANGE, range);
            }
            let failure = match request.send().await {
                Ok(res) if res.status().is_success() => return Ok(Some(res)),
                Ok(res) if res.status() == StatusCode::NOT_FOUND && optional => return Ok(None),
                Ok(res) => {
                    let status = res.status().as_u16();
                    if status != 429 && status < 500 {
                        return Err(UpdateError::bad_release(format!("{path}: the feed answered {status}")));
                    }
                    format!("{path}: the feed answered {status}")
                }
                Err(e) => format!("{path}: {}", describe(&e)),
            };
            let Some(wait) = self.backoff.get(attempt) else { return Err(UpdateError::network(failure)) };
            tokio::time::sleep(*wait).await;
            attempt += 1;
        }
    }
}

/// A request failure in a few words: reqwest's own text names the URL twice.
fn describe(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        return "no answer in time".to_owned();
    }
    let mut cause: &dyn std::error::Error = e;
    while let Some(next) = cause.source() {
        cause = next;
    }
    cause.to_string()
}

async fn read_capped(mut res: Response, path: &str, max_bytes: usize) -> Result<Vec<u8>, UpdateError> {
    let declared = res.headers().get(CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
    if let Some(declared) = declared
        && declared > max_bytes as u64
    {
        return Err(UpdateError::bad_release(format!("the feed sent {declared} bytes where at most {max_bytes} fit")));
    }
    let mut body = Vec::with_capacity(declared.map_or(0, |d| d as usize));
    loop {
        match res.chunk().await {
            Ok(Some(part)) => {
                if body.len() + part.len() > max_bytes {
                    return Err(UpdateError::bad_release(format!("the feed sent more than {max_bytes} bytes")));
                }
                body.extend_from_slice(&part);
            }
            Ok(None) => return Ok(body),
            Err(e) => return Err(UpdateError::network(format!("{path}: {}", describe(&e)))),
        }
    }
}

fn unpack_manifest(packed: &[u8]) -> Result<Vec<u8>, UpdateError> {
    let unpack = || -> std::io::Result<Vec<u8>> {
        let mut json = Vec::new();
        let read = zstd::stream::read::Decoder::new(packed)?.take(MANIFEST_MAX_UNPACKED + 1).read_to_end(&mut json)?;
        if read as u64 > MANIFEST_MAX_UNPACKED {
            return Err(std::io::Error::other("too large"));
        }
        Ok(json)
    };
    unpack().map_err(|_| UpdateError::bad_release("the manifest does not unpack"))
}

/// Checks fetched manifest bytes against the pointer and reads them.
pub fn open_manifest(packed: &[u8], reference: &UpdatePointerManifest) -> Result<UpdateManifest, UpdateError> {
    if packed.len() as i64 != reference.size || sha256_hex(packed) != reference.sha256 {
        return Err(UpdateError::corrupt("the manifest does not match its pointer"));
    }
    parse_manifest(&unpack_manifest(packed)?)
}

impl UpdateFeed for HttpUpdateFeed {
    fn pointer(&self, platform: UpdatePlatform) -> BoxFuture<'_, Result<Option<SignedUpdatePointer>, UpdateError>> {
        Box::pin(async move {
            let path = format!("stable/{}.json", platform_name(platform));
            let Some(res) = self.get(&path, true, None).await? else { return Ok(None) };
            parse_signed_pointer(&read_capped(res, &path, POINTER_MAX_BYTES).await?).map(Some)
        })
    }

    fn manifest<'a>(
        &'a self,
        reference: &'a UpdatePointerManifest,
    ) -> BoxFuture<'a, Result<UpdateManifest, UpdateError>> {
        Box::pin(async move {
            let Some(res) = self.get(&reference.path, false, None).await? else { return no_answer() };
            let max = usize::try_from(reference.size).unwrap_or(0);
            let packed = read_capped(res, &reference.path, max).await?;
            // Unpacking and hashing a few megabytes: off the async threads, at the utility class.
            let reference = reference.clone();
            tokio::task::spawn_blocking(move || {
                eos_platform::in_thread_class(ThreadClass::Utility, || open_manifest(&packed, &reference))
            })
            .await
            .map_err(|e| UpdateError::disk(e.to_string()))?
        })
    }

    fn range<'a>(&'a self, path: &'a str, offset: i64, length: i64) -> BoxFuture<'a, Result<Vec<u8>, UpdateError>> {
        Box::pin(async move {
            let header = format!("bytes={offset}-{}", offset + length - 1);
            let Some(res) = self.get(path, false, Some(header)).await? else { return no_answer() };
            if res.status() != StatusCode::PARTIAL_CONTENT {
                return Err(UpdateError::bad_release(format!("the feed ignored a range request for {path}")));
            }
            let bytes = read_capped(res, path, usize::try_from(length).unwrap_or(0)).await?;
            if bytes.len() as i64 != length {
                return Err(UpdateError::network(format!("{path}: the range came back short")));
            }
            Ok(bytes)
        })
    }

    fn text<'a>(&'a self, path: &'a str, max_bytes: usize) -> BoxFuture<'a, Result<String, UpdateError>> {
        Box::pin(async move {
            let Some(res) = self.get(path, false, None).await? else { return no_answer() };
            Ok(String::from_utf8_lossy(&read_capped(res, path, max_bytes).await?).into_owned())
        })
    }
}

/// `get` answers `None` only for an optional path.
fn no_answer<T>() -> Result<T, UpdateError> {
    Err(UpdateError::network("the feed did not answer"))
}
