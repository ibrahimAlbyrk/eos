//! The GitHub CLI in memory, behind `eos_github::Cli`: whether it is on the
//! computer, the accounts it is signed in to, and a sign-in that ends when
//! the test enters its code.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use eos_core::BoxFuture;
use eos_github::{Cli, CliError, Login};
use tokio::sync::oneshot;
use zeroize::Zeroizing;

use super::{GITHUB_USER_CODE, locked};

#[derive(Debug, Default)]
struct State {
    installed: bool,
    installable: bool,
    installs: u32,
    /// The user enters every code at once.
    entering: bool,
    /// The token of each signed-in account.
    tokens: HashMap<String, String>,
    active: Option<String>,
    /// The account and token the next sign-in gives.
    next: Option<(String, String)>,
    /// Ends the sign-in under way.
    pending: Option<oneshot::Sender<Result<(), CliError>>>,
    logins: u32,
}

/// `gh`, installed and signed out.
#[derive(Debug, Clone)]
pub struct FakeGhCli(Arc<Mutex<State>>);

impl Default for FakeGhCli {
    fn default() -> Self {
        Self::new()
    }
}

impl FakeGhCli {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(State { installed: true, installable: true, ..State::default() })))
    }

    /// `gh` is not on the computer; `installable` says whether installing
    /// it works.
    pub fn missing(self, installable: bool) -> Self {
        {
            let mut state = locked(&self.0);
            state.installed = false;
            state.installable = installable;
        }
        self
    }

    /// The user enters the code of every sign-in at once, and it signs
    /// `account` in with `token`.
    pub fn entering(self, account: &str, token: &str) -> Self {
        {
            let mut state = locked(&self.0);
            state.entering = true;
            state.next = Some((account.to_owned(), token.to_owned()));
        }
        self
    }

    /// `gh` is signed in to `account` with `token`, its active account.
    pub fn sign_in(&self, account: &str, token: &str) {
        let mut state = locked(&self.0);
        state.tokens.insert(account.to_owned(), token.to_owned());
        state.active = Some(account.to_owned());
    }

    /// `gh` is signed out of every account.
    pub fn sign_out(&self) {
        let mut state = locked(&self.0);
        state.tokens.clear();
        state.active = None;
    }

    /// What the next sign-in gives once its code is entered.
    pub fn next_login(&self, account: &str, token: &str) {
        locked(&self.0).next = Some((account.to_owned(), token.to_owned()));
    }

    /// The user entered the code of the sign-in under way.
    pub fn enter_code(&self) {
        self.end(Ok(()));
    }

    /// The sign-in under way ends as `gh` failing with `error`.
    pub fn fail_login(&self, error: CliError) {
        self.end(Err(error));
    }

    fn end(&self, result: Result<(), CliError>) {
        if let Some(pending) = locked(&self.0).pending.take() {
            let _ = pending.send(result);
        }
    }

    pub fn installs(&self) -> u32 {
        locked(&self.0).installs
    }

    pub fn logins(&self) -> u32 {
        locked(&self.0).logins
    }
}

impl Cli for FakeGhCli {
    fn ensure(&self) -> BoxFuture<'_, Result<(), CliError>> {
        let mut state = locked(&self.0);
        if !state.installed && state.installable {
            state.installed = true;
            state.installs += 1;
        }
        let ensured = if state.installed { Ok(()) } else { Err(CliError::Missing) };
        Box::pin(std::future::ready(ensured))
    }

    fn token<'a>(&'a self, account: Option<&'a str>) -> BoxFuture<'a, Result<Zeroizing<String>, CliError>> {
        let state = locked(&self.0);
        let token = if state.installed {
            let account = account.map(str::to_owned).or_else(|| state.active.clone());
            let token = account.and_then(|account| state.tokens.get(&account).cloned());
            token.map(Zeroizing::new).ok_or(CliError::SignedOut)
        } else {
            Err(CliError::Missing)
        };
        Box::pin(std::future::ready(token))
    }

    fn login(&self) -> BoxFuture<'_, Result<Login, CliError>> {
        let ended = {
            let mut state = locked(&self.0);
            if !state.installed {
                return Box::pin(std::future::ready(Err(CliError::Missing)));
            }
            state.logins += 1;
            let (end, ended) = oneshot::channel();
            if state.entering {
                let _ = end.send(Ok(()));
            } else {
                state.pending = Some(end);
            }
            ended
        };
        let shared = self.0.clone();
        let done = async move {
            ended.await.map_err(|_| CliError::Failed)??;
            let mut state = locked(&shared);
            let next = if state.entering { state.next.clone() } else { state.next.take() };
            if let Some((account, token)) = next {
                state.tokens.insert(account.clone(), token);
                state.active = Some(account);
            }
            Ok(())
        };
        Box::pin(std::future::ready(Ok(Login {
            user_code: Zeroizing::new(GITHUB_USER_CODE.to_owned()),
            verification_uri: "https://github.com/login/device".to_owned(),
            done: Box::pin(done),
        })))
    }
}
