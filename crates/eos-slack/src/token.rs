//! The rotating token pair (06 G37, §4.7). One secret, `token`, holds
//! `{access, refresh, expiresAt, teamId, userId}` as JSON, so the pair is
//! written in one step. The access token lasts 12 hours; an hour before it
//! ends, or when Slack refuses it, the pair is refreshed one at a time, and
//! the new pair is kept before its access token is used. A refresh token
//! works once: a refused one means the user signs in again.

use eos_core::capability::{ActionContext, ActionError, FailureKind};
use eos_domain::capability::health::StateCode;
use serde_json::{Value, json};
use zeroize::Zeroizing;

use crate::Slack;
use crate::manifest::{ID, TOKEN};

/// A pair is refreshed this long before its access token ends.
const REFRESH_BEFORE_MS: i64 = 60 * 60 * 1000;

/// What the `token` secret holds.
#[derive(Clone)]
pub(crate) struct TokenPair {
    pub(crate) access: Zeroizing<String>,
    pub(crate) refresh: Zeroizing<String>,
    pub(crate) expires_at: i64,
    pub(crate) team_id: String,
    pub(crate) user_id: String,
}

impl std::fmt::Debug for TokenPair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TokenPair").field("expires_at", &self.expires_at).finish_non_exhaustive()
    }
}

impl TokenPair {
    pub(crate) fn parse(text: &str) -> Option<TokenPair> {
        let value: Value = serde_json::from_str(text).ok()?;
        let field = |name: &str| value[name].as_str().unwrap_or_default().to_owned();
        let access = field("access");
        (!access.is_empty()).then(|| TokenPair {
            access: Zeroizing::new(access),
            refresh: Zeroizing::new(field("refresh")),
            expires_at: value["expiresAt"].as_i64().unwrap_or(i64::MAX),
            team_id: field("teamId"),
            user_id: field("userId"),
        })
    }

    pub(crate) fn to_secret(&self) -> Zeroizing<String> {
        let value = json!({
            "access": self.access.as_str(), "refresh": self.refresh.as_str(), "expiresAt": self.expires_at,
            "teamId": self.team_id, "userId": self.user_id,
        });
        Zeroizing::new(value.to_string())
    }

    /// The pair an `oauth.v2.access` answer hands out: under `authed_user`
    /// for a sign-in, at the top for a refresh.
    pub(crate) fn from_answer(answer: &Value, now: i64, keep: Option<&TokenPair>) -> Option<TokenPair> {
        let user = if answer["authed_user"].is_object() { &answer["authed_user"] } else { answer };
        let access = user["access_token"].as_str().filter(|token| !token.is_empty())?;
        let expires_in = user["expires_in"].as_i64().unwrap_or(12 * 60 * 60);
        let team = answer["team"]["id"].as_str().map(str::to_owned);
        let user_id = user["id"].as_str().or_else(|| answer["user_id"].as_str()).map(str::to_owned);
        Some(TokenPair {
            access: Zeroizing::new(access.to_owned()),
            refresh: Zeroizing::new(user["refresh_token"].as_str().unwrap_or_default().to_owned()),
            expires_at: now + expires_in * 1000,
            team_id: team.or_else(|| keep.map(|pair| pair.team_id.clone())).unwrap_or_default(),
            user_id: user_id.or_else(|| keep.map(|pair| pair.user_id.clone())).unwrap_or_default(),
        })
    }
}

fn missing() -> ActionError {
    ActionError::NotReady(StateCode::SecretMissing(TOKEN.to_owned()).as_string())
}

impl Slack {
    /// The pair to call with: the newest of the call's secret and the one
    /// refreshed here last, refreshed first when it is about to end.
    pub(crate) async fn pair(&self, ctx: &ActionContext) -> Result<TokenPair, ActionError> {
        let given = ctx.secrets.get(TOKEN).and_then(|text| TokenPair::parse(text)).ok_or_else(missing)?;
        let pair = self.newest(given);
        if pair.expires_at - REFRESH_BEFORE_MS > self.clock.now_ms() {
            return Ok(pair);
        }
        self.refresh(&pair).await
    }

    fn newest(&self, given: TokenPair) -> TokenPair {
        let cached = self.latest.lock().unwrap_or_else(|p| p.into_inner()).clone();
        match cached {
            Some(cached) if cached.expires_at > given.expires_at => cached,
            _ => given,
        }
    }

    /// Refreshes `stale`, one refresh at a time: a caller that waited for
    /// another's refresh takes its pair.
    pub(crate) async fn refresh(&self, stale: &TokenPair) -> Result<TokenPair, ActionError> {
        let _one = self.refreshing.lock().await;
        let current = self.newest(stale.clone());
        if current.access.as_str() != stale.access.as_str() {
            return Ok(current);
        }
        if current.refresh.is_empty() {
            return Err(ActionError::Failed { kind: FailureKind::Unauthorized });
        }
        let fields = [
            ("client_id", self.client_id.as_str()),
            ("grant_type", "refresh_token"),
            ("refresh_token", current.refresh.as_str()),
        ];
        let answer = self.call(None, "oauth.v2.access", None, &fields).await.map_err(|error| match error {
            ActionError::Failed { kind: FailureKind::Validation } => {
                ActionError::Failed { kind: FailureKind::Unauthorized }
            }
            other => other,
        })?;
        let fresh = TokenPair::from_answer(&answer, self.clock.now_ms(), Some(&current))
            .ok_or(ActionError::Failed { kind: FailureKind::Service })?;
        if let Err(e) = self.secrets.write(ID, TOKEN, fresh.to_secret()).await {
            tracing::warn!(capability = ID, error = %e, "Slack's new token could not be kept");
            return Err(ActionError::Failed { kind: FailureKind::Service });
        }
        *self.latest.lock().unwrap_or_else(|p| p.into_inner()) = Some(fresh.clone());
        tracing::info!(capability = ID, "Slack's sign-in was refreshed");
        Ok(fresh)
    }

    /// A Web API call as the user, refreshing once when Slack refuses the
    /// access token.
    pub(crate) async fn as_user(
        &self,
        ctx: &ActionContext,
        method: &str,
        conversation: Option<&str>,
        fields: &[(&str, &str)],
    ) -> Result<Value, ActionError> {
        let pair = self.pair(ctx).await?;
        match self.call(Some(&pair.access), method, conversation, fields).await {
            Err(ActionError::Failed { kind: FailureKind::Unauthorized }) if !pair.refresh.is_empty() => {
                let fresh = self.refresh(&pair).await?;
                self.call(Some(&fresh.access), method, conversation, fields).await
            }
            answered => answered,
        }
    }
}
