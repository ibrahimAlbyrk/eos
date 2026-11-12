//! Sync between the user's computers (`core/src/ports/SyncVault.ts`,
//! `SyncStateStore.ts`, `SyncCrypto.ts`, `SyncDomain.ts`).

use eos_contracts::SyncDomainName;
use std::sync::Arc;

use eos_domain::sync::{LocalState, SyncIdentity, SyncItem};
use serde_json::Value;

use crate::{BoxFuture, Error};

/// One record as the vault holds it: an opaque blob under an opaque key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultEntry {
    pub key: String,
    pub seq: u64,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultChanges {
    /// The vault's latest sequence number.
    pub head: u64,
    pub entries: Vec<VaultEntry>,
    /// More entries follow this page.
    pub more: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PutOutcome {
    Stored {
        seq: u64,
    },
    /// The record moved on since the base sequence number; this is what it
    /// holds now.
    Conflict {
        entry: VaultEntry,
    },
}

/// The relay's encrypted record store for one sync key. Every write gets the
/// vault's next sequence number and must name the one it replaces
/// (compare-and-swap), so two computers never silently overwrite each other.
pub trait SyncVault: Send + Sync + 'static {
    /// Entries written after `since`. With `wait_ms > 0` and nothing new, the
    /// vault holds the request until a write lands or the wait runs out.
    /// Dropping the future gives the wait up.
    fn changes(&self, since: u64, wait_ms: u64) -> BoxFuture<'_, Result<VaultChanges, Error>>;
    fn put<'a>(&'a self, key: &'a str, base_seq: u64, data: &'a [u8]) -> BoxFuture<'a, Result<PutOutcome, Error>>;
}

/// This computer's sync bookkeeping (`<data folder>/sync`).
pub trait SyncStateStore: Send + Sync + 'static {
    /// The saved state; empty when there is none or it cannot be read (a
    /// fresh index re-reads the vault, and matching content is no conflict).
    fn load(&self) -> LocalState;
    fn save(&self, state: &LocalState) -> Result<(), Error>;
    /// Keeps the losing side of a conflict. Nothing is overwritten unless
    /// this succeeded.
    fn save_conflict(&self, domain: &str, id: &str, data: &Value) -> Result<(), Error>;
    /// Forgets the state: the next key starts from an empty index.
    fn reset(&self) -> Result<(), Error>;
}

/// Where this computer keeps its sync key. The file is the only copy of the
/// key on a computer whose peers are gone, and readable by the user alone.
pub trait SyncIdentityStore: Send + Sync + 'static {
    fn load(&self) -> Option<SyncIdentity>;
    fn save(&self, identity: &SyncIdentity) -> Result<(), Error>;
    fn clear(&self) -> Result<(), Error>;
}

/// An account's vault, opened with its key.
#[derive(Clone)]
pub struct OpenVault {
    pub vault: Arc<dyn SyncVault>,
    pub crypto: Arc<dyn SyncCrypto>,
}

impl std::fmt::Debug for OpenVault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenVault").finish_non_exhaustive()
    }
}

/// Accounts as the sync feature makes and opens them.
pub trait SyncAccounts: Send + Sync + 'static {
    /// A new account on that relay: a fresh random secret.
    fn create(&self, relay_url: &str) -> SyncIdentity;
    /// The vault and the crypto of the account `identity` names.
    fn open(&self, identity: &SyncIdentity) -> OpenVault;
}

/// Everything the sync engine does with the sync key's secret. The relay
/// never sees a record's id (the record key is a keyed hash) or its content
/// (sealing is authenticated encryption bound to the record key).
pub trait SyncCrypto: Send + Sync + 'static {
    fn record_key(&self, domain: &str, id: &str) -> String;
    fn seal(&self, record_key: &str, plaintext: &[u8]) -> Vec<u8>;
    /// Fails when the blob was not sealed under this key for this record.
    fn open(&self, record_key: &str, sealed: &[u8]) -> Result<Vec<u8>, Error>;
    /// A content fingerprint for change detection (not secret).
    fn hash(&self, text: &str) -> String;
}

/// One kind of user data the sync engine carries (profile fields, memories,
/// pages, …). What it lists is the portable form that travels, and `apply`
/// takes the same shape back through the data's own write path.
/// Computer-specific parts (absolute project paths, chat links) are
/// translated or left out here, never by the engine.
pub trait SyncDomain: Send + Sync + 'static {
    fn name(&self) -> SyncDomainName;
    fn list(&self) -> BoxFuture<'_, Result<Vec<SyncItem>, Error>>;
    fn get<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<SyncItem>, Error>>;
    /// Fails on data it cannot accept; the engine keeps that as a conflict.
    fn apply<'a>(&'a self, id: &'a str, data: &'a Value) -> BoxFuture<'a, Result<(), Error>>;
    fn remove<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), Error>>;
}
