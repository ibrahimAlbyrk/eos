use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use eos_contracts::{BoolLit, IntLit, Num, SyncDomainName, SyncEnvelope};
use eos_core::net::sync::{LeaseSink, PutOutcome, SyncCrypto, SyncDomain, SyncStateStore, SyncVault, VaultEntry};
use eos_core::{Clock, Error};
use eos_domain::sync::{IndexEntry, LocalState, SyncItem, index_key, stable_stringify};

use crate::budget::{DomainUsage, SEAL_OVERHEAD};
use indexmap::IndexMap;
use serde_json::Value;
use tokio::sync::watch;

const MAX_PUSH_ATTEMPTS: usize = 3;

#[allow(missing_debug_implementations)]
pub struct SyncEngineDeps {
    pub vault: Arc<dyn SyncVault>,
    pub crypto: Arc<dyn SyncCrypto>,
    pub state: Arc<dyn SyncStateStore>,
    /// In push order.
    pub domains: Vec<Arc<dyn SyncDomain>>,
    pub clock: Arc<dyn Clock>,
    /// Stamped on what this computer pushes.
    pub device: String,
    /// The most sealed bytes a domain may keep in the vault
    /// ([`vault_budgets`](crate::vault_budgets)); a domain not named has none.
    pub budgets: Vec<(SyncDomainName, u64)>,
    /// Takes the records of who runs which routine; without one they are
    /// skipped as unreadable.
    pub leases: Option<Arc<dyn LeaseSink>>,
}

/// What a call to [`SyncEngine::sync`] did, over every round it ran.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PassResult {
    pub pulled: u64,
    pub pushed: u64,
    pub conflicts: u64,
}

type Shared = watch::Receiver<Option<Result<PassResult, Error>>>;

enum Boarding {
    Drive(watch::Sender<Option<Result<PassResult, Error>>>),
    Join(Shared),
}

pub struct SyncEngine {
    deps: SyncEngineDeps,
    /// Never held across an await.
    state: Mutex<LocalState>,
    /// The pass in flight, for callers that arrive while it runs.
    flight: Mutex<Option<Shared>>,
    again: AtomicBool,
    stopped: Arc<AtomicBool>,
    /// One state save at a time, in the order the passes made them; held until the
    /// save is done, also when the pass that started it was dropped meanwhile.
    saving: Arc<tokio::sync::Mutex<()>>,
    /// What the last save wrote: a pass that changed nothing writes nothing.
    saved: Arc<Mutex<Option<LocalState>>>,
    /// Per domain, as of its last push.
    usage: Mutex<IndexMap<&'static str, DomainUsage>>,
    /// Per domain, when its last push in this run began: the next reads
    /// only what changed since.
    listed: Mutex<std::collections::HashMap<&'static str, f64>>,
    /// The sealed bytes of every record seen in this run, by index key.
    sizes: Mutex<std::collections::HashMap<String, u64>>,
    /// Records to read again whether they changed or not: kept back for the
    /// budget, or merged with another computer's change.
    recheck: Mutex<std::collections::HashSet<String>>,
}

impl std::fmt::Debug for SyncEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SyncEngine").field("device", &self.deps.device).finish_non_exhaustive()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn domain_name(name: SyncDomainName) -> &'static str {
    match name {
        SyncDomainName::Profile => "profile",
        SyncDomainName::Avatar => "avatar",
        SyncDomainName::Memory => "memory",
        SyncDomainName::Page => "page",
        SyncDomainName::Template => "template",
        SyncDomainName::Worker => "worker",
        SyncDomainName::Experience => "experience",
        SyncDomainName::Routine => "routine",
        SyncDomainName::Run => "run",
        SyncDomainName::Surface => "surface",
        SyncDomainName::Capability => "capability",
    }
}

/// Clears the flight slot when the driving call ends, also when its future
/// is dropped half-way: waiting callers then see the pass as interrupted
/// instead of waiting forever.
struct Landing<'a>(&'a SyncEngine);

impl Drop for Landing<'_> {
    fn drop(&mut self) {
        *lock(&self.0.flight) = None;
    }
}

