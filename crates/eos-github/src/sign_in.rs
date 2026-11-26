//! Signing in with the GitHub CLI's sign-in. `gh` is installed when the
//! computer has none. A sign-in `gh` already has is taken as it is when
//! GitHub still accepts it; otherwise `gh` runs its own sign-in: it gives a
//! code, the user enters it on github.com, and `gh` keeps the token. Eos
//! keeps a copy of that token with the capability's secrets, and the
//! account's login beside it, so the capability stays with that account
//! whichever one `gh` makes active later. None of the code, the token or
//! the login reaches a log.

use eos_core::BoxFuture;
use eos_core::capability::{ActionError, DeviceCode, DeviceSignIn, SignInError};
use eos_domain::capability::manifest::DEFAULT_TIMEOUT_S;
use zeroize::Zeroizing;

use crate::GitHub;
use crate::actions::text;
use crate::cli::CliError;
use crate::client::Method;
use crate::manifest::{ACCOUNT, ID, TOKEN};

/// How long `gh`'s sign-in code lives.
const CODE_MS: i64 = 15 * 60 * 1000;

/// What a started sign-in waits on.
pub(crate) enum Waiting {
    /// `gh` was signed in already: its token.
    Token(Zeroizing<String>),
    /// `gh` signs in: it ends once the user entered the code.
    Login(BoxFuture<'static, Result<(), CliError>>),
}

fn failed(error: CliError) -> SignInError {
    match error {
        CliError::Expired => SignInError::Expired,
        _ => SignInError::Failed,
    }
}

impl GitHub {
    /// The login of the account `token` signs in, as `GET /user` says.
    async fn login_of(&self, token: &str) -> Result<String, ActionError> {
        let user = tokio::select! {
            user = self.request_once(token, Method::Get, "/user", None, &[]) => user.and_then(|user| user.json()),
            () = self.sleeper.sleep(i64::from(DEFAULT_TIMEOUT_S) * 1000) => Err(ActionError::Timeout),
        };
        user.map(|user| text(&user, "login").to_owned())
    }

    fn wait_on(&self, waiting: Option<Waiting>) -> Option<Waiting> {
        std::mem::replace(&mut *self.signing.lock().unwrap_or_else(|p| p.into_inner()), waiting)
    }

    async fn start_flow(&self) -> Result<DeviceCode, SignInError> {
        self.cli.ensure().await.map_err(failed)?;
        let expires_at = self.clock.now_ms() + CODE_MS;
        let code = |user_code: Zeroizing<String>, verification_uri: String| DeviceCode {
            user_code,
            verification_uri,
            expires_at,
            device_code: Zeroizing::new(String::new()),
            interval_s: 0,
        };
        if let Ok(token) = self.cli.token(None).await
            && self.login_of(&token).await.is_ok()
        {
            tracing::info!(capability = ID, "the GitHub CLI is signed in already");
            self.wait_on(Some(Waiting::Token(token)));
            // Nothing to enter: the sign-in finishes at once.
            return Ok(code(Zeroizing::new(String::new()), String::new()));
        }
        let login = self.cli.login().await.map_err(failed)?;
        tracing::info!(capability = ID, "a GitHub sign-in started");
        self.wait_on(Some(Waiting::Login(login.done)));
        Ok(code(login.user_code, login.verification_uri))
    }

    async fn finish_flow(&self, code: &DeviceCode) -> Result<String, SignInError> {
        let token = match self.wait_on(None) {
            Some(Waiting::Token(token)) => token,
            Some(Waiting::Login(done)) => {
                tokio::select! {
                    ended = done => ended.map_err(failed)?,
                    () = self.sleeper.sleep(code.expires_at - self.clock.now_ms()) => return Err(SignInError::Expired),
                }
                self.cli.token(None).await.map_err(failed)?
            }
            None => return Err(SignInError::Failed),
        };
        self.keep(token).await
    }

    /// Reads the account's login with the token, then keeps both.
    async fn keep(&self, token: Zeroizing<String>) -> Result<String, SignInError> {
        let login = self.login_of(&token).await.map_err(|e| match e {
            ActionError::RateLimited { .. } => SignInError::RateLimited,
            _ => SignInError::Failed,
        })?;
        let kept = match self.secrets.write(ID, ACCOUNT, Zeroizing::new(login.clone())).await {
            Ok(()) => self.secrets.write(ID, TOKEN, token).await,
            Err(e) => Err(e),
        };
        if let Err(e) = kept {
            tracing::warn!(capability = ID, error = %e, "GitHub's token could not be kept");
            return Err(SignInError::Failed);
        }
        tracing::info!(capability = ID, "signed in to GitHub");
        Ok(login)
    }
}

impl DeviceSignIn for GitHub {
    fn start(&self) -> BoxFuture<'_, Result<DeviceCode, SignInError>> {
        Box::pin(self.start_flow())
    }

    fn finish<'a>(&'a self, code: &'a DeviceCode) -> BoxFuture<'a, Result<String, SignInError>> {
        Box::pin(self.finish_flow(code))
    }
}
