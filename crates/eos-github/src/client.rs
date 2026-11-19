//! The seam to GitHub: one HTTP exchange at a time through a [`Transport`]
//! (`reqwest` in the app, `FakeGitHub` in tests), and the REST calls on top
//! of it with the token, the rate bucket and the mapping of GitHub's
//! answers to `ActionError`.

use std::fmt;

use eos_core::BoxFuture;
use eos_core::capability::{ActionError, FailureKind};
use serde_json::Value;

use crate::{Error, GitHub};

/// GitHub's REST API.
pub const API: &str = "https://api.github.com";
/// GitHub's own site, where the device flow runs.
pub const WEB: &str = "https://github.com";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Method {
    Get,
    Post,
    Put,
    Delete,
}

/// One request. Its headers carry the token: never logged.
pub struct HttpRequest {
    pub method: Method,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

impl fmt::Debug for HttpRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HttpRequest").field("method", &self.method).finish_non_exhaustive()
    }
}

impl HttpRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        find(&self.headers, name)
    }
}

/// One answer, whatever its status.
#[derive(Debug, Clone, Default)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        find(&self.headers, name)
    }

    pub(crate) fn json(&self) -> Result<Value, ActionError> {
        serde_json::from_slice(&self.body).map_err(|_| ActionError::Failed { kind: FailureKind::Service })
    }
}

fn find<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
}

/// Sends one request and answers whatever status came back; fails only when
/// no answer came.
pub trait Transport: Send + Sync {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, Error>>;
}

/// The app's transport: a `reqwest` client from `eos_kit_net`.
#[derive(Debug, Clone)]
pub struct HttpTransport {
    client: reqwest::Client,
}

impl HttpTransport {
    pub fn new() -> Result<Self, Error> {
        let options = eos_kit_net::ClientOptions::new(concat!("Eos/", env!("CARGO_PKG_VERSION")));
        let client = eos_kit_net::http_client(&options).map_err(|e| Error::Transport(e.to_string()))?;
        Ok(Self { client })
    }
}

impl Transport for HttpTransport {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, Error>> {
        Box::pin(async move {
            let method = match request.method {
                Method::Get => reqwest::Method::GET,
                Method::Post => reqwest::Method::POST,
                Method::Put => reqwest::Method::PUT,
                Method::Delete => reqwest::Method::DELETE,
            };
            let mut builder = self.client.request(method, &request.url);
            for (name, value) in &request.headers {
                builder = builder.header(name, value);
            }
            if let Some(body) = request.body {
                builder = builder.body(body);
            }
            // reqwest's error names the URL, never a header.
            let response = builder.send().await.map_err(|e| Error::Transport(e.without_url().to_string()))?;
            let status = response.status().as_u16();
            let headers = response
                .headers()
                .iter()
                .filter_map(|(name, value)| Some((name.as_str().to_owned(), value.to_str().ok()?.to_owned())))
                .collect();
            let body = response.bytes().await.map_err(|e| Error::Transport(e.without_url().to_string()))?.to_vec();
            Ok(HttpResponse { status, headers, body })
        })
    }
}

/// The phrases inside a 422's `errors[]`: strings, or objects with a
/// `message`. `message` itself differs by path and is never matched.
fn error_phrases(body: &Value) -> String {
    let errors = body.get("errors").and_then(Value::as_array).into_iter().flatten();
    let phrases: Vec<&str> = errors.filter_map(|error| error.as_str().or_else(|| error["message"].as_str())).collect();
    phrases.join("\n")
}

/// Whether GitHub refused for the rate (403 or 429 with its rate headers).
fn rate_limited(response: &HttpResponse) -> bool {
    matches!(response.status, 403 | 429)
        && (response.header("retry-after").is_some() || response.header("x-ratelimit-remaining") == Some("0"))
}

impl GitHub {
    /// One REST call with `token`. Writes take a slot of the rate bucket
    /// first; while GitHub asked to wait, nothing is sent. A 304 is an
    /// answer like a 2xx.
    pub(crate) async fn request(
        &self,
        token: &str,
        method: Method,
        path: &str,
        body: Option<Value>,
        extra: &[(&str, &str)],
    ) -> Result<HttpResponse, ActionError> {
        self.rate.admit(method != Method::Get, self.clock.now_ms())?;
        let mut headers = vec![
            ("accept".to_owned(), "application/vnd.github+json".to_owned()),
            ("x-github-api-version".to_owned(), "2022-11-28".to_owned()),
            ("authorization".to_owned(), format!("Bearer {token}")),
        ];
        headers.extend(extra.iter().map(|(name, value)| ((*name).to_owned(), (*value).to_owned())));
        if body.is_some() {
            headers.push(("content-type".to_owned(), "application/json".to_owned()));
        }
        let request = HttpRequest {
            method,
            url: format!("{API}{path}"),
            headers,
            body: body.map(|body| body.to_string().into_bytes()),
        };
        let response = self.transport.send(request).await.map_err(|e| {
            tracing::warn!(host = "api.github.com", error = %e, "GitHub could not be reached");
            ActionError::Failed { kind: FailureKind::Service }
        })?;
        if (200..300).contains(&response.status) || response.status == 304 {
            return Ok(response);
        }
        tracing::info!(host = "api.github.com", status = response.status, "GitHub refused a request");
        if rate_limited(&response) {
            let retry_after_s = self.rate.blocked_by(&response, self.clock.now_ms());
            return Err(ActionError::RateLimited { retry_after_s });
        }
        let kind = match response.status {
            401 => FailureKind::Unauthorized,
            422 => {
                let phrases = response.json().map(|body| error_phrases(&body)).unwrap_or_default();
                if phrases.contains("one pending review per pull request") {
                    FailureKind::UserDraftInProgress
                } else if phrases.contains("your own pull request") {
                    FailureKind::NotAllowed
                } else {
                    FailureKind::Validation
                }
            }
            404 => FailureKind::Gone,
            500.. => FailureKind::Service,
            _ => FailureKind::Validation,
        };
        Err(ActionError::Failed { kind })
    }

    /// A GET's JSON answer.
    pub(crate) async fn get(&self, token: &str, path: &str) -> Result<Value, ActionError> {
        self.request(token, Method::Get, path, None, &[]).await?.json()
    }

    /// A write's JSON answer.
    pub(crate) async fn send_json(
        &self,
        token: &str,
        method: Method,
        path: &str,
        body: Value,
    ) -> Result<Value, ActionError> {
        self.request(token, method, path, Some(body), &[]).await?.json()
    }

    /// A DELETE, whose answer is not read.
    pub(crate) async fn delete(&self, token: &str, path: &str) -> Result<(), ActionError> {
        self.request(token, Method::Delete, path, None, &[]).await.map(drop)
    }
}