impl SyncEngine {
    pub fn new(deps: SyncEngineDeps) -> Self {
        let state = deps.state.load();
        Self {
            deps,
            state: Mutex::new(state),
            flight: Mutex::new(None),
            again: AtomicBool::new(false),
            stopped: Arc::new(AtomicBool::new(false)),
            saving: Arc::new(tokio::sync::Mutex::new(())),
            saved: Arc::default(),
            usage: Mutex::default(),
            listed: Mutex::default(),
            sizes: Mutex::default(),
            recheck: Mutex::default(),
        }
    }

    /// How full each domain is, in push order, as of the last pass.
    pub fn usage(&self) -> Vec<DomainUsage> {
        let usage = lock(&self.usage);
        self.deps
            .domains
            .iter()
            .map(|domain| {
                let name = domain_name(domain.name());
                usage.get(name).cloned().unwrap_or(DomainUsage {
                    name,
                    bytes: 0,
                    budget: self.budget_of(domain.name()),
                    full: false,
                })
            })
            .collect()
    }

    fn budget_of(&self, name: SyncDomainName) -> Option<u64> {
        self.deps.budgets.iter().find(|(domain, _)| *domain == name).map(|(_, bytes)| *bytes)
    }

    /// The bytes `item` takes in the vault once sealed.
    fn sealed_size(&self, name: SyncDomainName, item: &SyncItem) -> u64 {
        let envelope = SyncEnvelope {
            v: IntLit,
            domain: name,
            id: item.id.clone(),
            changed_at: Num(item.updated_at.unwrap_or_default()),
            device: self.deps.device.clone(),
            deleted: None,
            data: Some(item.data.clone()),
        };
        let plain = serde_json::to_vec(&envelope).map_or(0, |plain| plain.len() as u64);
        plain + SEAL_OVERHEAD
    }

    /// The last vault sequence number this computer has seen: where a wait
    /// for new writes starts.
    pub fn position(&self) -> u64 {
        lock(&self.state).cursor
    }

    /// Live records per domain, as of the last pass.
    pub fn counts(&self) -> IndexMap<String, i64> {
        let mut out: IndexMap<String, i64> =
            self.deps.domains.iter().map(|d| (domain_name(d.name()).to_owned(), 0)).collect();
        for (key, entry) in &lock(&self.state).index {
            let domain = key.split_once('/').map_or("", |(domain, _)| domain);
            if entry.hash.is_some()
                && let Some(count) = out.get_mut(domain)
            {
                *count += 1;
            }
        }
        out
    }

