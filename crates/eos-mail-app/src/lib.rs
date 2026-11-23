//! The `mail` built-in capability: the Mail app on this Mac, driven through
//! JavaScript for Automation (decisions D33). Eos holds no mail secret: Mail
//! keeps the accounts, and macOS asks the user once to let Eos drive it.
//!
//! [`MailApp`] answers `BuiltinCapability`: it lists and reads the mail of
//! the inboxes inside the last [`WINDOW_HOURS`], polls the inbox for mail it
//! has not seen (by RFC Message-ID, the first poll only marking what is
//! there), and sends one plain mail to one address. Its health check asks
//! Mail for its accounts; a refused Apple Event (-1743) reads as
//! `automation_denied`, a step the user takes. Every action is bounded by
//! its timeout.
//!
//! Every program goes through a [`Script`]: [`Osascript`] only when the host
//! hands it in, a fake in tests. Logs carry the action, its outcome and
//! counts; never an address, a subject or a mail's text.

mod jxa;
mod manifest;
mod script;

use std::collections::HashSet;
use std::sync::Arc;

use eos_core::capability::{ActionContext, ActionError, BuiltinCapability, FailureKind};
use eos_core::{BoxFuture, Clock, Sleeper};
use eos_domain::capability::health::{Event, StateCode};
use eos_domain::capability::manifest::{DEFAULT_TIMEOUT_S, Manifest};
use serde_json::{Value, json};

pub use manifest::{ID, MESSAGE, WINDOW_HOURS};
pub use script::{NOT_PERMITTED, Osascript, Program, Script, ScriptError};

/// The most messages one poll reads.
const POLL_MAX: i64 = 200;
/// How often the inbox is read again.
const POLL_AFTER_S: i64 = 60;
const HOUR_MS: i64 = 60 * 60 * 1000;

/// What the capability is built on.
pub struct Parts {
    pub script: Arc<dyn Script>,
    pub clock: Arc<dyn Clock>,
    pub sleeper: Arc<dyn Sleeper>,
}

pub struct MailApp {
    manifest: Manifest,
    script: Arc<dyn Script>,
    clock: Arc<dyn Clock>,
    sleeper: Arc<dyn Sleeper>,
}

impl std::fmt::Debug for Parts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Parts").finish_non_exhaustive()
    }
}

impl std::fmt::Debug for MailApp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MailApp").finish_non_exhaustive()
    }
}

/// How a program that gave no answer reads to the caller.
fn action_error(error: &ScriptError) -> ActionError {
    match error {
        ScriptError::Denied => ActionError::NotReady(StateCode::AutomationDenied.as_string()),
        ScriptError::Timeout => ActionError::Timeout,
        ScriptError::BadOutput => ActionError::Failed { kind: FailureKind::Output },
        ScriptError::Failed(_) => ActionError::Failed { kind: FailureKind::Service },
    }
}

fn strings(value: &Value) -> impl Iterator<Item = &str> {
    value.as_array().into_iter().flatten().filter_map(Value::as_str)
}

impl MailApp {
    pub fn new(parts: Parts) -> Self {
        Self { manifest: manifest::manifest(), script: parts.script, clock: parts.clock, sleeper: parts.sleeper }
    }

    async fn script(&self, program: Program, input: Value) -> Result<Value, ActionError> {
        self.script.run(program, input).await.map_err(|error| action_error(&error))
    }

    /// Runs `action`, or answers `Timeout` once its time is up.
    async fn bounded(&self, action: &str, input: Value) -> Result<Value, ActionError> {
        let timeout_s = self.manifest.action(action).map_or(DEFAULT_TIMEOUT_S, |action| action.timeout_s);
        let answered = tokio::select! {
            answered = self.run(action, input) => answered,
            () = self.sleeper.sleep(i64::from(timeout_s) * 1000) => Err(ActionError::Timeout),
        };
        if let Err(error) = &answered {
            tracing::info!(capability = ID, action, kind = error.kind(), "a mail action failed");
        }
        answered
    }

