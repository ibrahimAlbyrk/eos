//! The service's clockwork on a paused clock: when a pass runs, what the
//! status says, how failures back off, the Jobs entry of a long pass.

#![allow(clippy::unwrap_used)]

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use eos_contracts::{SyncDomainName, SyncPhase};
use eos_core::net::sync::{OpenVault, SyncAccounts, SyncCrypto, SyncDomain, SyncIdentityStore, SyncStateStore};
use eos_core::{BoxFuture, Error};
use eos_domain::sync::{LocalState, SyncIdentity, SyncItem, SyncKeys};
use eos_mod_sync::{SYNC_CHANGE, SyncService, SyncServiceDeps, Timing};
use eos_runtime::{Kernel, KernelOptions};
use eos_sync_vault::VaultCrypto;
use eos_testkit::FakeClock;
use eos_testkit::vault::{FakeVault, FakeVaultClient, VaultFault, VaultLimits};
use serde_json::{Value, json};
use tokio::sync::Notify;

const KEY: &str = "eos-sync1.d3NzOi8vcmVsYXkuZXhhbXBsZS50ZXN0L2Vvcw.VvhpXHc1JwTFwZEFiNDSohG7wN7QkqCUBVm8xSa_NFw";

#[derive(Default)]
struct MemFiles {
    identity: Mutex<Option<SyncIdentity>>,
    state: Mutex<LocalState>,
    conflicts: Mutex<Vec<(String, Value)>>,
}

impl SyncIdentityStore for MemFiles {
    fn load(&self) -> Option<SyncIdentity> {
        self.identity.lock().unwrap().clone()
    }
    fn save(&self, identity: &SyncIdentity) -> Result<(), Error> {
        *self.identity.lock().unwrap() = Some(identity.clone());
        Ok(())
    }
    fn clear(&self) -> Result<(), Error> {
        *self.identity.lock().unwrap() = None;
        Ok(())
    }
}

impl SyncStateStore for MemFiles {
    fn load(&self) -> LocalState {
        self.state.lock().unwrap().clone()
    }
    fn save(&self, state: &LocalState) -> Result<(), Error> {
        *self.state.lock().unwrap() = state.clone();
        Ok(())
    }
    fn save_conflict(&self, _domain: &str, id: &str, data: &Value) -> Result<(), Error> {
        self.conflicts.lock().unwrap().push((id.to_owned(), data.clone()));
        Ok(())
    }
    fn reset(&self) -> Result<(), Error> {
        *self.state.lock().unwrap() = LocalState::default();
        Ok(())
    }
}

/// Accounts on the in-memory vault, with the real crypto of the key.
struct Accounts {
    vault: Arc<FakeVault>,
    /// The connection of the account opened last, for a test's faults.
    client: Mutex<Option<Arc<FakeVaultClient>>>,
}

impl SyncAccounts for Accounts {
    fn create(&self, relay_url: &str) -> SyncIdentity {
        SyncIdentity { relay_url: relay_url.to_owned(), secret: [7; 32] }
    }
    fn open(&self, identity: &SyncIdentity) -> OpenVault {
        let keys = SyncKeys::derive(&identity.secret);
        let client = self.vault.client(&keys.vault_id, &keys.auth_token);
        *self.client.lock().unwrap() = Some(client.clone());
        let crypto: Arc<dyn SyncCrypto> = Arc::new(VaultCrypto::new(keys));
        OpenVault { vault: client, crypto }
    }
}

/// A folder of rows that counts how often it is listed, and can hold a pass up.
#[derive(Default)]
struct Rows {
    rows: Mutex<Vec<(String, Value)>>,
    listed: AtomicUsize,
    hold: AtomicBool,
    release: Notify,
}

impl SyncDomain for Rows {
    fn name(&self) -> SyncDomainName {
        SyncDomainName::Worker
    }
    fn list(&self) -> BoxFuture<'_, Result<Vec<SyncItem>, Error>> {
        Box::pin(async move {
            self.listed.fetch_add(1, Ordering::SeqCst);
            if self.hold.load(Ordering::SeqCst) {
                self.release.notified().await;
            }
            let rows = self.rows.lock().unwrap();
            Ok(rows
                .iter()
                .map(|(id, data)| SyncItem { id: id.clone(), data: data.clone(), updated_at: None })
                .collect())
        })
    }
    fn get<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<SyncItem>, Error>> {
        let row = self.rows.lock().unwrap().iter().find(|(row, _)| row == id).cloned();
        Box::pin(std::future::ready(Ok(row.map(|(id, data)| SyncItem { id, data, updated_at: None }))))
    }
    fn apply<'a>(&'a self, id: &'a str, data: &'a Value) -> BoxFuture<'a, Result<(), Error>> {
        let mut rows = self.rows.lock().unwrap();
        rows.retain(|(row, _)| row != id);
        rows.push((id.to_owned(), data.clone()));
        Box::pin(std::future::ready(Ok(())))
    }
    fn remove<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        self.rows.lock().unwrap().retain(|(row, _)| row != id);
        Box::pin(std::future::ready(Ok(())))
    }
}