    /// Ends the engine: a pass in flight stops at its next record and saves
    /// nothing more. Used when this computer leaves the account.
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
    }

    /// One pass. Callers share the pass in flight; asking again during one
    /// runs one more round after it, so a change made mid-pass is never left
    /// behind.
    pub async fn sync(&self) -> Result<PassResult, Error> {
        match self.board() {
            Boarding::Drive(done) => self.drive(&done).await,
            Boarding::Join(mut running) => {
                let result = match running.wait_for(Option::is_some).await {
                    Ok(result) => result.clone(),
                    Err(_) => None,
                };
                result.unwrap_or_else(|| Err(Error::Conflict("the sync pass was interrupted".into())))
            }
        }
    }

    /// Joins the pass in flight (asking it for one more round) or becomes
    /// the caller that runs one.
    fn board(&self) -> Boarding {
        let mut flight = lock(&self.flight);
        if let Some(running) = flight.as_ref() {
            self.again.store(true, Ordering::SeqCst);
            return Boarding::Join(running.clone());
        }
        let (done, running) = watch::channel(None);
        *flight = Some(running);
        Boarding::Drive(done)
    }

    /// Whether another round is owed; when not, the flight ends here. Decided
    /// under the slot's lock: a caller either joined before this (and gets
    /// its round) or starts a pass of its own.
    fn lands(&self, round_ok: bool) -> bool {
        let mut flight = lock(&self.flight);
        if round_ok && self.again.load(Ordering::SeqCst) {
            return false;
        }
        *flight = None;
        true
    }

    async fn drive(&self, done: &watch::Sender<Option<Result<PassResult, Error>>>) -> Result<PassResult, Error> {
        let landing = Landing(self);
        let mut total = PassResult::default();
        let result = loop {
            self.again.store(false, Ordering::SeqCst);
            let round = self.pass(&mut total).await;
            if self.lands(round.is_ok()) {
                break round.map(|()| total);
            }
        };
        // The slot is clear already, and may hold a newer flight by now.
        std::mem::forget(landing);
        let _ = done.send(Some(result.clone()));
        result
    }

    async fn pass(&self, tally: &mut PassResult) -> Result<(), Error> {
        let exchanged = self.exchange(tally).await;
        // After leaving, the state file is gone on purpose.
        let saved = if self.stopped.load(Ordering::SeqCst) {
            Ok(())
        } else {
            let one = self.saving.clone().lock_owned().await;
            let state = lock(&self.state).clone();
            if lock(&self.saved).as_ref() == Some(&state) {
                Ok(())
            } else {
                let (store, stopped, saved) = (self.deps.state.clone(), self.stopped.clone(), self.saved.clone());
                // The file is flushed to the disk: a blocking thread's work.
                let save = move || {
                    let _one = one;
                    if stopped.load(Ordering::SeqCst) {
                        return Ok(());
                    }
                    store.save(&state)?;
                    *lock(&saved) = Some(state);
                    Ok(())
                };
                tokio::task::spawn_blocking(save).await.map_err(Error::storage).and_then(|saved| saved)
            }
        };
        exchanged.and(saved)
    }

    async fn exchange(&self, tally: &mut PassResult) -> Result<(), Error> {
        self.pull(tally).await?;
        if let Some(leases) = &self.deps.leases {
            leases.pulled();
        }
        for domain in &self.deps.domains {
            self.push_domain(domain.as_ref(), tally).await?;
        }
        Ok(())
    }

    fn running(&self) -> Result<(), Error> {
        if self.stopped.load(Ordering::SeqCst) { Err(Error::Conflict("sync stopped".into())) } else { Ok(()) }
    }

    fn known(&self, key: &str) -> Option<IndexEntry> {
        lock(&self.state).index.get(key).cloned()
    }

    fn index(&self, key: String, seq: u64, hash: Option<String>) {
        lock(&self.state).index.insert(key, IndexEntry { seq, hash });
    }

    /// This computer's own write got the very next sequence number: nothing
    /// else was written in between, so there is nothing to come back for.
    /// (Otherwise the wait for other computers' writes would wake at once on
    /// our own and cost a whole pass per local edit.)
    fn seen_own_write(&self, seq: u64) {
        let mut state = lock(&self.state);
        if seq == state.cursor + 1 {
            state.cursor = seq;
        }
    }

    fn hash_of(&self, data: Option<&Value>) -> Option<String> {
        data.map(|data| self.deps.crypto.hash(&stable_stringify(data)))
    }

    async fn pull(&self, tally: &mut PassResult) -> Result<(), Error> {
        loop {
            let page = self.deps.vault.changes(self.position(), 0).await?;
            let empty = page.entries.is_empty();
            for entry in page.entries {
                self.running()?;
                let seq = entry.seq;
                self.receive(entry, tally).await?;
                let mut state = lock(&self.state);
                state.cursor = state.cursor.max(seq);
            }
            if !page.more || empty {
                return Ok(());
            }
        }
    }

    /// The domain's records to look at in this pass, and the id of every
    /// record it holds. The first pass of a run lists the domain whole;
    /// later ones read only what changed where the domain can, and the
    /// records kept back or merged since.
    async fn records_of(
        &self,
        domain: &dyn SyncDomain,
        since: Option<f64>,
    ) -> Result<(Vec<SyncItem>, Vec<String>), Error> {
        let name = domain_name(domain.name());
        let Some(read) = since.and_then(|since| domain.changed_since(since)) else {
            let items = domain.list().await?;
            let ids = items.iter().map(|item| item.id.clone()).collect();
            return Ok((items, ids));
        };
        let changed = read.await?;
        let mut items = changed.items;
        let prefix = format!("{name}/");
        let again: Vec<String> = lock(&self.recheck)
            .iter()
            .filter_map(|key| key.strip_prefix(&prefix).map(str::to_owned))
            .filter(|id| !items.iter().any(|item| &item.id == id))
            .collect();
        for id in again {
            if let Some(item) = domain.get(&id).await? {
                items.push(item);
            }
        }
        Ok((items, changed.ids))
    }

    async fn push_domain(&self, domain: &dyn SyncDomain, tally: &mut PassResult) -> Result<(), Error> {
        let name = domain_name(domain.name());
        let budget = self.budget_of(domain.name());
        let started = self.deps.clock.now_ms() as f64;
        let since = lock(&self.listed).get(name).copied();
        let (items, ids) = self.records_of(domain, since).await?;
        let held: std::collections::HashSet<String> = ids.iter().map(|id| index_key(name, id)).collect();
        // What the vault holds of this domain already counts first; new
        // records go while they fit.
        let sized: Vec<(SyncItem, u64, bool)> = {
            let mut sizes = lock(&self.sizes);
            items
                .into_iter()
                .map(|item| {
                    let key = index_key(name, &item.id);
                    let size = self.sealed_size(domain.name(), &item);
                    sizes.insert(key.clone(), size);
                    let stored = self.known(&key).is_some_and(|known| known.hash.is_some());
                    (item, size, stored)
                })
                .collect()
        };
        let mut bytes: u64 = {
            let (sizes, state) = (lock(&self.sizes), lock(&self.state));
            held.iter()
                .filter(|key| state.index.get(*key).is_some_and(|entry| entry.hash.is_some()))
                .map(|key| sizes.get(key).copied().unwrap_or_default())
                .sum()
        };
        let mut full = false;
        for (item, size, stored) in sized {
            self.running()?;
            let key = index_key(name, &item.id);
            if !stored && budget.is_some_and(|budget| bytes + size > budget) {
                full = true;
                lock(&self.recheck).insert(key);
                continue;
            }
            lock(&self.recheck).remove(&key);
            let changed = self.known(&key).and_then(|known| known.hash) != self.hash_of(Some(&item.data));
            if !stored {
                bytes += size;
            }
            if changed {
                let id = item.id.clone();
                self.send(domain, &id, Some(item), tally).await?;
            }
        }
        if full {
            tracing::warn!(domain = name, bytes, budget, "sync: a domain reached its vault budget; new records wait");
        }
        lock(&self.usage).insert(name, DomainUsage { name, bytes, budget, full });
        let prefix = format!("{name}/");
        let gone: Vec<String> = lock(&self.state)
            .index
            .iter()
            .filter(|(key, entry)| key.starts_with(&prefix) && !held.contains(*key) && entry.hash.is_some())
            .map(|(key, _)| key[prefix.len()..].to_owned())
            .collect();
        for id in gone {
            self.running()?;
            self.send(domain, &id, None, tally).await?;
        }
        lock(&self.listed).insert(name, started);
        Ok(())
    }

    async fn send(
        &self,
        domain: &dyn SyncDomain,
        id: &str,
        item: Option<SyncItem>,
        tally: &mut PassResult,
    ) -> Result<(), Error> {
        let name = domain.name();
        let key = index_key(domain_name(name), id);
        let record_key = self.deps.crypto.record_key(domain_name(name), id);
        let mut current = item;
        for _ in 0..MAX_PUSH_ATTEMPTS {
            let now = self.deps.clock.now_ms() as f64;
            let envelope = SyncEnvelope {
                v: IntLit,
                domain: name,
                id: id.to_owned(),
                changed_at: Num(current.as_ref().and_then(|c| c.updated_at).unwrap_or(now)),
                device: self.deps.device.clone(),
                deleted: current.is_none().then_some(BoolLit),
                data: current.as_ref().map(|c| c.data.clone()),
            };
            let plain = serde_json::to_vec(&envelope).map_err(Error::storage)?;
            let sealed = self.deps.crypto.seal(&record_key, &plain);
            let base = self.known(&key).map_or(0, |known| known.seq);
            match self.deps.vault.put(&record_key, base, &sealed).await? {
                PutOutcome::Stored { seq } => {
                    self.index(key, seq, self.hash_of(current.as_ref().map(|c| &c.data)));
                    self.seen_own_write(seq);
                    tally.pushed += 1;
                    return Ok(());
                }
                PutOutcome::Conflict { entry } => {
                    let seq = entry.seq;
                    self.receive(entry, tally).await?;
                    // An unreadable blob leaves the index behind it: ours replaces it.
                    if self.known(&key).map_or(0, |known| known.seq) < seq {
                        self.index(key.clone(), seq, None);
                    }
                    current = domain.get(id).await?;
                    if self.known(&key).and_then(|known| known.hash) == self.hash_of(current.as_ref().map(|c| &c.data))
                    {
                        return Ok(());
                    }
                }
            }
        }
        tracing::warn!(domain = domain_name(name), id, "sync: record kept changing under us; retrying next pass");
        Ok(())
    }

    async fn receive(&self, entry: VaultEntry, tally: &mut PassResult) -> Result<(), Error> {
        let Some(envelope) = self.open(&entry) else { return Ok(()) };
        let name = domain_name(envelope.domain);
        let Some(domain) = self.deps.domains.iter().find(|d| d.name() == envelope.domain) else { return Ok(()) };
        let key = index_key(name, &envelope.id);
        let known = self.known(&key);
        if known.as_ref().is_some_and(|known| known.seq >= entry.seq) {
            return Ok(());
        }
        let deleted = envelope.deleted.is_some();
        // A record without `data` reads as `null`, as in the TypeScript.
        let remote = envelope.data.unwrap_or(Value::Null);

        let local = domain.get(&envelope.id).await?;
        let local_hash = self.hash_of(local.as_ref().map(|l| &l.data));
        let remote_hash = if deleted { None } else { self.hash_of(Some(&remote)) };
        if local_hash == remote_hash {
            self.index(key, entry.seq, local_hash);
            return Ok(());
        }
        let local_changed = match &known {
            Some(known) => local_hash != known.hash,
            None => local.is_some(),
        };
        if local_changed
            && !deleted
            && let Some(local) = &local
            && let Some(merged) = domain.merge(&local.data, &remote)
            && domain.apply(&envelope.id, &merged).await.is_ok()
        {
            // Both changed it: the merge went in here and goes out in this pass's push.
            self.index(key.clone(), entry.seq, remote_hash);
            lock(&self.recheck).insert(key);
            tally.pulled += 1;
            return Ok(());
        }
        if local_changed {
            tally.conflicts += 1;
            let local_at = match (&known, &local) {
                (None, _) => 0.0,
                (Some(_), Some(local)) => local.updated_at.unwrap_or(self.deps.clock.now_ms() as f64),
                (Some(_), None) => self.deps.clock.now_ms() as f64,
            };
            if envelope.changed_at.as_f64() < local_at {
                // Ours is newer: keep theirs aside and push ours over the seq we just saw.
                if !deleted {
                    self.deps.state.save_conflict(name, &envelope.id, &remote)?;
                }
                self.index(key, entry.seq, remote_hash);
                return Ok(());
            }
            if let Some(local) = &local {
                self.deps.state.save_conflict(name, &envelope.id, &local.data)?;
            }
        }

        let applied =
            if deleted { domain.remove(&envelope.id).await } else { domain.apply(&envelope.id, &remote).await };
        if let Err(e) = applied {
            tracing::warn!(domain = name, id = %envelope.id, error = %e, "sync: could not apply a record; kept as a conflict");
            if !deleted {
                self.deps.state.save_conflict(name, &envelope.id, &remote)?;
            }
            self.index(key, entry.seq, local_hash);
            return Ok(());
        }
        let now = domain.get(&envelope.id).await?;
        self.index(key, entry.seq, self.hash_of(now.as_ref().map(|n| &n.data)));
        tally.pulled += 1;
        Ok(())
    }

    fn open(&self, entry: &VaultEntry) -> Option<SyncEnvelope> {
        // `None` as well for a lease record: the sink has it.
        let read = || -> Result<Option<SyncEnvelope>, String> {
            let plain = self.deps.crypto.open(&entry.key, &entry.data).map_err(|e| e.to_string())?;
            let value: Value = serde_json::from_slice(&plain).map_err(|e| e.to_string())?;
            if let (Some(leases), Some(_)) = (&self.deps.leases, value.get("lease")) {
                leases.received(&entry.key, entry.seq, &value);
                return Ok(None);
            }
            let envelope: SyncEnvelope = eos_contracts::validate::parse(&value).map_err(|e| e.to_string())?;
            // The key binds the blob to its record; a mismatch is a blob moved between records.
            if self.deps.crypto.record_key(domain_name(envelope.domain), &envelope.id) != entry.key {
                return Err("record key mismatch".into());
            }
            Ok(Some(envelope))
        };
        match read() {
            Ok(envelope) => envelope,
            Err(error) => {
                tracing::warn!(seq = entry.seq, error, "sync: skipped an unreadable record");
                None
            }
        }
    }
}
