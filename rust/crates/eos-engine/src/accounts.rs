//! Credentials: one engine account per sign-in or key, shared by every
//! session on it, and the accounts feature's say when one stops working.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use eos_agent_anthropic::auth::{ClaudeLogin, FallbackSecrets, SecretStore};
use eos_agent_core::{BoxFuture, Credential, ModelError, RateLimitInfo, StaticCredential, TokenSource};
use eos_agent_sdk::{Account, AuthFailover, AuthFailure, ChatGptLogin};
use eos_core::accounts::{PlanFailure, PlanLimits, PlanVerdict, SessionCredential, SessionCredentials};
use eos_platform::CredentialStore;

use crate::registry::Registry;

/// What an agent with no credential runs on: nothing. Its first request
/// fails with a message the user can act on.
pub(crate) struct NotSignedIn;

impl TokenSource for NotSignedIn {
    fn credential(&self) -> BoxFuture<'_, Result<Credential, ModelError>> {
        Box::pin(std::future::ready(Err(ModelError::Auth("not signed in".into()))))
    }
}

/// The file the claude binary keeps a login in where the store has no
/// keychain item.
const CLAUDE_FILE: &str = ".credentials.json";

/// A Claude store's keychain item, read and written through the system's
/// secret store as the rest of Eos reaches it.
struct StoreItem {
    secrets: Arc<dyn CredentialStore>,
    dir: PathBuf,
}

impl SecretStore for StoreItem {
    fn read(&self) -> BoxFuture<'_, std::io::Result<Option<String>>> {
        let (secrets, dir) = (self.secrets.clone(), self.dir.clone());
        Box::pin(async move {
            let read = tokio::task::spawn_blocking(move || secrets.read_claude_store(Some(&dir)));
            read.await.map_err(std::io::Error::other)
        })
    }

    fn write<'a>(&'a self, value: &'a str) -> BoxFuture<'a, std::io::Result<()>> {
        let (secrets, dir, value) = (self.secrets.clone(), self.dir.clone(), value.to_owned());
        Box::pin(async move {
            let write = tokio::task::spawn_blocking(move || secrets.write_claude_store(&dir, &value));
            write.await.map_err(std::io::Error::other)?.map_err(std::io::Error::other)
        })
    }
}

/// The engine accounts made so far. One per store folder or key, so every
/// agent on a sign-in renews through the same holder.
pub(crate) struct Accounts {
    made: Mutex<HashMap<String, Arc<Account>>>,
    /// Where a Claude store's login is kept (beside its plaintext file).
    secrets: Arc<dyn CredentialStore>,
}

fn key_of(credential: &SessionCredential) -> String {
    match credential {
        SessionCredential::Store { provider, dir } => format!("store:{provider}:{}", dir.display()),
        SessionCredential::ApiKey { provider, key } => format!("key:{provider}:{key}"),
        SessionCredential::Bearer { provider, token } => format!("token:{provider}:{token}"),
    }
}

impl Accounts {
    pub(crate) fn new(secrets: Arc<dyn CredentialStore>) -> Self {
        Self { made: Mutex::default(), secrets }
    }

    fn claude_store(&self, dir: &Path) -> Account {
        let item = StoreItem { secrets: self.secrets.clone(), dir: dir.to_owned() };
        let secrets = Arc::new(FallbackSecrets::new(Arc::new(item), dir.join(CLAUDE_FILE)));
        Account::new(Arc::new(ClaudeLogin::new(secrets, dir.to_owned())))
    }

    pub(crate) fn of(&self, credential: &SessionCredential) -> Arc<Account> {
        let key = key_of(credential);
        let mut made = self.made.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(account) = made.get(&key) {
            return account.clone();
        }
        let account = Arc::new(match credential {
            SessionCredential::Store { provider, dir } if provider == "openai" => {
                Account::new(Arc::new(ChatGptLogin::new(dir)))
            }
            SessionCredential::Store { dir, .. } => self.claude_store(dir),
            SessionCredential::ApiKey { key, .. } => Account::api_key(key.clone()),
            SessionCredential::Bearer { token, .. } => {
                Account::new(Arc::new(StaticCredential(Credential::Bearer(token.clone()))))
            }
        });
        made.insert(key, account.clone());
        account
    }
}

pub(crate) fn limits(info: &RateLimitInfo) -> PlanLimits {
    PlanLimits {
        status: info.status.clone(),
        claim: info.claim.clone(),
        resets_at_ms: info.resets_at.and_then(|s| i64::try_from(s).ok()).map(|s| s.saturating_mul(1000)),
        five_hour: info.five_hour_utilization,
        seven_day: info.seven_day_utilization,
    }
}

/// Asked by the engine while a refused request waits.
pub(crate) struct Failover {
    pub(crate) credentials: Arc<dyn SessionCredentials>,
    pub(crate) accounts: Arc<Accounts>,
    pub(crate) sessions: Arc<Registry>,
}

impl AuthFailover for Failover {
    fn replacement<'a>(
        &'a self,
        agent_id: &'a str,
        failure: &'a AuthFailure,
    ) -> BoxFuture<'a, Option<Arc<dyn TokenSource>>> {
        Box::pin(async move {
            let failure = match failure {
                AuthFailure::LimitReached(info) => PlanFailure::LimitReached(limits(info)),
                AuthFailure::Expired(why) => PlanFailure::Expired(why.clone()),
            };
            match self.credentials.failed(agent_id, &failure).await {
                PlanVerdict::Switch(credential) => {
                    let account = self.accounts.of(&credential);
                    self.credentials.launched(agent_id, Some(&credential));
                    self.sessions.set_credential(agent_id, Some(credential));
                    Some(account as Arc<dyn TokenSource>)
                }
                PlanVerdict::Exhausted => {
                    // The accounts feature told the user: the turn's own notice stays out.
                    self.sessions.silence_next_failure(agent_id);
                    None
                }
                PlanVerdict::Keep => None,
            }
        })
    }
}
