//! Property-style runs: two and three simulated computers share one vault and
//! do random things (edit, delete, sync in any order, sync at the same time,
//! go offline, lose answers on the way back, restart, lose their bookkeeping,
//! read the vault a page at a time, run on clocks that disagree).
//!
//! However a run went, once every computer is back and syncs until nothing
//! moves:
//! - every computer holds the same records, and they are the vault's;
//! - no value a user wrote was dropped: it is what the computers hold, or it
//!   reached the vault and was replaced through sync, or the user replaced it
//!   on the computer that wrote it, or it sits in a conflicts folder.
//!
//! Every run is a seed: a failure names it and replays.

#![allow(clippy::unwrap_used)]

mod support;

use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use eos_core::net::sync::{PutOutcome, SyncVault, VaultChanges};
use eos_core::{BoxFuture, Error};
use eos_testkit::vault::{FakeVault, FakeVaultClient, VaultFault, VaultOp};
use serde_json::{Value, json};
use support::{Mac, TOKEN, VAULT, vault};

/// xorshift64*: small, seeded, the same on every machine.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }

    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }
}

/// The value a write carries: its serial number.
fn serial(data: &Value) -> Option<u64> {
    data.get("n").and_then(Value::as_u64)
}

/// The vault as one computer reaches it, noting every value that landed
/// there (also when the answer was lost on the way back).
struct Witness {
    client: Arc<FakeVaultClient>,
    vault: Arc<FakeVault>,
    landed: Arc<Mutex<HashSet<u64>>>,
}

impl SyncVault for Witness {
    fn changes(&self, since: u64, wait_ms: u64) -> BoxFuture<'_, Result<VaultChanges, Error>> {
        self.client.changes(since, wait_ms)
    }

    fn put<'a>(&'a self, key: &'a str, base_seq: u64, data: &'a [u8]) -> BoxFuture<'a, Result<PutOutcome, Error>> {
        Box::pin(async move {
            let outcome = self.client.put(key, base_seq, data).await;
            let held = self.vault.records(VAULT).into_iter().find(|entry| entry.key == key);
            if let Some(n) = held
                .and_then(|entry| serde_json::from_slice::<Value>(&entry.data).ok())
                .as_ref()
                .and_then(|e| e.get("data"))
                .and_then(serial)
            {
                self.landed.lock().unwrap().insert(n);
            }
            outcome
        })
    }
}

struct Sim {
    seed: u64,
    rng: Arc<Mutex<Rng>>,
    vault: Arc<FakeVault>,
    macs: Vec<Mac>,
    offline: Vec<bool>,
    next_serial: u64,
    /// Every value a user wrote.
    written: Vec<u64>,
    /// Values the user replaced or deleted on the computer that held them.
    replaced_by_user: HashSet<u64>,
    landed: Arc<Mutex<HashSet<u64>>>,
}

const IDS: [&str; 4] = ["um-a", "um-b", "um-c", "um-d"];

impl Sim {
    fn new(seed: u64, computers: usize) -> Self {
        let vault = vault();
        let landed = Arc::new(Mutex::new(HashSet::new()));
        let rng = Arc::new(Mutex::new(Rng::new(seed)));
        let macs = (0..computers)
            .map(|i| {
                let client = vault.client(VAULT, TOKEN);
                let witness =
                    Arc::new(Witness { client: client.clone(), vault: vault.clone(), landed: landed.clone() });
                let mac = Mac::over(client, witness, &format!("mac-{i}"));
                // Clocks disagree by up to a minute either way.
                mac.clock.set(1_000_000 + (i as i64 * 37_000) - 30_000);
                mac.domain.yields.store(true, Ordering::SeqCst);
                mac
            })
            .collect();
        Self {
            seed,
            rng,
            vault,
            macs,
            offline: vec![false; computers],
            next_serial: 1,
            written: Vec::new(),
            replaced_by_user: HashSet::new(),
            landed,
        }
    }

    fn pick(&self, n: u64) -> u64 {
        self.rng.lock().unwrap().below(n)
    }

    fn chance(&self, percent: u64) -> bool {
        self.rng.lock().unwrap().chance(percent)
    }

    fn edit(&mut self, mac: usize) {
        let id = IDS[self.pick(IDS.len() as u64) as usize];
        let m = &self.macs[mac];
        if let Some(old) = m.domain.data(id).as_ref().and_then(serial) {
            self.replaced_by_user.insert(old);
        }
        let at = m.clock.advance(1 + self.pick(5_000) as i64);
        let n = self.next_serial;
        self.next_serial += 1;
        self.written.push(n);
        m.domain.set(id, json!({ "n": n, "at": at, "by": mac }), Some(at as f64));
    }

