//! `create_webhook`: GitHub tells Eos of a repository's pull requests at
//! once (06 G36), by posting to a hook of the relay's inbox. GitHub signs
//! each post with the secret the call carries; the secret only ever comes
//! from the service's own push setup, never from the call's input, so an
//! agent that calls the action has none and is refused.

use eos_core::capability::{ActionContext, ActionError, WEBHOOK_SECRET};
use eos_domain::capability::health::StateCode;
use serde_json::{Value, json};

use crate::GitHub;
use crate::actions::{repo, text};
use crate::client::Method;

/// The secret of the one call that registers a webhook.
pub(crate) fn webhook_secret(ctx: &ActionContext) -> Option<&str> {
    ctx.secrets.get(WEBHOOK_SECRET).map(|secret| secret.as_str())
}

impl GitHub {
    pub(crate) async fn create_webhook(
        &self,
        token: &str,
        input: &Value,
        secret: Option<&str>,
    ) -> Result<Value, ActionError> {
        let secret = secret
            .ok_or_else(|| ActionError::NotReady(StateCode::SecretMissing(WEBHOOK_SECRET.to_owned()).as_string()))?;
        let repo = repo("create_webhook", input)?;
        let body = json!({
            "name": "web",
            "active": true,
            "events": ["pull_request"],
            "config": { "url": text(input, "url"), "content_type": "json", "secret": secret, "insecure_ssl": "0" },
        });
        let created = self.send_json(token, Method::Post, &format!("/repos/{}/hooks", repo.0), body).await?;
        Ok(json!({ "hookId": created["id"].as_i64().unwrap_or_default() }))
    }
}
