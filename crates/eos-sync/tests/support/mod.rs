//! Simulated computers around one in-memory vault.

#![allow(dead_code, clippy::unwrap_used)]

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use eos_contracts::SyncDomainName;
use eos_core::net::sync::{SyncCrypto, SyncDomain, SyncStateStore, SyncVault};
use eos_core::{BoxFuture, Error};
use eos_domain::sync::{LocalState, SyncItem};
use eos_sync::{SyncEngine, SyncEngineDeps};
use eos_testkit::FakeClock;
use eos_testkit::vault::{FakeVault, FakeVaultClient, VaultLimits};
use serde_json::Value;

pub(crate) const VAULT: &str = "0123456789abcdef0123456789abcdef";
pub(crate) const TOKEN: &str = "token-0123456789abcdef";

/// Readable on purpose: the engine treats sealing as opaque, tests read the blobs.
pub(crate) struct Plain;

impl SyncCrypto for Plain {
    fn record_key(&self, domain: &str, id: &str) -> String {
        format!("{domain}/{id}")
    }
    fn seal(&self, _record_key: &str, plaintext: &[u8]) -> Vec<u8> {
        plaintext.to_vec()
    }
    fn open(&self, _record_key: &str, sealed: &[u8]) -> Result<Vec<u8>, Error> {
        Ok(sealed.to_vec())
    }
    fn hash(&self, text: &str) -> String {
        text.to_owned()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Row {
    pub(crate) data: Value,
    pub(crate) updated_at: Option<f64>,
}

/// A domain held in a map. `apply` stamps the row with the data's own `at`,
/// as a real domain keeps the sender's timestamp.
pub(crate) struct MapDomain {
    pub(crate) rows: Mutex<BTreeMap<String, Row>>,
    pub(crate) fail_apply: AtomicBool,
    /// Yield at every call, so two passes running together interleave.
    pub(crate) yields: AtomicBool,
}

impl MapDomain {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self { rows: Mutex::default(), fail_apply: AtomicBool::new(false), yields: AtomicBool::new(false) })
    }

    pub(crate) fn set(&self, id: &str, data: Value, updated_at: Option<f64>) {
        self.rows.lock().unwrap().insert(id.to_owned(), Row { data, updated_at });
    }

    pub(crate) fn delete(&self, id: &str) -> Option<Row> {
        self.rows.lock().unwrap().remove(id)
    }

    pub(crate) fn data(&self, id: &str) -> Option<Value> {
        self.rows.lock().unwrap().get(id).map(|row| row.data.clone())
    }

    pub(crate) fn has(&self, id: &str) -> bool {
        self.rows.lock().unwrap().contains_key(id)
    }

    pub(crate) fn ids(&self) -> Vec<String> {
        self.rows.lock().unwrap().keys().cloned().collect()
    }

    pub(crate) fn snapshot(&self) -> BTreeMap<String, Value> {
        self.rows.lock().unwrap().iter().map(|(id, row)| (id.clone(), row.data.clone())).collect()
    }

    async fn pause(&self) {
        if self.yields.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
    }
}

impl SyncDomain for MapDomain {
    fn name(&self) -> SyncDomainName {
        SyncDomainName::Memory
    }

    fn list(&self) -> BoxFuture<'_, Result<Vec<SyncItem>, Error>> {
        Box::pin(async move {
            self.pause().await;
            let rows = self.rows.lock().unwrap();
            Ok(rows
                .iter()
                .map(|(id, row)| SyncItem { id: id.clone(), data: row.data.clone(), updated_at: row.updated_at })
                .collect())
        })
    }

    fn get<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<SyncItem>, Error>> {
        Box::pin(async move {
            self.pause().await;
            let rows = self.rows.lock().unwrap();
            Ok(rows.get(id).map(|row| SyncItem {
                id: id.to_owned(),
                data: row.data.clone(),
                updated_at: row.updated_at,
            }))
        })
    }

    fn apply<'a>(&'a self, id: &'a str, data: &'a Value) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(async move {
            self.pause().await;
            if self.fail_apply.load(Ordering::SeqCst) {
                return Err(Error::Validation("bad data".into()));
            }
            self.set(id, data.clone(), data.get("at").and_then(Value::as_f64));
            Ok(())
        })
    }

    fn remove<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(async move {
            self.pause().await;
            self.delete(id);
            Ok(())
        })
    }
}

#[derive(Default)]
pub(crate) struct MemState {
    pub(crate) saved: Mutex<LocalState>,
    pub(crate) conflicts: Mutex<Vec<(String, Value)>>,
    pub(crate) fail_conflicts: AtomicBool,
}

impl SyncStateStore for MemState {
    fn load(&self) -> LocalState {
        self.saved.lock().unwrap().clone()
    }
    fn save(&self, state: &LocalState) -> Result<(), Error> {
        *self.saved.lock().unwrap() = state.clone();
        Ok(())
    }
    fn save_conflict(&self, _domain: &str, id: &str, data: &Value) -> Result<(), Error> {
        if self.fail_conflicts.load(Ordering::SeqCst) {
            return Err(Error::Storage("the conflicts folder is not writable".into()));
        }
        self.conflicts.lock().unwrap().push((id.to_owned(), data.clone()));
        Ok(())
    }
    fn reset(&self) -> Result<(), Error> {
        *self.saved.lock().unwrap() = LocalState::default();
        Ok(())
    }
}

/// One computer: its data, its bookkeeping, its clock and its engine.
pub(crate) struct Mac {
    pub(crate) device: String,
    pub(crate) domain: Arc<MapDomain>,
    pub(crate) state: Arc<MemState>,
    pub(crate) clock: Arc<FakeClock>,
    pub(crate) client: Arc<FakeVaultClient>,
    pub(crate) vault: Arc<dyn SyncVault>,
    pub(crate) engine: Arc<SyncEngine>,
}

impl Mac {
    pub(crate) fn new(vault: &Arc<FakeVault>, device: &str) -> Self {
        let client = vault.client(VAULT, TOKEN);
        Self::over(client.clone(), client, device)
    }

    /// With the engine reaching the vault through `port` (a test's wrapper
    /// around `client`).
    pub(crate) fn over(client: Arc<FakeVaultClient>, port: Arc<dyn SyncVault>, device: &str) -> Self {
        let domain = MapDomain::new();
        let state = Arc::new(MemState::default());
        let clock = Arc::new(FakeClock::at(1000));
        let engine = Arc::new(engine(&port, &domain, &state, &clock, device));
        Self { device: device.to_owned(), domain, state, clock, client, vault: port, engine }
    }

    /// A new engine over the saved state, as after a restart of the app.
    pub(crate) fn restart(&mut self) {
        self.engine = Arc::new(engine(&self.vault, &self.domain, &self.state, &self.clock, &self.device));
    }

    pub(crate) fn conflicts(&self) -> Vec<(String, Value)> {
        self.state.conflicts.lock().unwrap().clone()
    }
}

fn engine(
    vault: &Arc<dyn SyncVault>,
    domain: &Arc<MapDomain>,
    state: &Arc<MemState>,
    clock: &Arc<FakeClock>,
    device: &str,
) -> SyncEngine {
    SyncEngine::new(SyncEngineDeps {
        vault: vault.clone(),
        crypto: Arc::new(Plain),
        state: state.clone(),
        domains: vec![domain.clone()],
        clock: clock.clone(),
        device: device.to_owned(),
    })
}

pub(crate) fn vault() -> Arc<FakeVault> {
    FakeVault::new(VaultLimits::default())
}
