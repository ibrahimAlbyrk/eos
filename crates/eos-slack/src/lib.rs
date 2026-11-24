//! The `slack` built-in capability: Slack's Web API as the user who signed
//! in (a user token, D61).
//!
//! [`Slack`] answers `BuiltinCapability`: it lists the user's conversations
//! and people, reads a conversation or a thread, searches, posts as the user
//! to a channel, a person or a thread with every broadcast escaped and no
//! link unfurled, finds a post again by the marker in its metadata, deletes
//! one, and polls a conversation or the user's mentions for new messages
//! (D62). Its health check is `auth.test` with the scopes it asks for. It
//! signs in in the browser with PKCE and no client secret
//! (`BrowserSignIn`, D60), with the client id from `slack.clientId`, and
//! keeps the rotating token pair as one secret, `token`.
//!
//! Every exchange goes through a [`Transport`]: [`HttpTransport`] in the
//! app, `FakeSlack` in tests. Logs carry methods, conversation ids, Slack's
//! error codes and counts; never a message, a name, the workspace's name,
//! the token, the code, the verifier or the state.

mod actions;
mod client;
mod manifest;
mod rate;
mod sends;
mod sign_in;
mod source;
mod token;

use std::sync::{Arc, Mutex};

use eos_core::capability::{
    ActionContext, ActionError, BrowserSignIn, BuiltinCapability, CapabilitySecrets, FailureKind,
};
use eos_core::{BoxFuture, Clock, Ids, Sleeper};
use eos_domain::capability::health::{Event, StateCode};
use eos_domain::capability::manifest::{DEFAULT_TIMEOUT_S, Manifest};
use serde_json::Value;

pub use client::{API, HttpRequest, HttpResponse, HttpTransport, Transport};
pub use manifest::{CONVERSATION, ID, MESSAGE, PERMALINK, TEXT_MAX, TOKEN};
pub use sign_in::{AUTHORIZE, REDIRECT, USER_SCOPES};

/// Why a call is refused when the token lacks a scope Eos asks for.
pub(crate) const SCOPE_MISSING: &str = "scope_missing";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// No answer came: the network, TLS, or the client could not be built.
    #[error("Slack could not be reached: {0}")]
    Transport(String),
}

/// What the capability is built on.
pub struct Parts {
    pub transport: Arc<dyn Transport>,
    /// Where the sign-in keeps its token pair.
    pub secrets: Arc<dyn CapabilitySecrets>,
    pub clock: Arc<dyn Clock>,
    pub sleeper: Arc<dyn Sleeper>,
    /// The sign-in's state and code verifier.
    pub ids: Arc<dyn Ids>,
    /// The Slack app's client id; empty, the sign-in cannot start.
    pub client_id: String,
}

impl std::fmt::Debug for Parts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Parts").field("client_id_set", &!self.client_id.is_empty()).finish_non_exhaustive()
    }
}

pub struct Slack {
    manifest: Manifest,
    transport: Arc<dyn Transport>,
    secrets: Arc<dyn CapabilitySecrets>,
    clock: Arc<dyn Clock>,
    sleeper: Arc<dyn Sleeper>,
    ids: Arc<dyn Ids>,
    client_id: String,
    rate: rate::Buckets,
    /// The pair refreshed here last, newer than a call's secret may be.
    latest: Mutex<Option<token::TokenPair>>,
    refreshing: tokio::sync::Mutex<()>,
    people: actions::People,
    turns: source::Turns,
}

impl std::fmt::Debug for Slack {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Slack").field("client_id_set", &!self.client_id.is_empty()).finish_non_exhaustive()
    }
}

impl Slack {
    pub fn new(parts: Parts) -> Self {
        Self {
            manifest: manifest::manifest(),
            transport: parts.transport,
            secrets: parts.secrets,
            clock: parts.clock,
            sleeper: parts.sleeper,
            ids: parts.ids,
            client_id: parts.client_id.trim().to_owned(),
            rate: rate::Buckets::default(),
            latest: Mutex::default(),
            refreshing: tokio::sync::Mutex::new(()),
            people: actions::People::default(),
            turns: source::Turns::default(),
        }
    }

    /// Runs `action`, or answers `Timeout` once its time is up.
    async fn bounded(&self, action: &str, input: Value, ctx: &ActionContext) -> Result<Value, ActionError> {
        let timeout_s = self.manifest.action(action).map_or(DEFAULT_TIMEOUT_S, |action| action.timeout_s);
        tokio::select! {
            answered = self.run(action, input, ctx) => answered,
            () = self.sleeper.sleep(i64::from(timeout_s) * 1000) => {
                tracing::info!(capability = ID, action, "a Slack action ran out of time");
                Err(ActionError::Timeout)
            }
        }
    }

    async fn run(&self, action: &str, input: Value, ctx: &ActionContext) -> Result<Value, ActionError> {
        match action {
            "check" => self.check(ctx).await,
            "list_conversations" => self.list_conversations(&input, ctx).await,
            "find_people" => self.find_people(&input, ctx).await,
            "read_conversation" => self.read_messages(&input, ctx, false).await,
            "read_thread" => self.read_messages(&input, ctx, true).await,
            "search_messages" => self.search_messages(&input, ctx).await,
            "find_messages" => self.find_messages(&input, ctx).await,
            "poll_messages" => self.poll_messages(&input, ctx).await,
            "poll_mentions" => self.poll_mentions(&input, ctx).await,
            "find_delivery" => self.find_delivery(&input, ctx).await,
            "post_message" => self.post_message(&input, ctx).await,
            "reply_in_thread" => self.reply_in_thread(&input, ctx).await,
            "tell_me" => self.tell_me(&input, ctx).await,
            "delete_message" => self.delete_message(&input, ctx).await,
            _ => Err(ActionError::NotFound),
        }
    }

    /// What `auth.test` and the token's scopes say of the sign-in.
    async fn probe(&self, ctx: &ActionContext) -> Event {
        if self.client_id.is_empty() {
            return Event::Missing(StateCode::ClientIdMissing);
        }
        let checked = tokio::select! {
            checked = self.scopes(ctx) => checked,
            () = self.sleeper.sleep(i64::from(DEFAULT_TIMEOUT_S) * 1000) => Err(ActionError::Timeout),
        };
        match checked {
            Ok(scopes) if USER_SCOPES.iter().all(|scope| scopes.iter().any(|has| has == scope)) => Event::Passed,
            Ok(_) => Event::ScopeMissing,
            Err(ActionError::NotReady(code)) if code == SCOPE_MISSING => Event::ScopeMissing,
            Err(ActionError::NotReady(_)) => Event::Missing(StateCode::SecretMissing(TOKEN.to_owned())),
            Err(ActionError::Failed { kind: FailureKind::Unauthorized }) => Event::Unauthorized,
            Err(ActionError::RateLimited { .. }) => Event::RateLimited,
            Err(_) => Event::CheckFailed,
        }
    }
}

impl BuiltinCapability for Slack {
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

    fn browser_sign_in(&self) -> Option<&dyn BrowserSignIn> {
        Some(self)
    }
}
