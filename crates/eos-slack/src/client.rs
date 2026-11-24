//! The seam to Slack: one HTTP exchange at a time through a [`Transport`]
//! (`reqwest` in the app, `FakeSlack` in tests), and Web API calls on top of
//! it. Every call is a form `POST` to `https://slack.com/api/<method>`;
//! Slack answers most refusals with HTTP 200 and `{"ok": false, "error"}`,
//! so `ok` is read before anything else. Its error codes become
//! `ActionError`s (06 §4.7).

use std::fmt;

use eos_core::BoxFuture;
use eos_core::capability::{ActionError, FailureKind};
use serde_json::Value;

use crate::{Error, Slack};

/// Slack's Web API.
pub const API: &str = "https://slack.com/api";

/// One request. Its headers and body carry the token or a code: never logged.
pub struct HttpRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl fmt::Debug for HttpRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HttpRequest").finish_non_exhaustive()
    }
}

impl HttpRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        find(&self.headers, name)
    }

    /// The Web API method it calls (`chat.postMessage`).
    pub fn method(&self) -> &str {
        self.url.rsplit('/').next().unwrap_or_default()
    }

    /// Its form fields.
    pub fn fields(&self) -> Vec<(String, String)> {
        url::form_urlencoded::parse(&self.body).into_owned().collect()
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
            let mut builder = self.client.post(&request.url);
            for (name, value) in &request.headers {
                builder = builder.header(name, value);
            }
            // reqwest's error names the URL, never a header or the body.
            let response =
                builder.body(request.body).send().await.map_err(|e| Error::Transport(e.without_url().to_string()))?;
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

/// The `ActionError` a Slack error code means.
pub(crate) fn error_of(code: &str) -> ActionError {
    let kind = match code {
        "invalid_auth" | "not_authed" | "token_revoked" | "account_inactive" | "token_expired" => {
            FailureKind::Unauthorized
        }
        "missing_scope" => return ActionError::NotReady(crate::SCOPE_MISSING.to_owned()),
        "ratelimited" => return ActionError::RateLimited { retry_after_s: 60 },
        "channel_not_found" | "thread_not_found" | "message_not_found" | "is_archived" | "user_not_found" => {
            FailureKind::Gone
        }
        "not_in_channel" | "restricted_action" | "cant_delete_message" => FailureKind::NotAllowed,
        "internal_error" | "fatal_error" | "service_unavailable" | "request_timeout" => FailureKind::Service,
        _ => FailureKind::Validation,
    };
    ActionError::Failed { kind }
}

/// What a form field list looks like on the wire.
pub(crate) fn form(fields: &[(&str, &str)]) -> Vec<u8> {
    url::form_urlencoded::Serializer::new(String::new()).extend_pairs(fields).finish().into_bytes()
}

impl Slack {
    /// One Web API call with `token` (none for the sign-in's exchange): the
    /// body of an `ok` answer.
    pub(crate) async fn call(
        &self,
        token: Option<&str>,
        method: &str,
        conversation: Option<&str>,
        fields: &[(&str, &str)],
    ) -> Result<Value, ActionError> {
        self.exchange(token, method, conversation, fields).await.map(|(body, _)| body)
    }

    /// One Web API call: the method's bucket takes a slot first, and while
    /// Slack asked to wait nothing is sent. Answers an `ok` answer's body and
    /// headers.
    pub(crate) async fn exchange(
        &self,
        token: Option<&str>,
        method: &str,
        conversation: Option<&str>,
        fields: &[(&str, &str)],
    ) -> Result<(Value, Vec<(String, String)>), ActionError> {
        self.rate.admit(method, conversation, self.clock.now_ms())?;
        let mut headers = vec![("content-type".to_owned(), "application/x-www-form-urlencoded".to_owned())];
        if let Some(token) = token {
            headers.push(("authorization".to_owned(), format!("Bearer {token}")));
        }
        let request = HttpRequest { url: format!("{API}/{method}"), headers, body: form(fields) };
        let response = self.transport.send(request).await.map_err(|e| {
            tracing::warn!(host = "slack.com", method, error = %e, "Slack could not be reached");
            ActionError::Failed { kind: FailureKind::Service }
        })?;
        if response.status == 429 {
            let retry_after_s = response.header("retry-after").and_then(|s| s.trim().parse().ok()).unwrap_or(60);
            self.rate.blocked(method, retry_after_s, self.clock.now_ms());
            tracing::info!(host = "slack.com", method, retry_after_s, "Slack limited the rate");
            return Err(ActionError::RateLimited { retry_after_s });
        }
        if response.status >= 500 {
            tracing::info!(host = "slack.com", method, status = response.status, "Slack failed a request");
            return Err(ActionError::Failed { kind: FailureKind::Service });
        }
        let body: Value =
            serde_json::from_slice(&response.body).map_err(|_| ActionError::Failed { kind: FailureKind::Service })?;
        if body["ok"] == Value::Bool(true) {
            return Ok((body, response.headers));
        }
        let code = body["error"].as_str().unwrap_or("unknown");
        tracing::info!(host = "slack.com", method, error = code, "Slack refused a request");
        Err(error_of(code))
    }
}
