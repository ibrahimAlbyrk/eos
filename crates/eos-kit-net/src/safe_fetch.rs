//! An outbound GET for URLs an agent wrote (images, pages for their preview
//! image, site icons):
//!
//! - http/https only, no credentials in the URL;
//! - the host name is resolved by OUR resolver, every address checked, and the
//!   socket connects to exactly those addresses (no DNS-rebinding window);
//! - each redirect (three at most) is a fresh, re-checked request;
//! - one deadline for the whole chain, a byte cap on the decoded body, and a
//!   content-type check before the body is read.

use std::error::Error as StdError;
use std::fmt;
use std::future::Future;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::header::{ACCEPT, CONTENT_LENGTH, CONTENT_TYPE, HeaderMap, LOCATION, USER_AGENT};
use url::{Host, Url};

use crate::client::{ClientOptions, builder};
use crate::error::Error;
use crate::guard::is_blocked_ip;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(8);
const DEFAULT_REDIRECTS: usize = 3;

type BlockedFn = Arc<dyn Fn(IpAddr) -> bool + Send + Sync>;

/// Turns a host name into addresses.
pub trait Resolver: Send + Sync + 'static {
    fn resolve<'a>(&'a self, host: &'a str) -> Pin<Box<dyn Future<Output = std::io::Result<Vec<IpAddr>>> + Send + 'a>>;
}

/// The system's resolver (`getaddrinfo`).
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemResolver;

impl Resolver for SystemResolver {
    fn resolve<'a>(&'a self, host: &'a str) -> Pin<Box<dyn Future<Output = std::io::Result<Vec<IpAddr>>> + Send + 'a>> {
        Box::pin(async move { Ok(tokio::net::lookup_host((host, 0)).await?.map(|addr| addr.ip()).collect()) })
    }
}

#[derive(Debug, Clone)]
pub struct SafeGetOptions {
    pub user_agent: String,
    /// The most bytes of decoded body accepted.
    pub max_bytes: usize,
    /// For the whole chain of redirects.
    pub timeout: Duration,
    pub max_redirects: usize,
    /// The `Accept` header; `*/*` when `None`.
    pub accept: Option<String>,
    /// Asked with the response's content type (lower case, parameters
    /// dropped, empty when absent) before any body byte is read.
    pub accept_type: Option<fn(&str) -> bool>,
}

impl SafeGetOptions {
    pub fn new(user_agent: impl Into<String>, max_bytes: usize) -> Self {
        Self {
            user_agent: user_agent.into(),
            max_bytes,
            timeout: DEFAULT_TIMEOUT,
            max_redirects: DEFAULT_REDIRECTS,
            accept: None,
            accept_type: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SafeResponse {
    /// The URL that answered, after redirects.
    pub url: String,
    pub status: u16,
    /// Lower case, without parameters; empty when the server sent none.
    pub content_type: String,
    pub headers: HeaderMap,
    pub body: Bytes,
}

/// Parses and vets a URL before any connection.
pub fn check_url(raw: &str) -> Result<Url, Error> {
    check_url_with(raw, &is_blocked_ip)
}

fn check_url_with(raw: &str, is_blocked: &dyn Fn(IpAddr) -> bool) -> Result<Url, Error> {
    let Ok(url) = Url::parse(raw) else {
        let start: String = raw.chars().take(80).collect();
        return Err(Error::Blocked(format!("\"{start}\" is not a URL")));
    };
    if !matches!(url.scheme(), "http" | "https") {
        return Err(Error::Blocked(format!("{}: URLs are not fetched — http(s) only", url.scheme())));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(Error::Blocked("URLs with credentials are not fetched".to_owned()));
    }
    let literal = match url.host() {
        None => return Err(Error::Blocked("the URL has no host".to_owned())),
        Some(Host::Domain("")) => return Err(Error::Blocked("the URL has no host".to_owned())),
        Some(Host::Domain(_)) => None,
        Some(Host::Ipv4(v4)) => Some(IpAddr::V4(v4)),
        Some(Host::Ipv6(v6)) => Some(IpAddr::V6(v6)),
    };
    match literal {
        Some(address) if is_blocked(address) => Err(Error::Blocked(format!("{address} is a private or local address"))),
        _ => Ok(url),
    }
}

/// The resolver's refusal, carried through the HTTP client's error chain.
#[derive(Debug)]
struct BlockedHost {
    host: String,
    address: IpAddr,
}

impl fmt::Display for BlockedHost {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} resolves to a private or local address ({})", self.host, self.address)
    }
}

impl StdError for BlockedHost {}

/// Resolves with `resolver` and refuses the whole host when any of its
/// addresses is blocked — the socket then dials only what was checked.
struct GuardedResolver {
    resolver: Arc<dyn Resolver>,
    is_blocked: BlockedFn,
}

impl Resolve for GuardedResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let (resolver, is_blocked) = (self.resolver.clone(), self.is_blocked.clone());
        Box::pin(async move {
            let host = name.as_str();
            let addresses = resolver.resolve(host).await?;
            if let Some(bad) = addresses.iter().find(|address| is_blocked(**address)) {
                return Err(Box::new(BlockedHost { host: host.to_owned(), address: *bad }) as _);
            }
            if addresses.is_empty() {
                return Err(format!("{host} has no address").into());
            }
            Ok(Box::new(addresses.into_iter().map(|ip| SocketAddr::new(ip, 0))) as Addrs)
        })
    }
}

