//! Signing in by GitHub's device flow (06 G5): GitHub gives a code, the user
//! enters it on github.com, and Eos polls until GitHub hands over a token
//! with the `repo` scope. Codes live 15 minutes; polls keep GitHub's
//! interval and add 5 s each time it says `slow_down` or limits the rate; a
//! poll that got no answer in 30 s is tried again until the code runs out. The
//! token is kept with the capability's secrets; the account's login is its
//! label. A GitHub App's token lasts 8 hours and comes with a refresh token,
//! kept beside it and traded for a new token when GitHub refuses the old one. None of the codes, the token or the login reaches a log.

use eos_core::BoxFuture;
use eos_core::capability::{ActionError, DeviceCode, DeviceSignIn, SignInError};
use eos_domain::capability::manifest::DEFAULT_TIMEOUT_S;
use serde_json::Value;
use zeroize::Zeroizing;

use crate::GitHub;
use crate::actions::text;
use crate::client::{HttpRequest, Method, WEB};
use crate::manifest::{ID, TOKEN};

/// What GitHub's device flow asks for.
const SCOPE: &str = "repo";
const GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
/// Added to the interval each time GitHub says `slow_down`.
const SLOW_DOWN_S: u64 = 5;
/// The interval when GitHub names none.
const INTERVAL_S: u64 = 5;

impl GitHub {
    /// A form POST to github.com, answered as JSON.
    pub(crate) async fn form(&self, path: &str, fields: &[(&str, &str)]) -> Result<Value, SignInError> {
        let body = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(fields).finish();
        let request = HttpRequest {
            method: Method::Post,
            url: format!("{WEB}{path}"),
            headers: vec![
                ("accept".to_owned(), "application/json".to_owned()),
                ("content-type".to_owned(), "application/x-www-form-urlencoded".to_owned()),
            ],
            body: Some(body.into_bytes()),
        };
        // Nothing else bounds the exchange: a request that hangs would keep the
        // attempt pending past its code's end.
        let sent = tokio::select! {
            sent = self.transport.send(request) => sent,
            () = self.sleeper.sleep(i64::from(DEFAULT_TIMEOUT_S) * 1000) => {
                tracing::info!(host = "github.com", "GitHub's sign-in did not answer in time");
                return Err(SignInError::Failed);
            }
        };
        let response = sent.map_err(|e| {
            tracing::warn!(host = "github.com", error = %e, "GitHub's sign-in could not be reached");
            SignInError::Failed
        })?;
        match response.status {
            200 => serde_json::from_slice(&response.body).map_err(|_| SignInError::Failed),
            403 | 429 => Err(SignInError::RateLimited),
            status => {
                tracing::info!(host = "github.com", status, "GitHub refused a sign-in request");
                Err(SignInError::Failed)
            }
        }
    }

    async fn start_flow(&self) -> Result<DeviceCode, SignInError> {
        if self.client_id.is_empty() {
            return Err(SignInError::ClientIdMissing);
        }
        let answer = self.form("/login/device/code", &[("client_id", &self.client_id), ("scope", SCOPE)]).await?;
        let (device_code, user_code) = (text(&answer, "device_code"), text(&answer, "user_code"));
        if device_code.is_empty() || user_code.is_empty() {
            return Err(SignInError::Failed);
        }
        let expires_in_s = answer["expires_in"].as_i64().unwrap_or(900);
        tracing::info!(capability = ID, "a GitHub sign-in started");
        Ok(DeviceCode {
            user_code: Zeroizing::new(user_code.to_owned()),
            verification_uri: text(&answer, "verification_uri").to_owned(),
            expires_at: self.clock.now_ms() + expires_in_s * 1000,
            device_code: Zeroizing::new(device_code.to_owned()),
            interval_s: answer["interval"].as_u64().unwrap_or(INTERVAL_S),
        })
    }

    async fn finish_flow(&self, code: &DeviceCode) -> Result<String, SignInError> {
        let mut interval_s = code.interval_s.max(1);
        let fields =
            [("client_id", self.client_id.as_str()), ("device_code", code.device_code.as_str()), ("grant_type", GRANT)];
        loop {
            if self.clock.now_ms() >= code.expires_at {
                return Err(SignInError::Expired);
            }
            self.sleeper.sleep(i64::try_from(interval_s * 1000).unwrap_or(i64::MAX)).await;
            let answer = match self.form("/login/oauth/access_token", &fields).await {
                Ok(answer) => answer,
                // The code still lives: a poll that got no answer is tried again.
                Err(SignInError::RateLimited) => {
                    interval_s += SLOW_DOWN_S;
                    continue;
                }
                Err(_) => continue,
            };
            if let Some(token) = answer["access_token"].as_str() {
                let refresh = answer["refresh_token"].as_str().map(|refresh| Zeroizing::new(refresh.to_owned()));
                return self.keep(Zeroizing::new(token.to_owned()), refresh).await;
            }
            match text(&answer, "error") {
                "authorization_pending" => {}
                "slow_down" => interval_s += SLOW_DOWN_S,
                "expired_token" => return Err(SignInError::Expired),
                "access_denied" => return Err(SignInError::Denied),
                error => {
                    tracing::info!(capability = ID, error, "GitHub's sign-in ended");
                    return Err(SignInError::Failed);
                }
            }
        }
    }

    /// Reads the account's login with the new token, then keeps the token
    /// and its refresh token. A token without one (an OAuth App's) does not
    /// expire, and an earlier sign-in's refresh token goes.
    async fn keep(&self, token: Zeroizing<String>, refresh: Option<Zeroizing<String>>) -> Result<String, SignInError> {
        let user = tokio::select! {
            user = self.request_once(&token, Method::Get, "/user", None, &[]) => user.and_then(|user| user.json()),
            () = self.sleeper.sleep(i64::from(DEFAULT_TIMEOUT_S) * 1000) => Err(ActionError::Timeout),
        };
        let user = user.map_err(|e| match e {
            ActionError::RateLimited { .. } => SignInError::RateLimited,
            _ => SignInError::Failed,
        })?;
        let login = text(&user, "login").to_owned();
        if let Err(e) = self.keep_refresh(refresh).await {
            tracing::warn!(capability = ID, error = %e, "GitHub's refresh token could not be kept");
            return Err(SignInError::Failed);
        }
        if let Err(e) = self.secrets.write(ID, TOKEN, token).await {
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
