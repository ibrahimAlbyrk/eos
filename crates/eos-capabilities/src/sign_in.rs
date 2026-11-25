//! What a sign-in needs of the service: the built-in that signs in, keeping
//! the account's label once it did, and forgetting the sign-in. The label
//! is the user's: never logged.

use std::sync::Arc;

use eos_core::Error;
use eos_core::capability::BuiltinCapability;
use eos_domain::capability::health::Health;

use crate::CapabilityService;

impl CapabilityService {
    /// The built-in `id` when the user signs in to it by a code on the
    /// service's own page; `None` for any other capability.
    pub fn signs_in(&self, id: &str) -> Option<Arc<dyn BuiltinCapability>> {
        let signs_in = |builtin: &&Arc<dyn BuiltinCapability>| {
            builtin.device_sign_in().is_some() || builtin.browser_sign_in().is_some()
        };
        self.builtins.get(id).filter(signs_in).cloned()
    }

    /// After a sign-in: keeps the account's label, then checks the
    /// capability, which announces where it stands now.
    pub async fn signed_in(&self, id: &str, account_label: String) -> Result<Health, Error> {
        self.keep_label(id, Some(account_label)).await?;
        self.check(id).await
    }

    /// Forgets the capability's sign-in: the secrets it keeps its token in,
    /// and with them the account's label. It needs signing in again.
    pub async fn forget_sign_in(&self, id: &str) -> Result<(), Error> {
        let builtin = self.signs_in(id).ok_or_else(|| Error::not_found("capability sign-in", id))?;
        for secret in &builtin.manifest().secrets {
            self.forget_secret(id, &secret.name).await?;
        }
        Ok(())
    }

    /// Keeps or clears the label of the account the capability is signed in to.
    pub(crate) async fn keep_label(&self, id: &str, account_label: Option<String>) -> Result<(), Error> {
        let (owned, now) = (id.to_owned(), self.ports.clock.now_ms());
        self.ports
            .store
            .write(move |tx, _| {
                let mut install =
                    tx.capability_installs().find(&owned)?.ok_or_else(|| Error::not_found("capability", &owned))?;
                if install.account_label == account_label {
                    return Ok(());
                }
                install.account_label = account_label;
                install.updated_at = now;
                tx.capability_installs().put(&install)
            })
            .await
    }
}
