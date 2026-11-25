//! Who runs a routine, between computers on one vault: the lease and
//! heartbeat records over the in-memory vault, pulled by the real engine.

use std::sync::{Arc, Mutex};

use eos_core::net::sync::{LeaseSink, LeaseVault, PutOutcome, SyncCrypto, SyncStateStore, SyncVault};
use eos_core::signals::{DeviceReport, HeldRoutine, Holder, Runner, RunnerError};
use eos_core::{Clock, Error};
use eos_domain::sync::LocalState;
use eos_mod_sync::{LeaseSinkOf, VaultRunner};
use eos_sync::{SyncEngine, SyncEngineDeps};
use eos_testkit::vault::{FakeVault, VaultLimits};
use eos_testkit::{FakeClock, TempStore};
use serde_json::{Value, json};

const DAY: i64 = 24 * 60 * 60 * 1000;

/// Readable on purpose: the tests look at nothing sealed.
struct Plain;

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

#[derive(Default)]
struct Memory(Mutex<LocalState>);

impl SyncStateStore for Memory {
    fn load(&self) -> LocalState {
        self.0.lock().unwrap().clone()
    }
    fn save(&self, state: &LocalState) -> Result<(), Error> {
        *self.0.lock().unwrap() = state.clone();
        Ok(())
    }
    fn save_conflict(&self, _domain: &str, _id: &str, _data: &Value) -> Result<(), Error> {
        Ok(())
    }
    fn reset(&self) -> Result<(), Error> {
        Ok(())
    }
}

struct Computer {
    runner: Arc<VaultRunner>,
    engine: SyncEngine,
    temp: TempStore,
}

fn computer(vault: &Arc<FakeVault>, device: &str, clock: &Arc<FakeClock>) -> Computer {
    let temp = TempStore::new();
    let name = device.to_uppercase();
    let runner = Arc::new(VaultRunner::new(device, Arc::new(move || name.clone()), temp.store.clone(), clock.clone()));
    let client: Arc<dyn SyncVault> = vault.client("0123456789abcdef0123456789abcdef", "token-0123456789abcdef");
    let sink = Arc::new(LeaseSinkOf(runner.clone()));
    sink.attach(Some(LeaseVault { vault: client.clone(), crypto: Arc::new(Plain) }));
    let engine = SyncEngine::new(SyncEngineDeps {
        vault: client,
        crypto: Arc::new(Plain),
        state: Arc::new(Memory::default()),
        domains: Vec::new(),
        clock: clock.clone(),
        device: device.to_owned(),
        budgets: Vec::new(),
        leases: Some(sink),
    });
    Computer { runner, engine, temp }
}

