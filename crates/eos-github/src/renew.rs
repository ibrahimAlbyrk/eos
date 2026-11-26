//! A token GitHub refused: the GitHub CLI may hold a newer one for the same
//! account (the user signed in again in a terminal). The token never reaches
//! a log.

use zeroize::Zeroizing;

use crate::GitHub;
use crate::manifest::{ACCOUNT, ID, TOKEN};

impl GitHub {
    /// A token to use in place of `refused`: the one kept since, when another
    /// call renewed it or the user signed in again, or the one `gh` now has
    /// for the account. None when `gh` has no other: the sign-in is over.
    pub(crate) async fn renewed(&self, refused: &str) -> Option<Zeroizing<String>> {
        let _one = self.renewing.lock().await;
        let kept = self.secrets.read(ID, TOKEN).await.ok().flatten()?;
        if kept.as_str() != refused {
            return Some(kept);
        }
        let account = self.secrets.read(ID, ACCOUNT).await.ok().flatten()?;
        let fresh = self.cli.token(Some(&account)).await.ok().filter(|fresh| fresh.as_str() != refused)?;
        if let Err(e) = self.secrets.write(ID, TOKEN, fresh.clone()).await {
            tracing::warn!(capability = ID, error = %e, "GitHub's renewed token could not be kept");
        }
        tracing::info!(capability = ID, "GitHub's token was renewed");
        Some(fresh)
    }
}
