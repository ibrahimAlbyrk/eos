//! Ports of the accounts area: where plan sign-ins and API keys are kept, how
//! a provider signs a user in, where plan usage comes from, and the seam
//! between the accounts service and the agent engine
//! (`core/src/ports/PlanLoginStore.ts`, `SubscriptionUsageProvider.ts`,
//! `AgentSession.switchAccount`).
//!
//! No credential type of the engine crosses this module: a session's
//! credential is named by plain data ([`SessionCredential`]) and each side
//! builds what it needs from it.

use std::fmt;
use std::path::PathBuf;

use eos_contracts::ProviderUsage;
use eos_domain::accounts::PlanLoginRegistry;

use crate::{BoxFuture, Error};

// ---- stores ------------------------------------------------------------------

/// The plan sign-in registry on disk (`accounts/logins.json`). It holds no
/// credential, only where each one is stored.
pub trait PlanLoginStore: Send + Sync + 'static {
    /// A missing or unreadable file is an empty registry.
    fn load(&self) -> PlanLoginRegistry;
    fn save(&self, registry: &PlanLoginRegistry) -> Result<(), Error>;
}

/// The credential store folders of plan sign-ins.
pub trait PlanLoginDirs: Send + Sync + 'static {
    /// A fresh, empty store folder for a new sign-in of `provider`.
    fn create(&self, provider: &str, id: &str) -> Result<String, Error>;
    /// The folder of a provider that holds one sign-in.
    fn single(&self, provider: &str) -> String;
    /// Drops a fresh store whose sign-in never finished (it holds no credential).
    fn discard(&self, store_dir: &str);
    /// Moves a signed-out store aside, recoverable by hand.
    fn trash(&self, store_dir: &str) -> Result<(), Error>;
}

/// What a credential store holds, read live.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StoreLogin {
    /// A sign-in is there, even one whose access token lapsed (it renews).
    pub present: bool,
    /// The plan recorded with it (`max`, `pro`, …).
    pub plan: Option<String>,
    /// The account signed in to it, when the store says.
    pub email: Option<String>,
}

/// The credential stores themselves. Every read of a sign-in's token goes
/// through here, so a renewal is made once, under the store's own lock,
/// whoever needs the token (an agent's request, a usage read, the artifact
/// catalog).
pub trait PlanStores: Send + Sync + 'static {
    fn read<'a>(&'a self, provider: &'a str, store_dir: &'a str) -> BoxFuture<'a, StoreLogin>;
    /// The store's access token, renewed first when it lapsed. `None`: not
    /// signed in, or the renewal failed.
    fn access_token<'a>(&'a self, provider: &'a str, store_dir: &'a str) -> BoxFuture<'a, Option<String>>;
    /// Removes the store's sign-in; a store that holds none is not an error.
    fn sign_out<'a>(&'a self, provider: &'a str, store_dir: &'a str) -> BoxFuture<'a, Result<(), Error>>;
}

/// Secrets the system keeps for the user under a service name (provider API
/// keys). Calls may block on a system tool.
pub trait Secrets: Send + Sync + 'static {
    fn read(&self, service: &str) -> Option<String>;
    fn write(&self, service: &str, secret: &str) -> Result<(), Error>;
    fn delete(&self, service: &str);
}

// ---- sign-in -----------------------------------------------------------------

/// The pages of a sign-in under way.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignInPages {
    /// The page to open in a browser on this computer: it comes back by itself.
    pub open: String,
    /// The link the dashboard offers ("Copy link"): for a browser that cannot
    /// reach this computer it ends on a page showing a code to paste.
    pub shown: String,
}

/// What a sign-in calls when its pages are known.
pub type OnPages = Box<dyn FnOnce(SignInPages) + Send>;

/// Who signed in.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SignedIn {
    pub email: Option<String>,
}

/// What a sign-in is given.
pub struct SignInRequest {
    /// The credential store the sign-in writes into.
    pub store_dir: String,
    /// The account expected to sign in (a renewal), pre-filled on the page.
    pub login_hint: Option<String>,
    /// Called once, when the pages are known.
    pub on_pages: OnPages,
    /// Resolves with the code the user pasted, or `None` when none will come.
    pub code: BoxFuture<'static, Option<String>>,
}

