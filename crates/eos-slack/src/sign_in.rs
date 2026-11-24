//! Signing in to Slack in the browser with PKCE (06 G37, D60): a code
//! verifier of 64 characters from the id port and its S256 challenge, a
//! `state`, and Slack's authorize page with the user scopes; Slack calls back
//! on `eos://sign-in/slack` with a code, which `oauth.v2.access` exchanges
//! with the verifier and no client secret. The token pair is kept as one
//! secret; the workspace's name and the user's are the label. An attempt
//! waits 10 minutes. None of the verifier, the state, the code or the
//! tokens reaches a log.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use eos_core::BoxFuture;
use eos_core::capability::{ActionError, BrowserCallback, BrowserCode, BrowserSignIn, SignInError};
use eos_core::ids::Alphabet;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::Slack;
use crate::actions::text;
use crate::manifest::{ID, TOKEN};
use crate::token::TokenPair;

/// Slack's page where the user allows Eos.
pub const AUTHORIZE: &str = "https://slack.com/oauth/v2/authorize";
/// Where Slack sends the user back: the installed app's own scheme.
pub const REDIRECT: &str = "eos://sign-in/slack";
/// The user scopes Eos asks for, one for each method it calls.
pub const USER_SCOPES: [&str; 13] = [
    "chat:write",
    "im:write",
    "channels:history",
    "groups:history",
    "im:history",
    "mpim:history",
    "channels:read",
    "groups:read",
    "im:read",
    "mpim:read",
    "users:read",
    "users:read.email",
    "search:read",
];
/// How long an attempt waits for Slack's callback.
const ATTEMPT_MS: i64 = 10 * 60 * 1000;

fn failed(error: ActionError) -> SignInError {
    match error {
        ActionError::RateLimited { .. } => SignInError::RateLimited,
        _ => SignInError::Failed,
    }
}

impl Slack {
    async fn start_flow(&self) -> Result<BrowserCode, SignInError> {
        if self.client_id.is_empty() {
            return Err(SignInError::ClientIdMissing);
        }
        let verifier = Zeroizing::new(self.ids.token(Alphabet::Base62, 64));
        let state = Zeroizing::new(self.ids.token(Alphabet::Base62, 32));
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let scopes = USER_SCOPES.join(",");
        let query = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs([
                ("client_id", self.client_id.as_str()),
                ("user_scope", scopes.as_str()),
                ("redirect_uri", REDIRECT),
                ("state", state.as_str()),
                ("code_challenge", challenge.as_str()),
                ("code_challenge_method", "S256"),
            ])
            .finish();
        tracing::info!(capability = ID, "a Slack sign-in started");
        Ok(BrowserCode {
            authorize_uri: format!("{AUTHORIZE}?{query}"),
            state,
            verifier,
            expires_at: self.clock.now_ms() + ATTEMPT_MS,
        })
    }

    async fn finish_flow(&self, code: &BrowserCode, callback: BrowserCallback) -> Result<String, SignInError> {
        let granted = match callback {
            BrowserCallback::Code(granted) => granted,
            BrowserCallback::Refused(error) if error == "access_denied" => return Err(SignInError::Denied),
            BrowserCallback::Refused(_) => return Err(SignInError::Failed),
        };
        if self.clock.now_ms() >= code.expires_at {
            return Err(SignInError::Expired);
        }
        let fields = [
            ("client_id", self.client_id.as_str()),
            ("code", granted.as_str()),
            ("code_verifier", code.verifier.as_str()),
            ("redirect_uri", REDIRECT),
        ];
        let answer = self.call(None, "oauth.v2.access", None, &fields).await.map_err(failed)?;
        let pair = TokenPair::from_answer(&answer, self.clock.now_ms(), None).ok_or(SignInError::Failed)?;
        let who = self.call(Some(&pair.access), "auth.test", None, &[]).await.map_err(failed)?;
        let workspace = answer["team"]["name"].as_str().unwrap_or(text(&who, "team"));
        let label = format!("{workspace} as {}", text(&who, "user"));
        if let Err(e) = self.secrets.write(ID, TOKEN, pair.to_secret()).await {
            tracing::warn!(capability = ID, error = %e, "Slack's token could not be kept");
            return Err(SignInError::Failed);
        }
        *self.latest.lock().unwrap_or_else(|p| p.into_inner()) = Some(pair);
        tracing::info!(capability = ID, "signed in to Slack");
        Ok(label)
    }
}

impl BrowserSignIn for Slack {
    fn start(&self) -> BoxFuture<'_, Result<BrowserCode, SignInError>> {
        Box::pin(self.start_flow())
    }

    fn finish<'a>(
        &'a self,
        code: &'a BrowserCode,
        callback: BrowserCallback,
    ) -> BoxFuture<'a, Result<String, SignInError>> {
        Box::pin(self.finish_flow(code, callback))
    }
}
