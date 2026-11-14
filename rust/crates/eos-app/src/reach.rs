//! What a run may do as the user beyond this computer. One rule, the host's
//! (`eos_bridge::launch::reaches_network`, [`Options::reaches_network`](crate::Options)):
//! only the installed app on the user's own `~/.eos` does. Any other run (a
//! development build, a test, a replay, a copy of a data folder) holds
//! someone's identity, keys and sign-ins and must not act as them by itself.
//! Every service that would is given its connection here, or none:
//!
//! | Service | Off the network |
//! |---|---|
//! | The phone's relay, and the wake-up pushes it would carry | never dialled |
//! | Paired computers | no listener, no dial |
//! | Sync | its vault refuses every call: nothing is pulled or pushed |
//! | The update feed | updates are off |
//! | Eos's own reads of the user's accounts: plan usage, the artifact catalog, the model list | no sign-in's token is handed out or renewed for them |
//!
//! Agents are not on the list: they act when the user sends them a message.

use std::sync::Arc;

use eos_contracts::update::UpdateOffReason;
use eos_core::accounts::{PlanStores, StoreLogin};
use eos_core::net::relay::Relay;
use eos_core::net::sync::{OpenVault, PutOutcome, SyncAccounts, SyncVault, VaultChanges};
use eos_core::{BoxFuture, Error};
use eos_domain::sync::SyncIdentity;
use eos_domain::update::UpdateInstall;

/// Why sync does nothing on another data folder, as Settings › Sync shows it.
const SYNC_OFF: &str = "Sync runs only in the installed Eos on your own data folder";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Reach {
    network: bool,
}

impl Reach {
    pub(crate) fn new(network: bool) -> Self {
        Self { network }
    }

    pub(crate) fn relay(self, relay: Option<Arc<dyn Relay>>) -> Option<Arc<dyn Relay>> {
        relay.filter(|_| self.network)
    }

    /// Whether paired computers may be listened for and dialled.
    pub(crate) fn peers(self) -> bool {
        self.network
    }

    pub(crate) fn sync_accounts(self, accounts: Arc<dyn SyncAccounts>) -> Arc<dyn SyncAccounts> {
        if self.network { accounts } else { Arc::new(NoVault(accounts)) }
    }

    pub(crate) fn update_install(
        self,
        install: Result<UpdateInstall, UpdateOffReason>,
    ) -> Result<UpdateInstall, UpdateOffReason> {
        if self.network { install } else { Err(UpdateOffReason::DevBuild) }
    }

    /// The credential stores as Eos's own reads of the user's accounts use
    /// them. Sign-ins and agents keep the stores themselves.
    pub(crate) fn account_reads(self, stores: Arc<dyn PlanStores>) -> Arc<dyn PlanStores> {
        if self.network { stores } else { Arc::new(NoTokens(stores)) }
    }
}

/// Sync accounts whose vault is never reached.
struct NoVault(Arc<dyn SyncAccounts>);

impl SyncAccounts for NoVault {
    fn create(&self, relay_url: &str) -> SyncIdentity {
        self.0.create(relay_url)
    }

    fn open(&self, identity: &SyncIdentity) -> OpenVault {
        let crypto = self.0.open(identity).crypto;
        OpenVault { vault: Arc::new(Refused), crypto }
    }
}

struct Refused;

impl SyncVault for Refused {
    fn changes(&self, _since: u64, _wait_ms: u64) -> BoxFuture<'_, Result<VaultChanges, Error>> {
        Box::pin(std::future::ready(Err(Error::Rule(SYNC_OFF.into()))))
    }

    fn put<'a>(&'a self, _key: &'a str, _base_seq: u64, _data: &'a [u8]) -> BoxFuture<'a, Result<PutOutcome, Error>> {
        Box::pin(std::future::ready(Err(Error::Rule(SYNC_OFF.into()))))
    }
}

/// Stores that say what they hold but hand out no token.
struct NoTokens(Arc<dyn PlanStores>);

impl PlanStores for NoTokens {
    fn read<'a>(&'a self, provider: &'a str, store_dir: &'a str) -> BoxFuture<'a, StoreLogin> {
        self.0.read(provider, store_dir)
    }

    fn access_token<'a>(&'a self, _provider: &'a str, _store_dir: &'a str) -> BoxFuture<'a, Option<String>> {
        Box::pin(std::future::ready(None))
    }

    fn refused<'a>(&'a self, _provider: &'a str, _store_dir: &'a str, _rejected: &'a str) -> BoxFuture<'a, bool> {
        Box::pin(std::future::ready(false))
    }

    fn sign_out<'a>(&'a self, provider: &'a str, store_dir: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        self.0.sign_out(provider, store_dir)
    }
}

#[cfg(test)]
mod tests {
    use eos_contracts::update::UpdatePlatform;
    use eos_testkit::FakePlanStores;

    use super::*;

    #[tokio::test]
    async fn off_the_network_no_sign_in_hands_out_a_token_for_eos_s_own_reads() {
        let stores = Arc::new(FakePlanStores::default());
        stores.sign_in("/acc/claude", Some("max"), None);
        let off = Reach::new(false).account_reads(stores.clone());
        assert!(off.read("anthropic", "/acc/claude").await.present, "what it holds still shows");
        assert_eq!(off.access_token("anthropic", "/acc/claude").await, None);
        assert!(!off.refused("anthropic", "/acc/claude", "t").await);
        let on = Reach::new(true).account_reads(stores);
        assert!(on.access_token("anthropic", "/acc/claude").await.is_some());
    }

    #[test]
    fn off_the_network_updates_are_off() {
        let release = || {
            Ok(UpdateInstall {
                version: "0.2.0".into(),
                root: "/Applications/Eos.app".into(),
                platform: UpdatePlatform::DarwinArm64,
            })
        };
        assert_eq!(Reach::new(false).update_install(release()), Err(UpdateOffReason::DevBuild));
        assert_eq!(Reach::new(true).update_install(release()), release());
    }
}