/// The guarded GET. Cheap to clone; clones share connections.
#[derive(Clone)]
pub struct SafeFetcher {
    client: reqwest::Client,
    is_blocked: BlockedFn,
}

impl fmt::Debug for SafeFetcher {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SafeFetcher").finish_non_exhaustive()
    }
}

impl SafeFetcher {
    /// With the system's resolver and the real address rules.
    pub fn new() -> Result<Self, Error> {
        Self::with(Arc::new(SystemResolver), is_blocked_ip)
    }

    /// With another resolver or other address rules (tests serve from loopback).
    pub fn with(
        resolver: Arc<dyn Resolver>,
        is_blocked: impl Fn(IpAddr) -> bool + Send + Sync + 'static,
    ) -> Result<Self, Error> {
        let is_blocked: BlockedFn = Arc::new(is_blocked);
        let mut options = ClientOptions::new("");
        options.pool_max_idle_per_host = 2;
        options.pool_idle_timeout = Duration::from_secs(30);
        let client = builder(&options)
            // Every hop is ours to check.
            .redirect(reqwest::redirect::Policy::none())
            .referer(false)
            .dns_resolver(Arc::new(GuardedResolver { resolver, is_blocked: is_blocked.clone() }))
            .build()
            .map_err(|e| Error::Client(e.to_string()))?;
        Ok(Self { client, is_blocked })
    }

    pub async fn get(&self, url: &str, options: &SafeGetOptions) -> Result<SafeResponse, Error> {
        match tokio::time::timeout(options.timeout, self.follow(url, options)).await {
            Ok(result) => result,
            Err(_) => Err(Error::Timeout((options.timeout.as_secs_f64()).round() as u64)),
        }
    }

    async fn follow(&self, raw: &str, options: &SafeGetOptions) -> Result<SafeResponse, Error> {
        let mut url = check_url_with(raw, &*self.is_blocked)?;
        let mut hop = 0;
        loop {
            let mut response = self
                .client
                .get(url.clone())
                .header(USER_AGENT, &options.user_agent)
                .header(ACCEPT, options.accept.as_deref().unwrap_or("*/*"))
                .send()
                .await
                .map_err(network_error)?;
            let status = response.status().as_u16();

            let location = response.headers().get(LOCATION).map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned());
            if let (301 | 302 | 303 | 307 | 308, Some(location)) = (status, location) {
                if hop >= options.max_redirects {
                    return Err(Error::Redirects(options.max_redirects));
                }
                hop += 1;
                let next =
                    url.join(&location).map_err(|_| Error::Network("the redirect target is not a URL".to_owned()))?;
                url = check_url_with(next.as_str(), &*self.is_blocked)?;
                continue;
            }
            if !(200..300).contains(&status) {
                return Err(Error::Status(status));
            }

            let header =
                |name| response.headers().get(name).and_then(|v| v.to_str().ok()).unwrap_or_default().to_owned();
            let content_type = header(CONTENT_TYPE).split(';').next().unwrap_or_default().trim().to_ascii_lowercase();
            if options.accept_type.is_some_and(|accepts| !accepts(&content_type)) {
                let what = if content_type.is_empty() { "a response without a type".to_owned() } else { content_type };
                return Err(Error::Type(what));
            }
            if let Ok(declared) = header(CONTENT_LENGTH).parse::<u64>()
                && declared > options.max_bytes as u64
            {
                return Err(Error::TooLarge(format!("{declared} bytes, max {}", options.max_bytes)));
            }

            // Read the decoded body, stopping the moment it passes the cap — a
            // small compressed response cannot expand past it either.
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(network_error)? {
                if body.len() + chunk.len() > options.max_bytes {
                    return Err(Error::TooLarge(format!("more than {} bytes", options.max_bytes)));
                }
                body.extend_from_slice(&chunk);
            }
            return Ok(SafeResponse {
                url: url.to_string(),
                status,
                content_type,
                headers: response.headers().clone(),
                body: Bytes::from(body),
            });
        }
    }
}