    async fn run(&self, action: &str, input: Value) -> Result<Value, ActionError> {
        match action {
            "check" => Ok(json!({ "ok": self.accounts().await? > 0 })),
            "recent_mail" => {
                let hours = input["hours"].as_i64().unwrap_or(WINDOW_HOURS).clamp(1, WINDOW_HOURS);
                let limit = input["limit"].as_i64().unwrap_or(20);
                let since = self.clock.now_ms() - hours * HOUR_MS;
                self.script(Program::Recent, json!({ "since": since, "limit": limit })).await
            }
            "read_mail" => self.script(Program::Read, json!({ "messageId": input["messageId"] })).await,
            "poll_inbox" => self.poll(&input).await,
            "send_mail" => self.send(&input).await,
            _ => Err(ActionError::NotFound),
        }
    }

    async fn accounts(&self) -> Result<i64, ActionError> {
        Ok(self.script(Program::Check, json!({})).await?["accounts"].as_i64().unwrap_or(0))
    }

    /// The inbox mail of the window that the cursor has not seen. The first
    /// poll (no cursor) only marks what is already there.
    async fn poll(&self, input: &Value) -> Result<Value, ActionError> {
        let cursor = input.get("cursor").filter(|cursor| !cursor.is_null());
        let seen: HashSet<&str> = cursor.map(|cursor| strings(&cursor["seen"]).collect()).unwrap_or_default();
        let since = self.clock.now_ms() - WINDOW_HOURS * HOUR_MS;
        let read = self.script(Program::Recent, json!({ "since": since, "limit": POLL_MAX })).await?;
        let messages = read["messages"].as_array().cloned().unwrap_or_default();
        let mut items = Vec::new();
        let mut window = Vec::new();
        for message in &messages {
            let Some(id) = message["messageId"].as_str().filter(|id| !id.is_empty()) else { continue };
            window.push(id.to_owned());
            if seen.contains(id) {
                continue;
            }
            items.push(json!({
                "key": format!("mail:{id}"),
                "event": "received",
                "title": message["subject"],
                "updatedAt": message["receivedAt"],
                "facts": { "from": message["from"] },
            }));
        }
        let baseline = cursor.is_none();
        tracing::debug!(capability = ID, new = items.len(), baseline, "the inbox was read");
        Ok(json!({
            "items": if baseline { Vec::new() } else { items },
            "cursor": { "seen": window },
            "pollAfterS": POLL_AFTER_S,
            "baseline": baseline,
        }))
    }

    async fn send(&self, input: &Value) -> Result<Value, ActionError> {
        let program = json!({ "to": input["to"], "subject": input["subject"], "body": input["body"] });
        let sent = self.script(Program::Send, program).await?;
        if sent["sent"] != true {
            return Err(ActionError::Failed { kind: FailureKind::Service });
        }
        tracing::info!(capability = ID, action = "send_mail", "a mail went out");
        Ok(json!({ "sent": true }))
    }

    /// What Mail says of its accounts.
    async fn probe(&self) -> Event {
        let checked = tokio::select! {
            checked = self.accounts() => checked,
            () = self.sleeper.sleep(i64::from(DEFAULT_TIMEOUT_S) * 1000) => Err(ActionError::Timeout),
        };
        match checked {
            Ok(accounts) if accounts > 0 => Event::Passed,
            Err(ActionError::NotReady(_)) => Event::Missing(StateCode::AutomationDenied),
            _ => Event::CheckFailed,
        }
    }
}

impl BuiltinCapability for MailApp {
    fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    fn call<'a>(
        &'a self,
        action: &'a str,
        input: Value,
        _ctx: &'a ActionContext,
    ) -> BoxFuture<'a, Result<Value, ActionError>> {
        Box::pin(self.bounded(action, input))
    }

    fn health<'a>(&'a self, _ctx: &'a ActionContext) -> BoxFuture<'a, Event> {
        Box::pin(self.probe())
    }
}