impl fmt::Debug for SignInRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SignInRequest").field("store_dir", &self.store_dir).finish_non_exhaustive()
    }
}

/// One provider's official browser sign-in.
pub trait SubscriptionProvider: Send + Sync + 'static {
    /// `anthropic`, `openai`.
    fn id(&self) -> &'static str;
    /// The provider's page may show a code to paste back.
    fn accepts_code(&self) -> bool;
    /// Holds several sign-ins, each in a store of its own; otherwise one, in
    /// [`PlanLoginDirs::single`].
    fn multi_login(&self) -> bool;
    /// Runs the sign-in to its end; the credential is in the store when it
    /// resolves `Ok`. `Err` reads as the dashboard shows it. Dropping the
    /// future cancels the sign-in.
    fn sign_in(&self, request: SignInRequest) -> BoxFuture<'static, Result<SignedIn, String>>;
}

/// Opens a page in the user's browser.
pub trait Browser: Send + Sync + 'static {
    fn open(&self, url: &str);
}

/// Whether a bearer token is still accepted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenProbeResult {
    Valid,
    /// Expired or revoked.
    Rejected,
    /// The network or the provider did not say: never read as expired.
    Unknown,
}

pub trait TokenProbe: Send + Sync + 'static {
    fn probe<'a>(&'a self, token: &'a str) -> BoxFuture<'a, TokenProbeResult>;
}

// ---- usage -------------------------------------------------------------------

/// Why a usage read failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum UsageError {
    /// Nobody is signed in: the last snapshot belongs to no one and is dropped.
    #[error("{0}")]
    NoAccount(String),
    /// The provider or the network failed: the last snapshot is kept, marked stale.
    #[error("{0}")]
    Failed(String),
}

/// What a snapshot is kept and served under: the provider, and the sign-in
/// when the provider holds several.
pub fn usage_key(provider: &str, login_id: Option<&str>) -> String {
    match login_id {
        Some(id) => format!("{provider}:{id}"),
        None => provider.to_owned(),
    }
}

/// One plan's usage snapshot source.
pub trait UsageProvider: Send + Sync + 'static {
    /// [`usage_key`] of the snapshots it makes; echoed into an error entry.
    fn id(&self) -> String;
    fn fetch(&self) -> BoxFuture<'_, Result<ProviderUsage, UsageError>>;
}

/// Claude's plan-usage endpoint, read with one sign-in's access token.
pub trait PlanUsageApi: Send + Sync + 'static {
    /// The snapshot as the endpoint gives it: `provider`, the windows, extra
    /// usage and `fetched_at`. Whose it is (sign-in, plan) is the caller's to
    /// add. `Err` reads as the dashboard shows it.
    fn fetch<'a>(&'a self, token: &'a str) -> BoxFuture<'a, Result<ProviderUsage, String>>;
}

/// Where the last good snapshot per provider survives a restart
/// (`usage-cache.json`, regenerable).
pub trait UsageSnapshotStore: Send + Sync + 'static {
    fn load(&self) -> Vec<ProviderUsage>;
    fn save(&self, snapshots: &[ProviderUsage]) -> Result<(), Error>;
}

// ---- the engine seam ---------------------------------------------------------

/// The credential a session's requests go out on.
#[derive(Clone, PartialEq, Eq)]
pub enum SessionCredential {
    /// A plan sign-in's store: `anthropic` → the Claude sign-in kept for
    /// `dir`, `openai` → the ChatGPT sign-in in `dir`.
    Store { provider: String, dir: PathBuf },
    /// The provider's API key.
    ApiKey { provider: String, key: String },
    /// A fixed bearer token: the setup-token of an install from before
    /// sign-ins had stores, which bills until the next sign-in or sign-out.
    Bearer { provider: String, token: String },
}

impl SessionCredential {
    pub fn provider(&self) -> &str {
        match self {
            SessionCredential::Store { provider, .. }
            | SessionCredential::ApiKey { provider, .. }
            | SessionCredential::Bearer { provider, .. } => provider,
        }
    }
}