    fn delete(&mut self, mac: usize) {
        let id = IDS[self.pick(IDS.len() as u64) as usize];
        if let Some(row) = self.macs[mac].domain.delete(id)
            && let Some(old) = serial(&row.data)
        {
            self.replaced_by_user.insert(old);
        }
    }

    /// Faults for the next pass of `mac`: now and then a call fails, or its
    /// answer is lost after the vault did the work.
    fn arm(&self, mac: usize) {
        let rng = self.rng.clone();
        if self.chance(35) {
            self.macs[mac].client.set_fault(move |_op: VaultOp| {
                let mut rng = rng.lock().unwrap();
                match rng.below(12) {
                    0 => Some(VaultFault::Fail),
                    1 => Some(VaultFault::LoseAnswer),
                    _ => None,
                }
            });
        } else {
            self.macs[mac].client.clear_fault();
        }
        self.macs[mac].client.set_page_limit(1 + self.pick(4) as usize);
    }

    async fn step(&mut self) {
        let mac = self.pick(self.macs.len() as u64) as usize;
        match self.pick(100) {
            0..=34 => self.edit(mac),
            35..=42 => self.delete(mac),
            43..=74 => {
                if !self.offline[mac] {
                    self.arm(mac);
                    let _ = self.macs[mac].engine.sync().await;
                }
            }
            // Two computers sync at the same time.
            75..=84 => {
                let other = (mac + 1) % self.macs.len();
                if !self.offline[mac] && !self.offline[other] {
                    self.arm(mac);
                    self.arm(other);
                    let (a, b) = (self.macs[mac].engine.clone(), self.macs[other].engine.clone());
                    let _ = tokio::join!(a.sync(), b.sync());
                }
            }
            85..=90 => self.offline[mac] = !self.offline[mac],
            91..=95 => self.macs[mac].restart(),
            // The bookkeeping is gone (state.json is regenerable).
            96..=97 => {
                *self.macs[mac].state.saved.lock().unwrap() = Default::default();
                self.macs[mac].restart();
            }
            _ => {
                self.macs[mac].clock.advance(self.pick(120_000) as i64);
            }
        }
    }

    /// Everyone is back and the network works: sync until nothing moves.
    async fn settle(&mut self) {
        for mac in &self.macs {
            mac.client.clear_fault();
            mac.client.set_page_limit(200);
        }
        for round in 0.. {
            assert!(round < 25, "seed {}: still exchanging records after 25 rounds", self.seed);
            let mut moved = false;
            for mac in &self.macs {
                let r = mac.engine.sync().await.unwrap_or_else(|e| panic!("seed {}: {e}", self.seed));
                moved |= r.pulled + r.pushed + r.conflicts > 0;
            }
            if !moved {
                return;
            }
        }
    }

    fn check(&self) {
        let seed = self.seed;
        let first = self.macs[0].domain.snapshot();
        for mac in &self.macs[1..] {
            assert_eq!(
                mac.domain.snapshot(),
                first,
                "seed {seed}: {} differs from {}",
                mac.device,
                self.macs[0].device
            );
        }
        let in_vault: BTreeMap<String, Value> = self
            .vault
            .records(VAULT)
            .into_iter()
            .filter_map(|entry| {
                let envelope: Value = serde_json::from_slice(&entry.data).ok()?;
                let id = envelope["id"].as_str()?.to_owned();
                envelope.get("deleted").is_none().then(|| (id, envelope["data"].clone()))
            })
            .collect();
        assert_eq!(in_vault, first, "seed {seed}: the vault and the computers disagree");

        let held: HashSet<u64> = first.values().filter_map(serial).collect();
        let kept_aside: HashSet<u64> =
            self.macs.iter().flat_map(Mac::conflicts).filter_map(|(_, data)| serial(&data)).collect();
        let landed = self.landed.lock().unwrap();
        for n in &self.written {
            let safe =
                held.contains(n) || landed.contains(n) || self.replaced_by_user.contains(n) || kept_aside.contains(n);
            assert!(safe, "seed {seed}: write {n} was dropped without a trace");
        }
    }
}

async fn run(seed: u64, computers: usize, steps: usize) {
    let mut sim = Sim::new(seed, computers);
    for _ in 0..steps {
        sim.step().await;
    }
    sim.settle().await;
    sim.check();
}

#[tokio::test]
async fn two_computers_converge_and_lose_nothing() {
    for seed in 0..400 {
        run(seed, 2, 80).await;
    }
}

#[tokio::test]
async fn three_computers_converge_and_lose_nothing() {
    for seed in 1_000..1_400 {
        run(seed, 3, 120).await;
    }
}

#[tokio::test]
async fn a_long_run_with_three_computers_converges() {
    run(7, 3, 5_000).await;
}
