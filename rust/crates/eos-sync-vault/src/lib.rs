//! Sync's outside world (`infra/src/sync/`):
//!
//! - [`HttpSyncVault`]: the relay's vault (`relay/vault/routes.ts`) over
//!   HTTPS. The relay is the one the user's sync key names, so requests go
//!   out through the plain client, not the guarded fetch for agent-written
//!   URLs (a relay on the local network is a supported set-up).
//! - [`VaultCrypto`]: the sync key's crypto, with a fresh random nonce for
//!   every sealed record.
//! - [`FileSyncStateStore`], [`FileSyncIdentityStore`]: the files under
//!   `<data folder>/sync` — `identity.json` (the key, readable by the user
//!   alone), `state.json` (regenerable bookkeeping) and `conflicts/` (the
//!   losing side of every conflict, never dropped).
//! - [`RelayAccounts`]: makes and opens accounts for the sync feature.

mod accounts;
mod crypto;
mod http;
mod stores;

pub use accounts::RelayAccounts;
pub use crypto::{VaultCrypto, new_identity};
pub use http::HttpSyncVault;
pub use stores::{FileSyncIdentityStore, FileSyncStateStore};
