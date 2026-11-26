//! Renewing a GitHub App's token. It lasts 8 hours; its refresh token,
//! about six months, is traded once for a new token and the next refresh
//! token. A token from the device flow is renewed without a client secret.
//! Neither token reaches a log.

use eos_core::Error;
use zeroize::Zeroizing;

use crate::GitHub;
use crate::actions::text;
use crate::manifest::{ID, REFRESH_TOKEN, TOKEN};

const GRANT: &str = "refresh_token";

impl GitHub {
    /// Keeps the sign-in's refresh token, or forgets the one an earlier
    /// sign-in kept when this one has none.
    pub(crate) async fn keep_refresh(&self, refresh: Option<Zeroizing<String>>) -> Result<(), Error> {
        match refresh {
            Some(refresh) => self.secrets.write(ID, REFRESH_TOKEN, refresh).await,
            None => self.secrets.delete(ID, REFRESH_TOKEN).await,
        }
    }

    /// A token to use in place of `refused`: the one kept since, when another
    /// call renewed it or the user signed in again, or a new one for the kept
    /// refresh token. None when there is nothing to renew with or GitHub
    /// refused the refresh token too: the sign-in is over.
    pub(crate) async fn renewed(&self, refused: &str) -> Option<Zeroizing<String>> {
        let _one = self.renewing.lock().await;
        let kept = self.secrets.read(ID, TOKEN).await.ok().flatten()?;
        if kept.as_str() != refused {
            return Some(kept);
        }
        let refresh = self.secrets.read(ID, REFRESH_TOKEN).await.ok().flatten()?;
        let fields =
            [("client_id", self.client_id.as_str()), ("grant_type", GRANT), ("refresh_token", refresh.as_str())];
        let answer = self.form("/login/oauth/access_token", &fields).await.ok()?;
        let Some(token) = answer["access_token"].as_str() else {
            tracing::info!(capability = ID, error = text(&answer, "error"), "GitHub refused to renew its token");
            return None;
        };
        let token = Zeroizing::new(token.to_owned());
        // The old refresh token no longer works: the new one is kept first, so
        // a token is never kept without the refresh token that renews it.
        let next = answer["refresh_token"].as_str().map(|refresh| Zeroizing::new(refresh.to_owned()));
        let kept = match self.keep_refresh(next).await {
            Ok(()) => self.secrets.write(ID, TOKEN, token.clone()).await,
            Err(e) => Err(e),
        };
        if let Err(e) = kept {
            tracing::warn!(capability = ID, error = %e, "GitHub's renewed token could not be kept");
        }
        tracing::info!(capability = ID, "GitHub's token was renewed");
        Some(token)
    }
}
