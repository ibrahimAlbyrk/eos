//! Which of the user's computers runs each routine, kept in the sync vault
//! (02 §4.6): `lease/<routine>` names its holder and epoch, and
//! `device/<id>` is each computer's heartbeat with how far it got on the
//! routines it holds. Both are written with the vault's compare-and-swap,
//! so of two computers claiming one routine at once exactly one wins.
//!
//! The view lives in memory and in `signal_runners`, so a restart starts
//! from what was last read. While no vault is open, a routine with no lease
//! is held here and a claim moves it only on this computer.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use eos_core::net::sync::{LeaseSink, LeaseVault, PutOutcome, VaultEntry};
use eos_core::signals::{DeviceReport, DeviceSeen, Handoff, Holder, Runner, RunnerError};
use eos_core::store::{Store, StoredSignalRunner};
use eos_core::{BoxFuture, Clock};
use serde_json::{Value, json};

use crate::service::DeviceName;

const LEASE: &str = "lease";
const DEVICE: &str = "device";

#[derive(Debug, Clone, PartialEq)]
struct Lease {
    holder: String,
    epoch: i64,
    /// The vault's sequence of the record; 0 while it is known only here.
    seq: u64,
}

#[derive(Debug, Clone, Default, PartialEq)]
struct Device {
    name: String,
    seen_at: i64,
    seq: u64,
    /// By routine: the epoch it held it at, its watermarks and hourly counts.
    holds: HashMap<String, (i64, Value, Value)>,
}

#[derive(Default)]
struct View {
    vault: Option<LeaseVault>,
    leases: HashMap<String, Lease>,
    devices: HashMap<String, Device>,
    confirmed_at: Option<i64>,
}

pub struct VaultRunner {
    device_id: String,
    name: DeviceName,
    store: Arc<dyn Store>,
    clock: Arc<dyn Clock>,
    view: Mutex<View>,
}

impl std::fmt::Debug for VaultRunner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VaultRunner").field("device_id", &self.device_id).finish_non_exhaustive()
    }
}

fn locked(view: &Mutex<View>) -> MutexGuard<'_, View> {
    view.lock().unwrap_or_else(PoisonError::into_inner)
}

fn unreachable(error: &eos_core::Error) -> RunnerError {
    tracing::info!(error = %error, "runner: the vault could not be reached");
    RunnerError::Unreachable
}

impl VaultRunner {
    pub fn new(device_id: impl Into<String>, name: DeviceName, store: Arc<dyn Store>, clock: Arc<dyn Clock>) -> Self {
        Self { device_id: device_id.into(), name, store, clock, view: Mutex::default() }
    }

    /// Reads back the view this computer last kept.
    pub async fn restore(&self) -> Result<(), eos_core::Error> {
        let rows = self.store.read(|tx| tx.signal_runners().list()).await?;
        let mut view = locked(&self.view);
        for row in rows {
            let seq = u64::try_from(row.seen_seq).unwrap_or_default();
            if row.holder_device != self.device_id
                && let Some(report) =
                    row.handoff_json.as_deref().and_then(|json| serde_json::from_str::<Value>(json).ok())
            {
                let device = view.devices.entry(row.holder_device.clone()).or_default();
                device.name = report["name"].as_str().unwrap_or_default().to_owned();
                device.seen_at = report["seenAt"].as_i64().unwrap_or_default();
                let held = (row.epoch, report["watermarks"].clone(), report["hourly"].clone());
                device.holds.insert(row.routine_id.clone(), held);
            }
            view.leases.insert(row.routine_id, Lease { holder: row.holder_device, epoch: row.epoch, seq });
        }
        Ok(())
    }

    fn lease_record(&self, routine_id: &str, epoch: i64) -> Value {
        json!({"lease": 1, "routine": routine_id, "holder": self.device_id, "epoch": epoch, "since": self.clock.now_ms()})
    }

    /// Writes `record` under `key` over `base`: the sequence it got, or
    /// what the vault holds instead, opened.
    async fn put(
        &self,
        vault: &LeaseVault,
        key: &str,
        base: u64,
        record: &Value,
    ) -> Result<Result<u64, (u64, Option<Value>)>, RunnerError> {
        let plain = serde_json::to_vec(record).map_err(|_| RunnerError::Unreachable)?;
        let sealed = vault.crypto.seal(key, &plain);
        match vault.vault.put(key, base, &sealed).await.map_err(|e| unreachable(&e))? {
            PutOutcome::Stored { seq } => Ok(Ok(seq)),
            PutOutcome::Conflict { entry } => Ok(Err((entry.seq, open(vault, &entry)))),
        }
    }

