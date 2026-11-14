use std::sync::Arc;

use eos_core::net::sync::{OpenVault, SyncAccounts};
use eos_domain::sync::{SyncIdentity, SyncKeys};

use crate::{HttpSyncVault, VaultCrypto, new_identity};

/// Accounts on a relay: a key opens the vault its relay URL and secret name.
#[derive(Debug, Clone)]
pub struct RelayAccounts {
    http: reqwest::Client,
}

impl RelayAccounts {
    pub fn new(http: reqwest::Client) -> Self {
        Self { http }
    }
}

impl SyncAccounts for RelayAccounts {
    fn create(&self, relay_url: &str) -> SyncIdentity {
        new_identity(relay_url)
    }

    fn open(&self, identity: &SyncIdentity) -> OpenVault {
        let keys = SyncKeys::derive(&identity.secret);
        let vault = HttpSyncVault::new(self.http.clone(), &identity.relay_url, &keys.vault_id, &keys.auth_token);
        OpenVault { vault: Arc::new(vault), crypto: Arc::new(VaultCrypto::new(keys)) }
    }
}