struct Bench {
    kernel: Kernel,
    files: Arc<MemFiles>,
    accounts: Arc<Accounts>,
    rows: Arc<Rows>,
    service: Arc<SyncService>,
}

fn bench(relay: Option<&'static str>) -> Bench {
    let clock = Arc::new(FakeClock::new());
    let kernel = Kernel::new(KernelOptions { clock: clock.clone(), ..KernelOptions::default() });
    let files = Arc::new(MemFiles::default());
    let accounts = Arc::new(Accounts { vault: FakeVault::new(VaultLimits::default()), client: Mutex::new(None) });
    let rows = Arc::new(Rows::default());
    let service = SyncService::new(
        SyncServiceDeps {
            identities: files.clone(),
            state: files.clone(),
            accounts: accounts.clone(),
            relay_url: Arc::new(move || relay.map(str::to_owned)),
            device: Arc::new(|| "air".to_owned()),
            timing: Timing::default(),
        },
        vec![rows.clone()],
        clock,
        kernel.bus.clone(),
        kernel.jobs.clone(),
    );
    Bench { kernel, files, accounts, rows, service }
}

impl Bench {
    fn client(&self) -> Arc<FakeVaultClient> {
        self.accounts.client.lock().unwrap().clone().unwrap()
    }

    /// Lets the service's task run until it waits on time or the network.
    async fn settle(&self) {
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
    }

    fn passes(&self) -> usize {
        self.rows.listed.load(Ordering::SeqCst)
    }
}

#[tokio::test(start_paused = true)]
async fn a_pass_runs_on_start_after_a_settled_change_on_demand_and_every_minute() {
    let b = bench(Some("wss://relay.example.test/eos"));
    let phases = Arc::new(Mutex::new(Vec::new()));
    let _heard = b.kernel.bus.on(&SYNC_CHANGE, {
        let phases = phases.clone();
        move |event| {
            let status = event.payload_as::<Value>().unwrap();
            phases.lock().unwrap().push(status["phase"].as_str().unwrap().to_owned());
        }
    });
    let created = b.service.create().unwrap();
    assert_eq!(created.phase, SyncPhase::Idle, "open, not yet syncing");
    assert_eq!(created.relay.as_deref(), Some("relay.example.test"));
    assert_eq!(created.counts.get("worker"), Some(&0));
    b.settle().await;
    assert_eq!(b.passes(), 1, "the first pass");

    // The status went off → idle (opened) → syncing → idle, in that order.
    // Events are delivered on the bus's own thread: wait for them without
    // letting the paused clock run ahead.
    while phases.lock().unwrap().len() < 3 {
        tokio::task::yield_now().await;
    }
    assert_eq!(phases.lock().unwrap().as_slice(), ["idle", "syncing", "idle"]);
    assert_eq!(b.service.status().last_sync_at.map(|at| at.as_f64()), Some(FakeClock::START_MS as f64));

    // A burst of local changes: one pass, 1.5 s after the last of them.
    b.rows.rows.lock().unwrap().push(("reviewer".into(), json!({ "md": "x" })));
    b.service.note_local_change();
    tokio::time::sleep(Duration::from_millis(1000)).await;
    b.service.note_local_change();
    tokio::time::sleep(Duration::from_millis(1400)).await;
    b.settle().await;
    assert_eq!(b.passes(), 1, "still settling");
    tokio::time::sleep(Duration::from_millis(200)).await;
    b.settle().await;
    assert_eq!(b.passes(), 2, "one pass for the burst, and none for its own write coming back");
    assert_eq!(b.service.status().counts.get("worker"), Some(&1));

    b.service.sync_now();
    b.settle().await;
    assert_eq!(b.passes(), 3, "the user asked");

    // Nothing happens: the long poll comes back empty and is asked again, no pass.
    tokio::time::sleep(Duration::from_secs(30)).await;
    b.settle().await;
    assert_eq!(b.passes(), 3);
    // The sweep, for folders that have no change event.
    tokio::time::sleep(Duration::from_secs(31)).await;
    b.settle().await;
    assert_eq!(b.passes(), 4);

    b.service.stop();
    b.settle().await;
    tokio::time::sleep(Duration::from_secs(300)).await;
    assert_eq!(b.passes(), 4, "a stopped service does nothing more");
}