    /// Takes the lease `record` read at `seq`, when it is newer than the one known.
    fn take_lease(&self, routine_id: &str, seq: u64, record: &Value) -> bool {
        let (Some(holder), Some(epoch)) = (record["holder"].as_str(), record["epoch"].as_i64()) else { return false };
        let mut view = locked(&self.view);
        // The epoch never goes back: an older record put back in the vault
        // under a new sequence is stale. A lease known only here (seq 0)
        // yields to the vault's record.
        let newer = view.leases.get(routine_id).is_none_or(|known| {
            known.seq == 0 || seq == 0 || known.epoch < epoch || (known.epoch == epoch && known.seq < seq)
        });
        if newer {
            let (from, to) = (view.leases.get(routine_id).map(|l| l.epoch), epoch);
            if from.is_some_and(|from| from != to) {
                tracing::info!(routine_id, from, to, "runner: a routine's lease changed");
            }
            view.leases.insert(routine_id.to_owned(), Lease { holder: holder.to_owned(), epoch, seq });
        }
        newer
    }

    fn take_device(&self, seq: u64, record: &Value) -> Vec<String> {
        let Some(id) = record["device"].as_str() else { return Vec::new() };
        let mut view = locked(&self.view);
        if view.devices.get(id).is_some_and(|known| known.seq >= seq && known.seq > 0) {
            return Vec::new();
        }
        let holds: HashMap<String, (i64, Value, Value)> = record["holds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|held| {
                let routine = held["routine"].as_str()?.to_owned();
                Some((routine, (held["epoch"].as_i64()?, held["watermarks"].clone(), held["hourly"].clone())))
            })
            .collect();
        let routines = holds.keys().cloned().collect();
        let device = Device {
            name: record["name"].as_str().unwrap_or_default().to_owned(),
            seen_at: record["seenAt"].as_i64().unwrap_or_default(),
            seq,
            holds,
        };
        view.devices.insert(id.to_owned(), device);
        routines
    }

    /// The routine's row of `signal_runners` as the view has it now.
    fn row(&self, routine_id: &str) -> Option<StoredSignalRunner> {
        let view = locked(&self.view);
        let lease = view.leases.get(routine_id)?;
        let report = view.devices.get(&lease.holder).filter(|_| lease.holder != self.device_id).map(|device| {
            let (_, watermarks, hourly) = device.holds.get(routine_id).cloned().unwrap_or_default();
            json!({"name": device.name, "seenAt": device.seen_at, "watermarks": watermarks, "hourly": hourly})
        });
        Some(StoredSignalRunner {
            routine_id: routine_id.to_owned(),
            holder_device: lease.holder.clone(),
            epoch: lease.epoch,
            seen_seq: i64::try_from(lease.seq).unwrap_or(i64::MAX),
            seen_at: self.clock.now_ms(),
            handoff_json: report.map(|report| report.to_string()),
        })
    }

    async fn mirror(&self, routine_id: &str) {
        let Some(row) = self.row(routine_id) else { return };
        let written = self
            .store
            .write(move |tx, _| {
                // Two mirror writes may land out of order: an older epoch never replaces a newer.
                let older = tx.signal_runners().find(&row.routine_id)?.is_some_and(|known| known.epoch > row.epoch);
                if older { Ok(()) } else { tx.signal_runners().put(&row) }
            })
            .await;
        if let Err(error) = written {
            tracing::warn!(routine_id, error = %error, "runner: a lease could not be kept");
        }
    }

    fn spawn_mirror(self: &Arc<Self>, routine_id: String) {
        let runner = self.clone();
        tokio::spawn(async move { runner.mirror(&routine_id).await });
    }

    /// Writes to the vault the leases taken while it was not open.
    async fn push_pending(&self) {
        let (vault, pending) = {
            let view = locked(&self.view);
            let Some(vault) = view.vault.clone() else { return };
            let pending: Vec<(String, i64)> = view
                .leases
                .iter()
                .filter(|(_, lease)| lease.seq == 0 && lease.holder == self.device_id)
                .map(|(routine, lease)| (routine.clone(), lease.epoch))
                .collect();
            (vault, pending)
        };
        for (routine_id, epoch) in pending {
            let key = vault.crypto.record_key(LEASE, &routine_id);
            match self.put(&vault, &key, 0, &self.lease_record(&routine_id, epoch)).await {
                Ok(Ok(seq)) => {
                    self.take_lease(&routine_id, seq, &self.lease_record(&routine_id, epoch));
                }
                Ok(Err((seq, Some(theirs)))) => {
                    self.take_lease(&routine_id, seq, &theirs);
                }
                Ok(Err((_, None))) | Err(_) => continue,
            }
            self.mirror(&routine_id).await;
        }
    }

    fn vault(&self) -> Option<LeaseVault> {
        locked(&self.view).vault.clone()
    }
}

