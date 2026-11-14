use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use eos_contracts::{BoolLit, IntLit, Num, SyncDomainName, SyncEnvelope};
use eos_core::net::sync::{PutOutcome, SyncCrypto, SyncDomain, SyncStateStore, SyncVault, VaultEntry};
use eos_core::{Clock, Error};
use eos_domain::sync::{IndexEntry, LocalState, SyncItem, index_key, stable_stringify};
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
    stopped: AtomicBool,
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
            stopped: AtomicBool::new(false),
        }
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
            let state = lock(&self.state).clone();
            self.deps.state.save(&state)
        };
        exchanged.and(saved)
    }

    async fn exchange(&self, tally: &mut PassResult) -> Result<(), Error> {
        self.pull(tally).await?;
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

    async fn push_domain(&self, domain: &dyn SyncDomain, tally: &mut PassResult) -> Result<(), Error> {
        let name = domain_name(domain.name());
        let mut seen = std::collections::HashSet::new();
        for item in domain.list().await? {
            self.running()?;
            let key = index_key(name, &item.id);
            let changed = self.known(&key).and_then(|known| known.hash) != self.hash_of(Some(&item.data));
            seen.insert(key);
            if changed {
                let id = item.id.clone();
                self.send(domain, &id, Some(item), tally).await?;
            }
        }
        let prefix = format!("{name}/");
        let gone: Vec<String> = lock(&self.state)
            .index
            .iter()
            .filter(|(key, entry)| key.starts_with(&prefix) && !seen.contains(*key) && entry.hash.is_some())
            .map(|(key, _)| key[prefix.len()..].to_owned())
            .collect();
        for id in gone {
            self.running()?;
            self.send(domain, &id, None, tally).await?;
        }
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
        let read = || -> Result<SyncEnvelope, String> {
            let plain = self.deps.crypto.open(&entry.key, &entry.data).map_err(|e| e.to_string())?;
            let value: Value = serde_json::from_slice(&plain).map_err(|e| e.to_string())?;
            let envelope: SyncEnvelope = eos_contracts::validate::parse(&value).map_err(|e| e.to_string())?;
            // The key binds the blob to its record; a mismatch is a blob moved between records.
            if self.deps.crypto.record_key(domain_name(envelope.domain), &envelope.id) != entry.key {
                return Err("record key mismatch".into());
            }
            Ok(envelope)
        };
        match read() {
            Ok(envelope) => Some(envelope),
            Err(error) => {
                tracing::warn!(seq = entry.seq, error, "sync: skipped an unreadable record");
                None
            }
        }
    }
}