#[tokio::test(start_paused = true)]
async fn another_computers_write_wakes_the_long_poll() {
    let b = bench(None);
    b.service.join(KEY).unwrap();
    b.settle().await;
    assert_eq!(b.passes(), 1);
    // Another computer of the same account writes a record.
    let keys = SyncKeys::derive(&eos_domain::sync::parse_sync_key(KEY).unwrap().secret);
    let crypto = VaultCrypto::new(SyncKeys::derive(&eos_domain::sync::parse_sync_key(KEY).unwrap().secret));
    let name = crypto.record_key("worker", "reviewer");
    let envelope = json!({ "v": 1, "domain": "worker", "id": "reviewer", "changedAt": 5, "device": "pro", "data": { "md": "theirs" } });
    let sealed = crypto.seal(&name, envelope.to_string().as_bytes());
    b.accounts.vault.put(&keys.vault_id, &name, 0, &sealed);
    b.settle().await;
    assert_eq!(b.passes(), 2, "woken at once, not at the next sweep");
    assert_eq!(b.rows.rows.lock().unwrap().as_slice(), [("reviewer".to_owned(), json!({ "md": "theirs" }))]);
    b.service.stop();
}

#[tokio::test(start_paused = true)]
async fn failures_show_in_the_status_back_off_and_recover() {
    let b = bench(None);
    b.service.join(KEY).unwrap();
    b.settle().await;
    b.client().set_fault(|_| Some(VaultFault::Fail));
    b.service.sync_now();
    b.settle().await;
    let failed = b.service.status();
    assert_eq!(failed.phase, SyncPhase::Error);
    assert_eq!(failed.error.as_deref(), Some("unreachable: sync vault: offline"));
    let after_failure = b.passes();

    // 5 s, then 15 s, then 60 s between tries.
    tokio::time::sleep(Duration::from_millis(4_900)).await;
    b.settle().await;
    assert_eq!(b.passes(), after_failure);
    tokio::time::sleep(Duration::from_millis(200)).await;
    b.settle().await;
    assert_eq!(b.passes(), after_failure, "the pass failed at the vault, before the folders");
    tokio::time::sleep(Duration::from_secs(15)).await;
    b.settle().await;

    b.client().clear_fault();
    tokio::time::sleep(Duration::from_secs(60)).await;
    b.settle().await;
    let recovered = b.service.status();
    assert_eq!((recovered.phase, recovered.error), (SyncPhase::Idle, None));
    assert_eq!(b.passes(), after_failure + 1);
    b.service.stop();
}

#[tokio::test(start_paused = true)]
async fn a_pass_that_outlasts_a_moment_shows_in_the_jobs_list() {
    let b = bench(None);
    b.rows.hold.store(true, Ordering::SeqCst);
    b.service.join(KEY).unwrap();
    b.settle().await;
    assert_eq!(b.service.status().phase, SyncPhase::Syncing);
    assert!(b.kernel.jobs.list().is_empty(), "a quick pass never flickers in");
    tokio::time::sleep(Duration::from_millis(1600)).await;
    b.settle().await;
    let jobs = b.kernel.jobs.list();
    assert_eq!(jobs.len(), 1);
    assert_eq!(
        (jobs[0].kind.as_str(), jobs[0].title.as_str(), jobs[0].worker_id.as_deref()),
        ("sync", "Syncing", None)
    );
    assert_eq!(jobs[0].id, "sync:eos:sync");

    b.rows.hold.store(false, Ordering::SeqCst);
    b.rows.release.notify_waiters();
    b.settle().await;
    assert!(b.kernel.jobs.list().is_empty(), "gone with the pass");
    assert_eq!(b.service.status().phase, SyncPhase::Idle);

    // A pass cut short by leaving takes its entry with it too.
    b.rows.hold.store(true, Ordering::SeqCst);
    b.service.sync_now();
    b.settle().await;
    tokio::time::sleep(Duration::from_millis(1600)).await;
    b.settle().await;
    assert_eq!(b.kernel.jobs.list().len(), 1);
    b.service.leave().unwrap();
    b.settle().await;
    assert!(b.kernel.jobs.list().is_empty());
    assert_eq!(b.service.status().phase, SyncPhase::Off);
    assert!(b.files.identity.lock().unwrap().is_none());
}

#[tokio::test(start_paused = true)]
async fn joining_another_account_starts_from_an_empty_index() {
    let b = bench(Some("wss://relay.example.test/eos"));
    b.rows.rows.lock().unwrap().push(("reviewer".into(), json!({ "md": "x" })));
    b.service.create().unwrap();
    b.settle().await;
    assert_eq!(b.files.state.lock().unwrap().index.len(), 1);
    let first = b.service.key().unwrap();
    b.service.join(KEY).unwrap();
    assert_ne!(b.service.key().unwrap(), first);
    assert!(b.files.state.lock().unwrap().index.is_empty(), "the old account's bookkeeping is gone");
    b.settle().await;
    assert_eq!(b.service.status().counts.get("worker"), Some(&1), "this computer's record went to the new account");
    b.service.stop();
}