/// The record a vault entry holds, when it opens under its key.
fn open(vault: &LeaseVault, entry: &VaultEntry) -> Option<Value> {
    let plain = vault.crypto.open(&entry.key, &entry.data).ok()?;
    serde_json::from_slice::<Value>(&plain).ok().filter(|record| record.get(LEASE).is_some())
}

/// Hands the sink a runner shared by both sides.
#[derive(Debug, Clone)]
pub struct LeaseSinkOf(pub Arc<VaultRunner>);

impl LeaseSink for LeaseSinkOf {
    fn attach(&self, vault: Option<LeaseVault>) {
        let mut view = locked(&self.0.view);
        if vault.is_none() {
            view.confirmed_at = None;
        }
        view.vault = vault;
    }

    fn received(&self, key: &str, seq: u64, record: &Value) {
        let Some(vault) = self.0.vault() else { return };
        if let Some(routine) = record["routine"].as_str() {
            // The key binds the record to its routine: a blob moved between records is skipped.
            if vault.crypto.record_key(LEASE, routine) == key && self.0.take_lease(routine, seq, record) {
                self.0.spawn_mirror(routine.to_owned());
            }
        } else if let Some(device) = record["device"].as_str()
            && vault.crypto.record_key(DEVICE, device) == key
        {
            for routine in self.0.take_device(seq, record) {
                self.0.spawn_mirror(routine);
            }
        }
    }

    fn pulled(&self) {
        locked(&self.0.view).confirmed_at = Some(self.0.clock.now_ms());
        let runner = self.0.clone();
        tokio::spawn(async move { runner.push_pending().await });
    }
}

impl Runner for VaultRunner {
    fn device_id(&self) -> &str {
        &self.device_id
    }

    fn holder(&self, routine_id: &str) -> Holder {
        let view = locked(&self.view);
        match view.leases.get(routine_id) {
            Some(lease) if lease.holder == self.device_id => Holder::Here { epoch: lease.epoch },
            Some(lease) => Holder::Elsewhere { device_id: lease.holder.clone(), epoch: lease.epoch },
            // A routine that came through sync waits for its lease.
            None if view.vault.is_some() => Holder::Unknown,
            None => Holder::Here { epoch: 0 },
        }
    }

    /// Takes the routine's first lease, unless another computer has one:
    /// written over nothing, so it never replaces a lease that exists.
    fn adopt<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<(), RunnerError>> {
        Box::pin(async move {
            if locked(&self.view).leases.get(routine_id).is_some_and(|lease| lease.epoch > 0) {
                return Ok(());
            }
            let record = self.lease_record(routine_id, 1);
            match self.vault() {
                None => {
                    self.take_lease(routine_id, 0, &record);
                }
                Some(vault) => {
                    let key = vault.crypto.record_key(LEASE, routine_id);
                    match self.put(&vault, &key, 0, &record).await? {
                        Ok(seq) => self.take_lease(routine_id, seq, &record),
                        Err((seq, Some(theirs))) => self.take_lease(routine_id, seq, &theirs),
                        Err((_, None)) => return Err(RunnerError::Unreachable),
                    };
                }
            }
            self.mirror(routine_id).await;
            Ok(())
        })
    }

