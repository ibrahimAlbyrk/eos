//! Which capabilities there are, who may call what, and the code that
//! answers: Eos's own built-ins and the runner of installed packages.

use std::collections::HashMap;
use std::fmt;
use std::time::Duration;

use eos_contracts::ActionClass;
use eos_domain::capability::health::{Event, Health};
use eos_domain::capability::manifest::Manifest;
use serde_json::Value;
use zeroize::Zeroizing;

use super::{ActionError, BrowserSignIn, DeviceSignIn};
use crate::{BoxFuture, Error};

/// The most capabilities installed besides the built-ins.
pub const INSTALLED_MAX: usize = 50;

/// One capability on this computer. Settings and the account label are the
/// user's: never logged.
#[derive(Debug, Clone, PartialEq)]
pub struct Capability {
    pub id: String,
    /// `builtin`, `forge`, `registry` or `synced`.
    pub origin: String,
    /// The active version; none for a built-in.
    pub version: Option<String>,
    pub manifest: Manifest,
    pub health: Health,
    /// Its settings, a JSON object.
    pub settings: Value,
    pub account_label: Option<String>,
}

/// The capabilities there are, read fresh on every call: one installed
/// after a session started is there on its next call.
pub trait CapabilityRegistry: Send + Sync {
    /// Every capability, by id.
    fn list(&self) -> BoxFuture<'_, Result<Vec<Capability>, Error>>;
    fn get<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<Capability>, Error>>;
    /// The class of the action; `None` when there is no such action.
    fn class_of<'a>(&'a self, id: &'a str, action: &'a str) -> BoxFuture<'a, Result<Option<ActionClass>, Error>>;
    fn state<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<Health>, Error>>;
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct GrantedAction {
    pub capability: String,
    pub action: String,
}

/// What a worker may call: the actions listed, of no class above `max_class`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grant {
    pub actions: Vec<GrantedAction>,
    pub max_class: ActionClass,
}

/// An action of a class above writing locally that a run session calls,
/// before it runs.
#[derive(Debug, Clone, PartialEq)]
pub struct RunAction {
    pub worker_id: String,
    pub capability: String,
    pub action: String,
    pub class: ActionClass,
    /// The input the agent gave, as its schema checked it.
    pub input: Value,
    /// Who it reaches, as its manifest's `recipient` reads it from the
    /// input; `None` when it names no one.
    pub recipient: Option<String>,
    /// It reaches the user only (`recipient = "user"`).
    pub to_user: bool,
}

/// What the run's gate does with a [`RunAction`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunActionDecision {
    /// It runs now (telling the user).
    Run,
    /// It goes out through the delivery as this row, by itself.
    Queued { delivery_id: String },
    /// It waits for the user in Needs you as this draft.
    Held { item_id: String },
    /// It does not go, for this reason the agent reads.
    Refused { reason: String },
}

/// The grant a routine run gives its workers, and the gate their sends
/// pass.
pub trait CapabilityGrants: Send + Sync {
    /// `None` when the worker has no grant of its own: it may call every
    /// installed action (an Agents chat).
    fn grant<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, Option<Grant>>;
    /// What becomes of an action a worker with a grant calls that tells the
    /// user, speaks for them or cannot be taken back: the routine's Freedom
    /// decides, as for its result. Without a gate nothing goes.
    fn gate<'a>(&'a self, _action: &'a RunAction) -> BoxFuture<'a, Result<RunActionDecision, Error>> {
        Box::pin(std::future::ready(Ok(RunActionDecision::Refused { reason: NO_GATE.to_owned() })))
    }
}

/// Why a run's send is refused when nothing gates it.
pub const NO_GATE: &str = "Nothing can send for this run now.";

/// No worker has a grant of its own: Agents chats, until runs grant theirs.
#[derive(Debug, Default, Clone, Copy)]
pub struct AllInstalled;

impl CapabilityGrants for AllInstalled {
    fn grant<'a>(&'a self, _worker_id: &'a str) -> BoxFuture<'a, Option<Grant>> {
        Box::pin(std::future::ready(None))
    }
}

/// What a call hands the code that answers it.
pub struct ActionContext {
    /// The capability's secrets, by their names in its manifest.
    pub secrets: HashMap<String, Zeroizing<String>>,
    /// Its settings, a JSON object.
    pub settings: Value,
    pub idempotency_key: Option<String>,
}

impl fmt::Debug for ActionContext {
    // Names only: values and settings never reach a log.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut secrets: Vec<&str> = self.secrets.keys().map(String::as_str).collect();
        secrets.sort_unstable();
        f.debug_struct("ActionContext").field("secrets", &secrets).finish_non_exhaustive()
    }
}

/// A capability that is Eos's own Rust code (GitHub, Mail, notify).
pub trait BuiltinCapability: Send + Sync {
    /// Passes `eos_domain::capability::check::check_builtin`.
    fn manifest(&self) -> &Manifest;
    /// Runs one action on input that fits its schema.
    fn call<'a>(
        &'a self,
        action: &'a str,
        input: Value,
        ctx: &'a ActionContext,
    ) -> BoxFuture<'a, Result<Value, ActionError>>;
    /// Its health check: what it found.
    fn health<'a>(&'a self, ctx: &'a ActionContext) -> BoxFuture<'a, Event>;
    /// How the user signs in to it with a code on the service's own page;
    /// `None` when it does not sign in that way.
    fn device_sign_in(&self) -> Option<&dyn DeviceSignIn> {
        None
    }
    /// How the user signs in to it in the browser; `None` when it does not
    /// sign in that way.
    fn browser_sign_in(&self) -> Option<&dyn BrowserSignIn> {
        None
    }
    /// Secrets it keeps beside the ones its manifest declares, such as a
    /// sign-in's refresh token: they are forgotten with any of its secrets.
    fn undeclared_secrets(&self) -> &[&'static str] {
        &[]
    }
}

/// An installed package's version, as its runner needs it.
#[derive(Debug, Clone, PartialEq)]
pub struct Package {
    pub id: String,
    pub version: String,
    pub manifest: Manifest,
}

/// Runs the actions of `script` and `mcp` packages, confined.
pub trait ActionRunner: Send + Sync {
    /// Runs one action. `env` hands each secret to the variable its manifest
    /// names.
    fn run<'a>(
        &'a self,
        package: &'a Package,
        action: &'a str,
        input: Value,
        env: Vec<(String, Zeroizing<String>)>,
        timeout: Duration,
    ) -> BoxFuture<'a, Result<Value, ActionError>>;
    /// Stops whatever runs for capability `id` (its MCP server) once its
    /// calls end.
    fn stop<'a>(&'a self, id: &'a str) -> BoxFuture<'a, ()>;
}
