//! The `github` built-in capability: GitHub's REST API as the account the
//! user signed in with.
//!
//! [`GitHub`] answers `BuiltinCapability`: it reads pull requests, posts a
//! review as one request (line comments outside the diff moved into its
//! body, a marker at its end so a repeated send finds the first), withdraws
//! one, finds the review a delivery sent by its marker, approves, polls a
//! repository's pull requests with conditional requests, and lists pull
//! requests for the user to pick (a repository's, done ones too, for a
//! routine's past items), and registers a webhook that pushes a repository's
//! pull requests to the relay's hook inbox. Its health check
//! is `GET /user` with the `repo` scope. It signs in by GitHub's device flow
//! (`DeviceSignIn`) with the client id from `github.clientId`, and keeps the
//! token with the capability's secrets as `token`. Writes stay under its
//! rate bucket, and every action is bounded by its timeout.
//!
//! Every exchange goes through a [`Transport`]: [`HttpTransport`] in the
//! app, `FakeGitHub` in tests. Logs carry hosts, status codes and kinds;
//! never the token, the codes of a sign-in, the account's name or anything
//! a pull request says.

mod actions;
mod client;
mod device;
mod diff;
mod manifest;
mod rate;
mod reviews;
mod source;
mod webhooks;

use std::sync::Arc;

use eos_core::capability::{
    ActionContext, ActionError, BuiltinCapability, CapabilitySecrets, DeviceSignIn, FailureKind,
};
use eos_core::{BoxFuture, Clock, Sleeper};
use eos_domain::capability::health::{Event, StateCode};
use eos_domain::capability::manifest::{DEFAULT_TIMEOUT_S, Manifest};
use serde_json::Value;

use crate::webhooks::webhook_secret;

pub use client::{API, HttpRequest, HttpResponse, HttpTransport, Method, Transport, WEB};
pub use manifest::{ID, PULL_REQUEST, TOKEN};
pub use rate::{WRITES_PER_HOUR, WRITES_PER_MINUTE};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// No answer came: the network, TLS, or the client could not be built.
    #[error("GitHub could not be reached: {0}")]
    Transport(String),
}

/// What the capability is built on.
pub struct Parts {
    pub transport: Arc<dyn Transport>,
    /// Where the sign-in keeps its token.
    pub secrets: Arc<dyn CapabilitySecrets>,
    pub clock: Arc<dyn Clock>,
    pub sleeper: Arc<dyn Sleeper>,
    /// The OAuth App's client id; empty, the sign-in cannot start.
    pub client_id: String,
}

pub struct GitHub {
    manifest: Manifest,
    transport: Arc<dyn Transport>,
    secrets: Arc<dyn CapabilitySecrets>,
    clock: Arc<dyn Clock>,
    sleeper: Arc<dyn Sleeper>,
    client_id: String,
    rate: rate::RateBucket,
}

impl std::fmt::Debug for GitHub {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GitHub").field("client_id_set", &!self.client_id.is_empty()).finish_non_exhaustive()
    }
}

impl std::fmt::Debug for Parts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Parts").field("client_id_set", &!self.client_id.is_empty()).finish_non_exhaustive()
    }
}

impl GitHub {
    pub fn new(parts: Parts) -> Self {
        Self {
            manifest: manifest::manifest(),
            transport: parts.transport,
            secrets: parts.secrets,
            clock: parts.clock,
            sleeper: parts.sleeper,
            client_id: parts.client_id.trim().to_owned(),
            rate: rate::RateBucket::default(),
        }
    }

    fn token(ctx: &ActionContext) -> Result<&str, ActionError> {
        ctx.secrets
            .get(TOKEN)
            .map(|token| token.as_str())
            .ok_or_else(|| ActionError::NotReady(StateCode::SecretMissing(TOKEN.to_owned()).as_string()))
    }

    /// Runs `action`, or answers `Timeout` once its time is up. The service
    /// bounds nothing, and a call that hangs would hold one of its slots.
    async fn bounded(&self, action: &str, input: Value, ctx: &ActionContext) -> Result<Value, ActionError> {
        let timeout_s = self.manifest.action(action).map_or(DEFAULT_TIMEOUT_S, |action| action.timeout_s);
        let token = Self::token(ctx)?;
        tokio::select! {
            answered = self.run(action, input, token, ctx.idempotency_key.as_deref(), webhook_secret(ctx)) => answered,
            () = self.sleeper.sleep(i64::from(timeout_s) * 1000) => {
                tracing::info!(capability = ID, action, "a GitHub action ran out of time");
                Err(ActionError::Timeout)
            }
        }
    }

    /// What `GET /user` says of the sign-in.
    async fn probe(&self, ctx: &ActionContext) -> Event {
        if self.client_id.is_empty() {
            return Event::Missing(StateCode::ClientIdMissing);
        }
        let Ok(token) = Self::token(ctx) else { return Event::Missing(StateCode::SecretMissing(TOKEN.to_owned())) };
        let checked = tokio::select! {
            checked = self.check(token) => checked,
            () = self.sleeper.sleep(i64::from(DEFAULT_TIMEOUT_S) * 1000) => Err(ActionError::Timeout),
        };
        match checked {
            Ok(_) => Event::Passed,
            Err(ActionError::Failed { kind: FailureKind::Unauthorized }) => Event::Unauthorized,
            Err(ActionError::RateLimited { .. }) => Event::RateLimited,
            Err(_) => Event::CheckFailed,
        }
    }
}

impl BuiltinCapability for GitHub {
    fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    fn call<'a>(
        &'a self,
        action: &'a str,
        input: Value,
        ctx: &'a ActionContext,
    ) -> BoxFuture<'a, Result<Value, ActionError>> {
        Box::pin(self.bounded(action, input, ctx))
    }

    fn health<'a>(&'a self, ctx: &'a ActionContext) -> BoxFuture<'a, Event> {
        Box::pin(self.probe(ctx))
    }

    fn device_sign_in(&self) -> Option<&dyn DeviceSignIn> {
        Some(self)
    }
}