    fn claim<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<Handoff, RunnerError>> {
        Box::pin(async move {
            let (known, watermarks) = {
                let view = locked(&self.view);
                let known = view.leases.get(routine_id).cloned();
                let watermarks = known.as_ref().and_then(|lease| {
                    let (epoch, watermarks, _) = view.devices.get(&lease.holder)?.holds.get(routine_id)?.clone();
                    (epoch == lease.epoch && !watermarks.is_null()).then_some(watermarks)
                });
                (known, watermarks)
            };
            let (base, epoch) = known.as_ref().map_or((0, 1), |lease| (lease.seq, lease.epoch + 1));
            let record = self.lease_record(routine_id, epoch);
            match self.vault() {
                None => {
                    self.take_lease(routine_id, base, &record);
                }
                Some(vault) => {
                    let key = vault.crypto.record_key(LEASE, routine_id);
                    match self.put(&vault, &key, base, &record).await? {
                        Ok(seq) => {
                            self.take_lease(routine_id, seq, &record);
                        }
                        Err((seq, Some(theirs))) => {
                            self.take_lease(routine_id, seq, &theirs);
                            self.mirror(routine_id).await;
                            let holder = theirs["holder"].as_str().unwrap_or_default().to_owned();
                            let epoch = theirs["epoch"].as_i64().unwrap_or_default();
                            tracing::info!(routine_id, epoch, "runner: another computer claimed the routine first");
                            return Err(RunnerError::Lost { holder, epoch });
                        }
                        Err((_, None)) => return Err(RunnerError::Unreachable),
                    }
                }
            }
            self.mirror(routine_id).await;
            Ok(Handoff { routine_id: routine_id.to_owned(), epoch, watermarks })
        })
    }

    fn report<'a>(&'a self, report: &'a DeviceReport) -> BoxFuture<'a, Result<(), RunnerError>> {
        Box::pin(async move {
            let Some(vault) = self.vault() else { return Err(RunnerError::Off) };
            let holds: Vec<Value> = report
                .holds
                .iter()
                .map(|held| {
                    json!({"routine": held.routine_id, "epoch": held.epoch, "watermarks": held.watermarks,
                           "hourly": held.counts})
                })
                .collect();
            let name = if report.name.is_empty() { (self.name)() } else { report.name.clone() };
            let record =
                json!({"lease": 1, "device": self.device_id, "name": name, "seenAt": report.seen_at, "holds": holds});
            let key = vault.crypto.record_key(DEVICE, &self.device_id);
            let mut base = locked(&self.view).devices.get(&self.device_id).map_or(0, |own| own.seq);
            // Only this computer writes its record: a conflict is a sequence it had not read yet.
            for _ in 0..2 {
                match self.put(&vault, &key, base, &record).await? {
                    Ok(seq) => {
                        locked(&self.view).devices.entry(self.device_id.clone()).or_default().seq = seq;
                        return Ok(());
                    }
                    Err((seq, _)) => base = seq,
                }
            }
            Err(RunnerError::Unreachable)
        })
    }

    fn devices(&self) -> Vec<DeviceSeen> {
        let view = locked(&self.view);
        let mut seen: Vec<DeviceSeen> = view
            .devices
            .iter()
            .filter(|(id, _)| **id != self.device_id)
            .map(|(id, device)| {
                let mut routines: Vec<String> =
                    view.leases.iter().filter(|(_, lease)| lease.holder == *id).map(|(r, _)| r.clone()).collect();
                routines.sort();
                DeviceSeen { device_id: id.clone(), name: device.name.clone(), seen_at: device.seen_at, routines }
            })
            .collect();
        seen.sort_by(|a, b| a.device_id.cmp(&b.device_id));
        seen
    }

    fn confirmed_at(&self) -> Option<i64> {
        locked(&self.view).confirmed_at
    }

    fn shared(&self) -> bool {
        locked(&self.view).vault.is_some()
    }

    fn hourly_elsewhere(&self, routine_id: &str) -> Option<(i64, Vec<i64>)> {
        let view = locked(&self.view);
        let lease = view.leases.get(routine_id).filter(|lease| lease.holder != self.device_id)?;
        let device = view.devices.get(&lease.holder)?;
        let (_, _, hourly) = device.holds.get(routine_id)?;
        Some((device.seen_at, hourly.as_array()?.iter().filter_map(Value::as_i64).collect()))
    }
}