impl fmt::Debug for SessionCredential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SessionCredential::Store { provider, dir } => {
                f.debug_struct("Store").field("provider", provider).field("dir", dir).finish()
            }
            SessionCredential::ApiKey { provider, .. } => {
                f.debug_struct("ApiKey").field("provider", provider).finish_non_exhaustive()
            }
            SessionCredential::Bearer { provider, .. } => {
                f.debug_struct("Bearer").field("provider", provider).finish_non_exhaustive()
            }
        }
    }
}

/// The plan-limit state a response carried.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PlanLimits {
    /// `allowed`, `allowed_warning`, `rejected`.
    pub status: Option<String>,
    /// The window that binds: `five_hour` or `seven_day`.
    pub claim: Option<String>,
    /// When the binding window rolls over (epoch ms).
    pub resets_at_ms: Option<i64>,
    /// Share of the five-hour window used, 0–1.
    pub five_hour: Option<f64>,
    /// Share of the weekly window used, 0–1.
    pub seven_day: Option<f64>,
}

/// Why a session's credential stopped working mid-turn.
#[derive(Debug, Clone, PartialEq)]
pub enum PlanFailure {
    /// Its plan's limit is reached.
    LimitReached(PlanLimits),
    /// Its sign-in is over (expired and not renewable, or revoked).
    Expired(String),
}

/// What to do with the failed request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanVerdict {
    /// Send it again on this credential; the turn carries on. The
    /// `account_switched` row is written already.
    Switch(SessionCredential),
    /// No other sign-in is ready. The `accounts_exhausted` row and the
    /// notification replace the provider's own notice: end the turn without it.
    Exhausted,
    /// Nothing changes: the turn ends as it did.
    Keep,
}

/// What the engine asks of the accounts service. Implemented by
/// `eos-accounts`.
pub trait SessionCredentials: Send + Sync + 'static {
    /// The credential a new session of `provider` starts on. `None`: nothing
    /// can run (signed out with no key, or every sign-in stopped working).
    fn for_new_session<'a>(&'a self, provider: &'a str) -> BoxFuture<'a, Option<SessionCredential>>;
    /// A session started on a credential, moved to it, or (`None`) ended.
    fn launched(&self, worker_id: &str, credential: Option<&SessionCredential>);
    /// The plan-limit state of a response on `credential`.
    fn observed(&self, credential: &SessionCredential, limits: &PlanLimits);
    /// A request of `worker_id` (a top-level worker) was refused because its
    /// credential stopped working. Asked while the request waits.
    fn failed<'a>(&'a self, worker_id: &'a str, failure: &'a PlanFailure) -> BoxFuture<'a, PlanVerdict>;
}

/// What another feature may read of the user's plan sign-ins (the artifact
/// catalog, dreams). Implemented by `eos-accounts`.
pub trait PlanAccess: Send + Sync + 'static {
    /// The provider's sign-ins, in the order they were added.
    fn logins(&self, provider: &str) -> Vec<eos_domain::accounts::PlanLoginRecord>;
    /// A sign-in's access token, renewed first when it lapsed.
    fn access_token<'a>(&'a self, provider: &'a str, login_id: &'a str) -> BoxFuture<'a, Option<String>>;
    /// How much of its plan the sign-in a new session would use has spent:
    /// the larger of its five-hour and weekly windows, 0–1. `None`: unknown.
    fn utilization<'a>(&'a self, provider: &'a str) -> BoxFuture<'a, Option<f64>>;
}

/// What the accounts service asks of the engine. Implemented by the engine.
pub trait SessionAccountSwitch: Send + Sync + 'static {
    /// Moves the worker's live session to `credential` and runs the turn the
    /// old one cut off again, with no new input. `Err`: why it could not,
    /// in words the dashboard shows.
    fn move_session<'a>(
        &'a self,
        worker_id: &'a str,
        credential: SessionCredential,
    ) -> BoxFuture<'a, Result<(), String>>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_never_shows_in_debug_output() {
        let key = SessionCredential::ApiKey { provider: "anthropic".into(), key: "sk-secret".into() };
        let shown = format!("{key:?}");
        assert!(shown.contains("anthropic") && !shown.contains("sk-secret"), "{shown}");
        assert_eq!(usage_key("claude", Some("lg-1")), "claude:lg-1");
        assert_eq!(usage_key("codex", None), "codex");
    }
}