impl Computer {
    async fn pull(&self) {
        self.engine.sync().await.unwrap();
        // The mirror writes go on their own tasks: let them land.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

fn report(clock: &FakeClock, routine: &str, epoch: i64, watermarks: Value) -> DeviceReport {
    let held = HeldRoutine { routine_id: routine.into(), epoch, watermarks, counts: vec![0, 2, 1] };
    DeviceReport { name: String::new(), seen_at: clock.now_ms(), holds: vec![held] }
}

#[tokio::test]
async fn of_two_computers_claiming_a_routine_at_once_exactly_one_holds_it() {
    let (vault, clock) = (FakeVault::new(VaultLimits::default()), Arc::new(FakeClock::at(1_000)));
    let (air, pro, mini) =
        (computer(&vault, "air", &clock), computer(&vault, "pro", &clock), computer(&vault, "mini", &clock));
    air.runner.adopt("rt-1").await.unwrap();
    pro.pull().await;
    mini.pull().await;
    assert_eq!(pro.runner.holder("rt-1"), Holder::Elsewhere { device_id: "air".into(), epoch: 1 });

    let (by_pro, by_mini) = tokio::join!(pro.runner.claim("rt-1"), mini.runner.claim("rt-1"));
    let won: Vec<bool> = [&by_pro, &by_mini].iter().map(|claimed| claimed.is_ok()).collect();
    assert_eq!(won.iter().filter(|won| **won).count(), 1, "{by_pro:?} {by_mini:?}");
    let (winner, loser) = if by_pro.is_ok() { (&pro, &mini) } else { (&mini, &pro) };
    let lost = if by_pro.is_ok() { by_mini } else { by_pro };
    assert!(matches!(lost, Err(RunnerError::Lost { epoch: 2, .. })), "the loser is told who won");
    assert_eq!(winner.runner.holder("rt-1"), Holder::Here { epoch: 2 });
    assert!(matches!(loser.runner.holder("rt-1"), Holder::Elsewhere { epoch: 2, .. }));

    // The computer it was taken from stops at its next read.
    air.pull().await;
    assert!(matches!(air.runner.holder("rt-1"), Holder::Elsewhere { epoch: 2, .. }));
    assert!(air.runner.adopt("rt-1").await.is_ok(), "adopting never takes back a lease that exists");
    assert!(matches!(air.runner.holder("rt-1"), Holder::Elsewhere { epoch: 2, .. }));
}

#[tokio::test]
async fn a_move_from_a_computer_away_for_a_week_starts_from_its_last_watermarks() {
    let (vault, clock) = (FakeVault::new(VaultLimits::default()), Arc::new(FakeClock::at(1_000)));
    let (air, pro) = (computer(&vault, "air", &clock), computer(&vault, "pro", &clock));
    air.runner.adopt("rt-1").await.unwrap();
    let marks = json!({"sources": {"src-1": {"cursor": {"etag": "e1"}, "keys": ["k1"]}}, "schedules": {"0": 500}});
    air.runner.report(&report(&clock, "rt-1", 1, marks.clone())).await.unwrap();
    pro.pull().await;
    let seen = pro.runner.devices();
    assert_eq!((seen.len(), seen[0].name.as_str(), seen[0].seen_at), (1, "AIR", 1_000));
    assert_eq!(seen[0].routines, vec!["rt-1".to_owned()]);
    assert_eq!(pro.runner.hourly_elsewhere("rt-1"), Some((1_000, vec![0, 2, 1])), "its heartbeat's counts");
    assert_eq!(air.runner.hourly_elsewhere("rt-1"), None, "a routine held here counts its own");

    clock.advance(7 * DAY);
    let handoff = pro.runner.claim("rt-1").await.unwrap();
    assert_eq!((handoff.epoch, handoff.watermarks), (2, Some(marks.clone())));

    // After a restart the view, the away computer's heartbeat with it, is read back.
    let again = Arc::new(VaultRunner::new("pro", Arc::new(|| "PRO".into()), pro.temp.store.clone(), clock.clone()));
    again.restore().await.unwrap();
    assert_eq!(again.holder("rt-1"), Holder::Here { epoch: 2 });
    let seen = air_after_restart(&air, &clock).await;
    assert!(matches!(seen, Holder::Elsewhere { epoch: 2, .. }), "the returning computer stops");
}

async fn air_after_restart(air: &Computer, clock: &Arc<FakeClock>) -> Holder {
    let restarted = Arc::new(VaultRunner::new("air", Arc::new(|| "AIR".into()), air.temp.store.clone(), clock.clone()));
    restarted.restore().await.unwrap();
    assert_eq!(restarted.holder("rt-1"), Holder::Here { epoch: 1 }, "it starts from its own last view");
    air.pull().await;
    air.runner.holder("rt-1")
}

#[tokio::test]
async fn a_routine_with_no_lease_read_is_held_by_nobody_while_shared_and_here_while_not() {
    let (vault, clock) = (FakeVault::new(VaultLimits::default()), Arc::new(FakeClock::at(1_000)));
    let air = computer(&vault, "air", &clock);
    assert_eq!(air.runner.holder("rt-synced"), Holder::Unknown);
    assert!(air.runner.confirmed_at().is_none(), "no read yet");
    air.pull().await;
    assert_eq!(air.runner.confirmed_at(), Some(1_000));

    let alone =
        Arc::new(VaultRunner::new("solo", Arc::new(|| "SOLO".into()), TempStore::new().store.clone(), clock.clone()));
    assert_eq!(alone.holder("rt-1"), Holder::Unknown, "nothing is known before sync says whether it is on");
    assert!(alone.shared(), "so nothing is acted on before a read");
    LeaseSinkOf(alone.clone()).attach(None);
    assert!(!alone.shared());
    assert_eq!(alone.holder("rt-1"), Holder::Here { epoch: 0 });
    alone.adopt("rt-1").await.unwrap();
    assert_eq!(alone.holder("rt-1"), Holder::Here { epoch: 1 });
    assert_eq!(alone.report(&report(&clock, "rt-1", 1, json!({}))).await, Err(RunnerError::Off));
}

#[tokio::test]
async fn a_lease_taken_before_the_vault_opened_is_written_at_the_first_read() {
    let (vault, clock) = (FakeVault::new(VaultLimits::default()), Arc::new(FakeClock::at(1_000)));
    let temp = TempStore::new();
    let runner = Arc::new(VaultRunner::new("air", Arc::new(|| "AIR".into()), temp.store.clone(), clock.clone()));
    runner.adopt("rt-1").await.unwrap();
    let sink = LeaseSinkOf(runner.clone());
    let client: Arc<dyn SyncVault> = vault.client("0123456789abcdef0123456789abcdef", "token-0123456789abcdef");
    sink.attach(Some(LeaseVault { vault: client, crypto: Arc::new(Plain) }));
    sink.pulled();
    let pro = computer(&vault, "pro", &clock);
    for _ in 0..50 {
        pro.pull().await;
        if pro.runner.holder("rt-1") != Holder::Unknown {
            break;
        }
    }
    assert_eq!(pro.runner.holder("rt-1"), Holder::Elsewhere { device_id: "air".into(), epoch: 1 });
}

#[tokio::test]
async fn an_older_lease_put_back_in_the_vault_never_undoes_a_move() {
    let (vault, clock) = (FakeVault::new(VaultLimits::default()), Arc::new(FakeClock::at(1_000)));
    let (air, pro) = (computer(&vault, "air", &clock), computer(&vault, "pro", &clock));
    air.runner.adopt("rt-1").await.unwrap();
    pro.pull().await;
    let first = vault_entry(&vault, "lease/rt-1");
    pro.runner.claim("rt-1").await.unwrap();
    air.pull().await;
    assert!(matches!(air.runner.holder("rt-1"), Holder::Elsewhere { epoch: 2, .. }));

    // Whoever holds the vault's token writes the epoch-1 record back under a new sequence.
    let client = pro_client(&vault);
    let base = vault_entry(&vault, "lease/rt-1").seq;
    assert!(matches!(client.put("lease/rt-1", base, &first.data).await.unwrap(), PutOutcome::Stored { .. }));
    air.pull().await;
    pro.pull().await;
    assert!(matches!(air.runner.holder("rt-1"), Holder::Elsewhere { epoch: 2, .. }));
    assert_eq!(pro.runner.holder("rt-1"), Holder::Here { epoch: 2 });
}

fn pro_client(vault: &Arc<FakeVault>) -> Arc<dyn SyncVault> {
    vault.client("0123456789abcdef0123456789abcdef", "token-0123456789abcdef")
}

fn vault_entry(vault: &Arc<FakeVault>, key: &str) -> eos_core::net::sync::VaultEntry {
    let records = vault.records("0123456789abcdef0123456789abcdef");
    records.into_iter().find(|entry| entry.key == key).expect("the record is in the vault")
}
