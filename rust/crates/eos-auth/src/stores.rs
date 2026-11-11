//! The credential stores of plan sign-ins.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use eos_agent_anthropic::auth::{ClaudeLogin, Credential, FallbackSecrets, SecretStore, TokenSource};
use eos_agent_openai::ChatGptLogin;
use eos_core::accounts::{PlanStores, StoreLogin};
use eos_core::{BoxFuture, Error};
use eos_platform::CredentialStore;
use serde_json::Value;

/// The providers' own addresses, replaced by local ones in tests.
#[derive(Debug, Clone, Default)]
pub struct Endpoints {
    /// Where a Claude sign-in is renewed; `None`: Claude's token endpoint.
    pub claude_token_url: Option<String>,
    /// ChatGPT's sign-in endpoints.
    pub chatgpt: eos_agent_openai::SignInConfig,
}

/// The file the claude binary keeps a login in where there is no keychain
/// item for the store.
const CLAUDE_FILE: &str = ".credentials.json";

type IoFuture<'a, T> = Pin<Box<dyn Future<Output = std::io::Result<T>> + Send + 'a>>;

/// A Claude store's keychain item, as the engine's `ClaudeLogin` reads and
/// writes it. The system's secret store is reached through `eos-platform`,
/// the one place that knows how.
struct StoreItem {
    credentials: Arc<dyn CredentialStore>,
    dir: PathBuf,
}

impl SecretStore for StoreItem {
    fn read(&self) -> IoFuture<'_, Option<String>> {
        let (credentials, dir) = (self.credentials.clone(), self.dir.clone());
        Box::pin(async move {
            let read = tokio::task::spawn_blocking(move || credentials.read_claude_store(Some(&dir)));
            read.await.map_err(std::io::Error::other)
        })
    }

    fn write<'a>(&'a self, value: &'a str) -> IoFuture<'a, ()> {
        let (credentials, dir, value) = (self.credentials.clone(), self.dir.clone(), value.to_owned());
        Box::pin(async move {
            let write = tokio::task::spawn_blocking(move || credentials.write_claude_store(&dir, &value));
            write.await.map_err(std::io::Error::other)?.map_err(std::io::Error::other)
        })
    }
}

/// Every credential store Eos holds. One login object per store folder, so
/// everything in the app that reads a store's token shares its renewals;
/// the entry goes when the store is signed out.
pub struct Stores {
    credentials: Arc<dyn CredentialStore>,
    endpoints: Endpoints,
    claude: Mutex<HashMap<PathBuf, Arc<ClaudeLogin>>>,
    chatgpt: Mutex<HashMap<PathBuf, Arc<ChatGptLogin>>>,
}

impl std::fmt::Debug for Stores {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Stores").finish_non_exhaustive()
    }
}

/// What a Claude store's document says about its sign-in.
fn read_claude(raw: Option<&str>, dir: &Path) -> StoreLogin {
    let doc: Option<Value> = raw.and_then(|raw| serde_json::from_str(raw).ok());
    let Some(doc) = doc else { return StoreLogin::default() };
    let oauth = doc.get("claudeAiOauth").unwrap_or(&doc);
    let has = |key: &str| oauth.get(key).and_then(Value::as_str).is_some_and(|s| !s.is_empty());
    if !has("accessToken") && !has("refreshToken") {
        return StoreLogin::default();
    }
    StoreLogin {
        present: true,
        plan: oauth.get("subscriptionType").and_then(Value::as_str).map(str::to_owned),
        email: claude_email(dir),
    }
}

/// The account a store was signed in to by the claude binary: it ran with its
/// configuration in the store folder and recorded the account there.
fn claude_email(dir: &Path) -> Option<String> {
    let doc: Value = serde_json::from_slice(&std::fs::read(dir.join(".claude.json")).ok()?).ok()?;
    let email = doc.get("oauthAccount")?.get("emailAddress")?.as_str()?.trim();
    (!email.is_empty()).then(|| email.to_owned())
}

impl Stores {
    pub fn new(credentials: Arc<dyn CredentialStore>, endpoints: Endpoints) -> Self {
        Self { credentials, endpoints, claude: Mutex::default(), chatgpt: Mutex::default() }
    }

    /// The Claude sign-in kept for `dir`.
    pub(crate) fn claude_login(&self, dir: &Path) -> Arc<ClaudeLogin> {
        let mut logins = self.claude.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(login) = logins.get(dir) {
            return login.clone();
        }
        let item = Arc::new(StoreItem { credentials: self.credentials.clone(), dir: dir.to_owned() });
        let secrets = Arc::new(FallbackSecrets::new(item, dir.join(CLAUDE_FILE)));
        let mut login = ClaudeLogin::new(secrets, dir.to_owned());
        if let Some(url) = &self.endpoints.claude_token_url {
            login = login.with_token_url(url.clone());
        }
        let login = Arc::new(login);
        logins.insert(dir.to_owned(), login.clone());
        login
    }

