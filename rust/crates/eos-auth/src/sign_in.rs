//! The providers' browser sign-ins, run by the agent engine's own sign-in
//! code into a store Eos names.

use std::path::Path;
use std::sync::{Arc, Mutex};

use eos_agent_anthropic::auth::{SignIn, SignInConfig, SignInError};
use eos_agent_openai::{BrowserOpener, LoginError};
use eos_core::BoxFuture;
use eos_core::accounts::{OnPages, SignInPages, SignInRequest, SignedIn, SubscriptionProvider};

use crate::stores::Stores;

const TIMED_OUT: &str = "Sign-in timed out. Try again.";

/// Sign in with Claude: authorization code with PKCE, the browser coming back
/// to a loopback address or the user pasting the code the page shows.
pub struct ClaudeSignIn {
    stores: Arc<Stores>,
    config: SignInConfig,
}

impl std::fmt::Debug for ClaudeSignIn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClaudeSignIn").finish_non_exhaustive()
    }
}

impl ClaudeSignIn {
    pub fn new(stores: Arc<Stores>) -> Self {
        Self::with_config(stores, SignInConfig::default())
    }

    /// `config`: where the sign-in goes (a local authorization server in tests).
    pub fn with_config(stores: Arc<Stores>, config: SignInConfig) -> Self {
        Self { stores, config }
    }
}

impl SubscriptionProvider for ClaudeSignIn {
    fn id(&self) -> &'static str {
        "anthropic"
    }

    fn accepts_code(&self) -> bool {
        true
    }

    fn multi_login(&self) -> bool {
        true
    }

    fn sign_in(&self, request: SignInRequest) -> BoxFuture<'static, Result<SignedIn, String>> {
        let SignInRequest { store_dir, login_hint, on_pages, code } = request;
        let (stores, mut config) = (self.stores.clone(), self.config.clone());
        config.login_hint = login_hint;
        Box::pin(async move {
            let words = |e: SignInError| match e {
                SignInError::Timeout => TIMED_OUT.to_owned(),
                other => other.to_string(),
            };
            let sign_in = SignIn::start(config).await.map_err(words)?;
            on_pages(SignInPages { open: sign_in.browser_url().to_owned(), shown: sign_in.manual_url().to_owned() });
            let login = stores.claude_login(Path::new(&store_dir));
            let account = sign_in.finish(&login, code).await.map_err(words)?;
            Ok(SignedIn { email: account.email })
        })
    }
}

/// Sign in with ChatGPT: the browser comes back by itself; there is no code
/// to paste.
pub struct ChatGptSignIn {
    stores: Arc<Stores>,
}

impl std::fmt::Debug for ChatGptSignIn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChatGptSignIn").finish_non_exhaustive()
    }
}

impl ChatGptSignIn {
    pub fn new(stores: Arc<Stores>) -> Self {
        Self { stores }
    }
}

/// Hands the sign-in page to the session once.
struct Pages(Mutex<Option<OnPages>>);

impl BrowserOpener for Pages {
    fn open(&self, url: &str) {
        if let Some(on_pages) = self.0.lock().unwrap_or_else(|p| p.into_inner()).take() {
            on_pages(SignInPages { open: url.to_owned(), shown: url.to_owned() });
        }
    }
}

impl SubscriptionProvider for ChatGptSignIn {
    fn id(&self) -> &'static str {
        "openai"
    }

    fn accepts_code(&self) -> bool {
        false
    }

    fn multi_login(&self) -> bool {
        false
    }

    fn sign_in(&self, request: SignInRequest) -> BoxFuture<'static, Result<SignedIn, String>> {
        let SignInRequest { store_dir, on_pages, .. } = request;
        let stores = self.stores.clone();
        Box::pin(async move {
            let pages = Pages(Mutex::new(Some(on_pages)));
            let signed_in = eos_agent_openai::sign_in(Path::new(&store_dir), stores.chatgpt_endpoints(), &pages).await;
            match signed_in {
                Ok(account) => Ok(SignedIn { email: account.email }),
                Err(LoginError::Timeout) => Err(TIMED_OUT.to_owned()),
                Err(other) => Err(other.to_string()),
            }
        })
    }
}