/// The resolver's refusal arrives wrapped by the client's layers: dig it out.
fn network_error(error: reqwest::Error) -> Error {
    let mut source: Option<&(dyn StdError + 'static)> = Some(&error);
    let mut innermost = error.to_string();
    while let Some(e) = source {
        if let Some(blocked) = e.downcast_ref::<BlockedHost>() {
            return Error::Blocked(blocked.to_string());
        }
        innermost = e.to_string();
        source = e.source();
    }
    Error::Network(innermost)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blocked(url: &str) -> String {
        match check_url(url) {
            Err(Error::Blocked(message)) => message,
            other => panic!("{url} should be blocked, got {other:?}"),
        }
    }

    #[test]
    fn schemes_other_than_http_are_refused() {
        for url in ["file:///etc/passwd", "ftp://example.com/a", "data:image/png;base64,AA", "javascript:alert(1)"] {
            assert!(blocked(url).contains("http(s) only"), "{url}");
        }
        assert_eq!(blocked("file:///etc/passwd"), "file: URLs are not fetched — http(s) only");
        assert_eq!(blocked("not a url"), "\"not a url\" is not a URL");
    }

    #[test]
    fn credentials_and_private_literals_are_refused() {
        assert!(blocked("http://user:pw@example.com/").contains("credentials"));
        assert!(blocked("http://user@example.com/").contains("credentials"));
        // The URL parser normalizes the odd IPv4 spellings, so these are all loopback.
        for url in [
            "http://127.1/",
            "http://2130706433/",
            "http://0x7f.0.0.1/",
            "http://[::1]:7400/",
            "http://[::ffff:127.0.0.1]/",
            "http://169.254.169.254/latest/meta-data",
        ] {
            assert!(blocked(url).contains("private or local"), "{url}");
        }
        assert_eq!(blocked("http://127.1/"), "127.0.0.1 is a private or local address");
        assert_eq!(blocked("http://[::1]:7400/"), "::1 is a private or local address");
    }

    #[test]
    fn a_public_url_passes() {
        let url = check_url("https://example.com/a.png").expect("allowed");
        assert_eq!(url.host_str(), Some("example.com"));
        assert!(check_url("http://93.184.216.34/").is_ok());
    }

    #[test]
    fn errors_carry_todays_codes() {
        assert_eq!(Error::Blocked(String::new()).code(), "blocked");
        assert_eq!(Error::Redirects(3).code(), "redirects");
        assert_eq!(Error::Redirects(3).to_string(), "more than 3 redirects");
        assert_eq!(Error::Timeout(8).to_string(), "no answer within 8 s");
        assert_eq!(Error::TooLarge(String::new()).code(), "too-large");
        assert_eq!(Error::Type("text/html".to_owned()).to_string(), "text/html is not what was asked for");
        assert_eq!((Error::Status(404).code(), Error::Status(404).status()), ("status", Some(404)));
        assert_eq!(Error::Status(404).to_string(), "the server answered 404");
        assert_eq!(Error::Network(String::new()).code(), "network");
    }
}