    pub(crate) fn chatgpt_login(&self, dir: &Path) -> Arc<ChatGptLogin> {
        let mut logins = self.chatgpt.lock().unwrap_or_else(|p| p.into_inner());
        let make = || Arc::new(ChatGptLogin::with_config(dir, self.endpoints.chatgpt.clone()));
        logins.entry(dir.to_owned()).or_insert_with(make).clone()
    }

    pub(crate) fn chatgpt_endpoints(&self) -> &eos_agent_openai::SignInConfig {
        &self.endpoints.chatgpt
    }

    /// The store's login document. A folder that does not exist holds no
    /// sign-in (every sign-in made its folder first), so the system's secret
    /// store is not asked about it.
    async fn raw_claude(&self, dir: &Path) -> Option<String> {
        let (credentials, dir) = (self.credentials.clone(), dir.to_owned());
        let read = tokio::task::spawn_blocking(move || {
            if !dir.is_dir() {
                return None;
            }
            credentials.read_claude_store(Some(&dir)).or_else(|| std::fs::read_to_string(dir.join(CLAUDE_FILE)).ok())
        });
        read.await.ok().flatten()
    }

    async fn sign_out_claude(&self, dir: &Path) -> Result<(), Error> {
        // Under the store's refresh lock, so a renewal in flight cannot put
        // the sign-in back.
        self.claude_login(dir).sign_out().await.map_err(Error::storage)?;
        self.claude.lock().unwrap_or_else(|p| p.into_inner()).remove(dir);
        // An item that holds nothing else is removed, as `claude auth logout` leaves none.
        let rest: Option<Value> = self.raw_claude(dir).await.and_then(|raw| serde_json::from_str(&raw).ok());
        if rest.as_ref().and_then(Value::as_object).is_none_or(serde_json::Map::is_empty) {
            let (credentials, dir) = (self.credentials.clone(), dir.to_owned());
            let clear = tokio::task::spawn_blocking(move || {
                credentials.clear_claude_store(&dir);
                let _ = std::fs::remove_file(dir.join(CLAUDE_FILE));
            });
            clear.await.map_err(Error::storage)?;
        }
        Ok(())
    }
}

async fn token(source: &dyn TokenSource, what: &str) -> Option<String> {
    match source.credential().await {
        Ok(Credential::Bearer(token)) => Some(token),
        Ok(Credential::ApiKey(_)) => None,
        Err(e) => {
            tracing::warn!(error = %e, "{what} sign-in gave no access token");
            None
        }
    }
}

impl PlanStores for Stores {
    fn read<'a>(&'a self, provider: &'a str, store_dir: &'a str) -> BoxFuture<'a, StoreLogin> {
        Box::pin(async move {
            let dir = Path::new(store_dir);
            match provider {
                "anthropic" => read_claude(self.raw_claude(dir).await.as_deref(), dir),
                "openai" => match self.chatgpt_login(dir).account().await {
                    // A sign-in whose refresh token is spent stays on disk as
                    // a registration only: it cannot run.
                    Some(account) => StoreLogin { present: account.plan_usage, plan: None, email: account.email },
                    None => StoreLogin::default(),
                },
                _ => StoreLogin::default(),
            }
        })
    }

    fn access_token<'a>(&'a self, provider: &'a str, store_dir: &'a str) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            let dir = Path::new(store_dir);
            match provider {
                "anthropic" => {
                    if !self.read(provider, store_dir).await.present {
                        return None;
                    }
                    token(self.claude_login(dir).as_ref(), "Claude").await
                }
                "openai" if ChatGptLogin::exists(dir) => token(self.chatgpt_login(dir).as_ref(), "ChatGPT").await,
                _ => None,
            }
        })
    }

    fn sign_out<'a>(&'a self, provider: &'a str, store_dir: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(async move {
            let dir = Path::new(store_dir);
            match provider {
                "anthropic" => self.sign_out_claude(dir).await,
                "openai" => {
                    let login = self.chatgpt_login(dir);
                    self.chatgpt.lock().unwrap_or_else(|p| p.into_inner()).remove(dir);
                    // The registration's host id stays, so a later sign-in is the same app.
                    login.sign_out().await.map(|_| ()).map_err(Error::storage)
                }
                _ => Ok(()),
            }
        })
    }
}
