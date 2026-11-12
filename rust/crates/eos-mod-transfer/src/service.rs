//! This computer's file-transfer engine
//! (`manager/modules/transfer/TransferService.ts`): the Transfer tab and a
//! focused agent's `send_to_machine`. Owns the list: queue, one running
//! transfer per paired computer, pause / resume / cancel, conflict decisions,
//! persistence, the live `transfer:change` feed and the banner when one
//! finishes. The byte moving is [`run_transfer`] over two endpoints: this
//! computer's disk and a paired one's.
//!
//! Every transfer that is running, waiting or not saved yet is held in
//! memory and is the truth while it is there; one task writes changed records
//! to the database (the latest state of each, so a fast transfer never queues
//! writes) and lets a finished one go once it is saved.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use eos_contracts::stream::topics;
use eos_contracts::{
    AgentTransferRequest, FOCUSED_ROLE, HostView, LinkRoute, LinkState, LocalLit, MachineRef, ManifestItemType, Num,
    TransferChangeEvent, TransferConflict, TransferDecision, TransferDestinationResponse,
    TransferDestinationResponseReason, TransferId, TransferOrigin, TransferOriginKind, TransferRecord,
    TransferRecordDestReason, TransferRecordError, TransferRoot, TransferRoute, TransferStartRequest, TransferStatus,
};
use eos_core::agent::Refused;
use eos_core::net::machines::Machines;
use eos_core::net::transfer::TransferEndpoint;
use eos_core::store::Store;
use eos_core::transfer::AgentTransfers;
use eos_core::{BoxFuture, Clock, Error, Ids, Sleeper};
use eos_domain::text::js_trim;
use eos_domain::transfer::{
    MachineMatch, MachineName, TransferError, base_name, common_parent, format_bytes, join_path, match_machine,
};
use eos_runtime::bus::{Bus, Topic};
use indexmap::IndexMap;
use serde_json::json;
use tokio::sync::{Notify, watch};
use tokio::task::JoinHandle;

use crate::TRANSFER_CHANGE;
use crate::peer::PeerEndpoint;
use crate::run::{DEFAULT_OUTAGE_MS, RunDeps, RunEvents, RunInput, run_transfer};

const DEFAULT_FOLDER: &str = "Downloads/Eos";
const LIST_LIMIT: usize = 100;
/// The feed and the database follow progress at this pace; state changes go at once.
const PUBLISH_EVERY_MS: i64 = 250;
const SAVE_EVERY_MS: i64 = 2_000;
/// How long shutdown waits for the runs to note that they stopped.
const STOP_WAIT: std::time::Duration = std::time::Duration::from_secs(2);

const NOTIFICATION_FIRE: Topic<serde_json::Value> = Topic::new(topics::NOTIFICATION_FIRE);

fn is_active(status: TransferStatus) -> bool {
    use TransferStatus::{Committing, Conflict, Copying, Queued, Scanning};
    matches!(status, Queued | Scanning | Copying | Conflict | Committing)
}

fn is_finished(status: TransferStatus) -> bool {
    matches!(status, TransferStatus::Done | TransferStatus::Failed | TransferStatus::Cancelled)
}

fn is_resumable(status: TransferStatus) -> bool {
    matches!(status, TransferStatus::Paused | TransferStatus::Interrupted | TransferStatus::Failed)
}

/// Why a transfer did not start, or an agent may not see one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentTransferError {
    /// Only a focused session, asking for itself, may send files.
    NotFocused,
    /// The transfer was started by someone else.
    NotYours,
    /// The request is wrong, or names a computer that cannot take it.
    Refused(Error),
    /// An endpoint refused or failed.
    Transfer(TransferError),
}

impl std::fmt::Display for AgentTransferError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFocused => f.write_str("only a focused session can send files to another Mac"),
            Self::NotYours => f.write_str("not one of your transfers"),
            Self::Refused(e) => e.fmt(f),
            Self::Transfer(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for AgentTransferError {}

impl From<Error> for AgentTransferError {
    fn from(e: Error) -> Self {
        Self::Refused(e)
    }
}

impl From<TransferError> for AgentTransferError {
    fn from(e: TransferError) -> Self {
        Self::Transfer(e)
    }
}

impl AgentTransferError {
    /// The status the worker's transfer routes answer this with.
    pub fn status(&self) -> u16 {
        match self {
            Self::NotFocused => 403,
            Self::NotYours => 404,
            Self::Refused(e) => eos_runtime::http::ApiError::from(e.clone()).status(),
            Self::Transfer(e) => e.status(),
        }
    }
}

/// Why a run was told to stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stop {
    Pause,
    Cancel,
    Shutdown,
}

/// The paired computer of a side, `None` for this one.
fn host_of(machine: &MachineRef) -> Option<&str> {
    match machine {
        MachineRef::Local(_) => None,
        MachineRef::Text(id) => Some(id),
    }
}

/// The paired computer a transfer runs with ("" when both sides are this one).
fn remote_of(t: &TransferRecord) -> &str {
    host_of(&t.from).or(host_of(&t.to)).unwrap_or("")
}

fn label(host: &HostView) -> &str {
    host.alias.as_deref().filter(|alias| !alias.is_empty()).unwrap_or(&host.name)
}

fn names(t: &TransferRecord) -> String {
    match t.roots.as_slice() {
        [] => String::new(),
        [one] => one.name.clone(),
        [one, two] => format!("{}, {}", one.name, two.name),
        [first, rest @ ..] => format!("{} and {} more", first.name, rest.len()),
    }
}

fn link_state(state: LinkState) -> &'static str {
    match state {
        LinkState::Connecting => "connecting",
        LinkState::Live => "live",
        LinkState::Reconnecting => "reconnecting",
        LinkState::Offline => "offline",
        LinkState::Unauthorized => "unauthorized",
        LinkState::Incompatible => "incompatible",
    }
}

pub struct TransferServiceDeps {
    pub store: Arc<dyn Store>,
    /// This computer's disk.
    pub local: Arc<dyn TransferEndpoint>,
    pub machines: Arc<dyn Machines>,
    pub bus: Bus,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn Ids>,
    pub sleeper: Arc<dyn Sleeper>,
}

impl std::fmt::Debug for TransferServiceDeps {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TransferServiceDeps").finish_non_exhaustive()
    }
}

/// A transfer held in memory.
struct Live {
    record: TransferRecord,
    /// Changed since it was last written to the database.
    dirty: bool,
    last_publish: i64,
    last_save: i64,
    /// Present while a run moves its bytes.
    stop: Option<watch::Sender<Option<Stop>>>,
    /// Rings when a conflict gets its decision.
    decided: Arc<Notify>,
}

#[derive(Default)]
struct State {
    live: IndexMap<String, Live>,
    /// Cleared transfers still to be deleted from the database.
    removals: Vec<String>,
    /// Counts the saves that let go of a record or finished a removal: a
    /// reader that read the database across one reads again, so it never
    /// pairs an older row with a newer memory.
    saves: u64,
}

pub struct TransferService {
    deps: TransferServiceDeps,
    state: Mutex<State>,
    /// Rings when a record is to be saved.
    save: Notify,
    /// Rings when a run ended.
    ended: Notify,
    /// One write to the database at a time.
    saving: tokio::sync::Mutex<()>,
    saver: Mutex<Option<JoinHandle<()>>>,
    this: Weak<TransferService>,
}

impl std::fmt::Debug for TransferService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TransferService").finish_non_exhaustive()
    }
}

/// What a run reports, applied to its transfer's record.
struct Reporter {
    service: Arc<TransferService>,
    id: String,
}

impl RunEvents for Reporter {
    fn scanned(&self, manifest: &eos_contracts::TransferManifest) {
        self.service.change(&self.id, false, |t| {
            t.roots = manifest.roots.clone();
            t.file_count = manifest.file_count;
            t.total_bytes = manifest.total_bytes;
            t.status = TransferStatus::Copying;
        });
    }

    fn prepared(&self, conflicts: &[TransferConflict], done_bytes: u64) {
        self.service.change(&self.id, false, |t| {
            let named = |name: &String| conflicts.iter().any(|c| &c.name == name);
            let mut decisions: IndexMap<String, TransferDecision> = IndexMap::new();
            // An agent never replaces anything: whatever is there stays, side by side.
            if t.origin.kind == TransferOriginKind::Agent {
                decisions.extend(conflicts.iter().map(|c| (c.name.clone(), TransferDecision::Keep)));
            }
            decisions.extend(t.decisions.iter().filter(|(name, _)| named(name)).map(|(n, d)| (n.clone(), *d)));
            t.conflicts = conflicts.to_vec();
            t.done_bytes = i64::try_from(done_bytes).unwrap_or(i64::MAX);
            t.decisions = decisions;
        });
    }

    fn progress(&self, done_bytes: u64, rate: f64) {
        let route = self.service.route_of_id(&self.id);
        self.service.change(&self.id, true, |t| {
            t.done_bytes = i64::try_from(done_bytes).unwrap_or(i64::MAX);
            t.rate = Num(rate);
            t.route = route;
        });
    }

    fn decisions<'a>(&'a self, conflicts: &'a [TransferConflict]) -> BoxFuture<'a, IndexMap<String, TransferDecision>> {
        Box::pin(async move {
            loop {
                let decided = {
                    let state = self.service.state();
                    let Some(live) = state.live.get(&self.id) else { return IndexMap::new() };
                    if conflicts.iter().all(|c| live.record.decisions.contains_key(&c.name)) {
                        return live.record.decisions.clone();
                    }
                    live.decided.clone()
                };
                // A decision made between the check and here left its permit.
                decided.notified().await;
            }
        })
    }

    fn copied(&self) {
        self.service.change(&self.id, false, |t| {
            if t.conflicts.iter().any(|c| !t.decisions.contains_key(&c.name)) {
                t.status = TransferStatus::Conflict;
                t.rate = Num(0.0);
            }
        });
    }

    fn committing(&self) {
        self.service.change(&self.id, false, |t| {
            t.status = TransferStatus::Committing;
            t.rate = Num(0.0);
        });
    }
}

impl TransferService {
    pub fn new(deps: TransferServiceDeps) -> Arc<Self> {
        Arc::new_cyclic(|this| Self {
            deps,
            state: Mutex::default(),
            save: Notify::new(),
            ended: Notify::new(),
            saving: tokio::sync::Mutex::new(()),
            saver: Mutex::new(None),
            this: this.clone(),
        })
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A transfer that was running when the app stopped can be resumed, not
    /// continued. Then starts the task that saves changed records.
    pub async fn start(&self) -> Result<(), Error> {
        self.deps
            .store
            .write(|tx, _| {
                for mut t in tx.transfers().list(LIST_LIMIT as i64)? {
                    if is_active(t.status) {
                        t.status = TransferStatus::Interrupted;
                        t.rate = Num(0.0);
                        tx.transfers().save(&t)?;
                    }
                }
                Ok(())
            })
            .await?;
        if let Some(service) = self.this.upgrade() {
            let saver = tokio::spawn(async move {
                loop {
                    service.save.notified().await;
                    service.flush().await;
                }
            });
            *self.saver.lock().unwrap_or_else(PoisonError::into_inner) = Some(saver);
        }
        Ok(())
    }

    /// Stops every run (each becomes "interrupted") and saves what is left.
    pub async fn stop(&self) {
        for live in self.state().live.values() {
            if let Some(stop) = &live.stop {
                let _ = stop.send(Some(Stop::Shutdown));
            }
        }
        // Each run notes its end on its own task.
        let ended = async {
            while self.state().live.values().any(|live| live.stop.is_some()) {
                self.ended.notified().await;
            }
        };
        if tokio::time::timeout(STOP_WAIT, ended).await.is_err() {
            tracing::warn!("a transfer did not stop in time; it is marked interrupted at the next start");
        }
        self.flush().await;
        if let Some(saver) = self.saver.lock().unwrap_or_else(PoisonError::into_inner).take() {
            saver.abort();
        }
    }

    /// Writes every changed record and pending removal, then lets go of the
    /// finished transfers that are now saved.
    async fn flush(&self) {
        let _one_at_a_time = self.saving.lock().await;
        let now = self.deps.clock.now_ms();
        let (records, removals) = {
            let mut state = self.state();
            let removals = state.removals.clone();
            let mut records = Vec::new();
            for live in state.live.values_mut().filter(|live| live.dirty) {
                live.dirty = false;
                live.last_save = now;
                records.push(live.record.clone());
            }
            (records, removals)
        };
        if records.is_empty() && removals.is_empty() {
            return;
        }
        let saved: Vec<String> = records.iter().map(|t| t.id.0.clone()).collect();
        let removed = removals.clone();
        let written = self
            .deps
            .store
            .write(move |tx, _| {
                for record in &records {
                    tx.transfers().save(record)?;
                }
                tx.transfers().remove(&removals)
            })
            .await;
        let mut state = self.state();
        match written {
            Ok(()) => {
                state.saves += 1;
                state.removals.retain(|id| !removed.contains(id));
                state.live.retain(|id, live| {
                    live.dirty || live.stop.is_some() || is_active(live.record.status) || !saved.contains(id)
                });
            }
            Err(e) => {
                tracing::warn!(error = %e, "transfers were not saved; they stay in memory");
                for id in &saved {
                    if let Some(live) = state.live.get_mut(id) {
                        live.dirty = true;
                    }
                }
            }
        }
    }

    /// The database rows, read while no save went by, with the state as it
    /// stood right after.
    async fn read_with_state<T: Send + 'static, R>(
        &self,
        read: impl Fn(&dyn eos_core::store::Tx) -> Result<T, Error> + Send + Sync + Clone + 'static,
        merge: impl Fn(T, &State) -> R,
    ) -> Result<R, Error> {
        loop {
            let before = self.state().saves;
            let rows = self.deps.store.read(read.clone()).await?;
            let state = self.state();
            if state.saves == before {
                return Ok(merge(rows, &state));
            }
        }
    }

    pub async fn list(&self) -> Result<Vec<TransferRecord>, Error> {
        let merge = |mut rows: Vec<TransferRecord>, state: &State| {
            // Cleared, and about to leave the database.
            rows.retain(|row| !state.removals.contains(&row.id.0));
            for row in &mut rows {
                if let Some(live) = state.live.get(&row.id.0) {
                    *row = live.record.clone();
                }
            }
            // Started a moment ago and not saved yet.
            let unsaved: Vec<TransferRecord> = state
                .live
                .values()
                .filter(|live| !rows.iter().any(|row| row.id == live.record.id))
                .map(|live| live.record.clone())
                .collect();
            rows.extend(unsaved);
            rows.sort_by(|a, b| b.created_at.as_f64().total_cmp(&a.created_at.as_f64()));
            rows.truncate(LIST_LIMIT);
            rows
        };
        self.read_with_state(|tx| tx.transfers().list(LIST_LIMIT as i64), merge).await
    }

    pub async fn get(&self, id: &str) -> Result<TransferRecord, Error> {
        let wanted = id.to_owned();
        let merge = |stored: Option<TransferRecord>, state: &State| match state.live.get(id) {
            Some(live) => Some(live.record.clone()),
            None => stored.filter(|_| !state.removals.iter().any(|removed| removed == id)),
        };
        let found = self.read_with_state(move |tx| tx.transfers().get(&wanted), merge).await?;
        found.ok_or_else(|| Error::not_found("transfer", id))
    }

    fn endpoint(&self, machine: &MachineRef) -> Arc<dyn TransferEndpoint> {
        match host_of(machine) {
            None => self.deps.local.clone(),
            Some(host) => Arc::new(PeerEndpoint::new(self.deps.machines.clone(), host)),
        }
    }

    fn machine_label(&self, machine: &str) -> String {
        if machine.is_empty() {
            return self.deps.machines.local_name();
        }
        self.deps.machines.get(machine).map_or_else(|| "the other Mac".to_owned(), |host| label(&host).to_owned())
    }

    fn route_of(&self, t: &TransferRecord) -> Option<TransferRoute> {
        let remote = remote_of(t);
        if remote.is_empty() {
            return Some(TransferRoute::Local);
        }
        self.deps.machines.get(remote)?.link.route.map(|route| match route {
            LinkRoute::Direct => TransferRoute::Direct,
            LinkRoute::Relay => TransferRoute::Relay,
            LinkRoute::Reverse => TransferRoute::Reverse,
        })
    }

    fn route_of_id(&self, id: &str) -> Option<TransferRoute> {
        let record = self.state().live.get(id).map(|live| live.record.clone())?;
        self.route_of(&record)
    }

    /// Where the picked items land when the user does not choose: the same
    /// project on the other computer (by git remote, keeping the sub-folder),
    /// else `~/Downloads/Eos` there.
    pub async fn destination(
        &self,
        from: &MachineRef,
        to: &MachineRef,
        paths: &[String],
    ) -> Result<TransferDestinationResponse, TransferError> {
        let (source, dest) = (self.endpoint(from), self.endpoint(to));
        let key = source.project_key(&common_parent(paths)).await.ok().flatten();
        let found = match key {
            Some(key) => dest.locate(&key).await.ok().flatten(),
            None => None,
        };
        Ok(match found {
            Some(dest_dir) => {
                TransferDestinationResponse { dest_dir, reason: TransferDestinationResponseReason::Project }
            }
            None => TransferDestinationResponse {
                dest_dir: join_path(&dest.home().await?, DEFAULT_FOLDER),
                reason: TransferDestinationResponseReason::Default,
            },
        })
    }

    fn check_pair(&self, from: &MachineRef, to: &MachineRef) -> Result<(), Error> {
        if from == to {
            return Err(Error::Validation("pick two different computers".into()));
        }
        // This computer is one side: two paired ones would relay every byte through it.
        if host_of(from).is_some() && host_of(to).is_some() {
            return Err(Error::Validation("one side of a transfer must be this Mac".into()));
        }
        for host in [from, to].into_iter().filter_map(host_of) {
            if self.deps.machines.get(host).is_none() {
                return Err(Error::Validation("that computer isn't paired with this Mac".into()));
            }
        }
        Ok(())
    }

    pub async fn start_transfer(
        &self,
        request: TransferStartRequest,
        origin: TransferOrigin,
    ) -> Result<TransferRecord, AgentTransferError> {
        self.check_pair(&request.from, &request.to)?;
        let (dest_dir, dest_reason) = match request.dest_dir.flatten() {
            Some(chosen) => (chosen, TransferRecordDestReason::Chosen),
            None => {
                let found = self.destination(&request.from, &request.to, &request.paths).await?;
                let reason = match found.reason {
                    TransferDestinationResponseReason::Project => TransferRecordDestReason::Project,
                    TransferDestinationResponseReason::Default => TransferRecordDestReason::Default,
                };
                (found.dest_dir, reason)
            }
        };
        let now = self.deps.clock.now_ms();
        let roots = request
            .paths
            .iter()
            .map(|path| TransferRoot {
                name: base_name(path).to_owned(),
                r#type: ManifestItemType::File,
                size: 0,
                mtime_ms: Num(0.0),
            })
            .collect();
        let record = TransferRecord {
            id: TransferId(self.deps.ids.transfer_id()),
            from: request.from,
            to: request.to,
            origin,
            sources: request.paths,
            dest_dir,
            dest_reason,
            status: TransferStatus::Queued,
            error: None,
            roots,
            file_count: 0,
            total_bytes: 0,
            done_bytes: 0,
            rate: Num(0.0),
            route: None,
            conflicts: Vec::new(),
            decisions: IndexMap::new(),
            placed: Vec::new(),
            created_at: Num(now as f64),
            started_at: None,
            finished_at: None,
        };
        self.hold(record.clone());
        self.change(&record.id.0, false, |_| {});
        self.schedule();
        Ok(record)
    }

    /// A focused agent's send: this computer → the named one's
    /// `~/Downloads/Eos`, never replacing anything there. Where bytes land is
    /// never the agent's choice.
    pub(crate) async fn send_for_agent(
        &self,
        agent_id: &str,
        agent_name: &str,
        cwd: Option<&str>,
        request: AgentTransferRequest,
    ) -> Result<TransferRecord, AgentTransferError> {
        let hosts = self.deps.machines.list();
        let listing = if hosts.is_empty() {
            "This Mac isn't paired with any other Mac.".to_owned()
        } else {
            let shown: Vec<String> = hosts
                .iter()
                .map(|h| {
                    let state = if h.link.state == LinkState::Live { "online" } else { link_state(h.link.state) };
                    format!("{} ({state})", label(h))
                })
                .collect();
            format!("Paired Macs: {}.", shown.join(", "))
        };
        let known: Vec<MachineName> = hosts
            .iter()
            .map(|h| MachineName {
                id: h.id.0.clone(),
                names: h.alias.iter().chain(std::iter::once(&h.name)).filter(|n| !n.is_empty()).cloned().collect(),
            })
            .collect();
        let named = |id: &String| hosts.iter().find(|h| &h.id.0 == id).map_or("", label);
        let host = match match_machine(&request.machine, &known) {
            MachineMatch::None => {
                let message = format!("No paired Mac matches \"{}\". {listing}", request.machine);
                return Err(Error::Validation(message).into());
            }
            MachineMatch::Many(ids) => {
                let either: Vec<&str> = ids.iter().map(named).collect();
                let message = format!("\"{}\" could be {} — name one. {listing}", request.machine, either.join(" or "));
                return Err(Error::Validation(message).into());
            }
            MachineMatch::One(id) => hosts.iter().find(|h| h.id.0 == id).ok_or_else(|| Error::not_found("host", id))?,
        };
        if matches!(host.link.state, LinkState::Offline | LinkState::Unauthorized | LinkState::Incompatible) {
            let state = link_state(host.link.state);
            let message = format!("{} isn't reachable right now ({state}). {listing}", label(host));
            return Err(Error::Validation(message).into());
        }
        let mut paths = Vec::with_capacity(request.paths.len());
        for path in request.paths {
            let absolute = match (path.starts_with('/'), cwd) {
                (true, _) => path,
                (false, Some(cwd)) => resolve(cwd, &path),
                (false, None) => path,
            };
            if !absolute.starts_with('/') {
                let message = format!(
                    "\"{absolute}\" isn't an absolute path, and this session has no folder to resolve it against"
                );
                return Err(Error::Validation(message).into());
            }
            paths.push(absolute);
        }
        let to = MachineRef::Text(host.id.0.clone());
        let dest_dir = join_path(&self.endpoint(&to).home().await?, DEFAULT_FOLDER);
        let start =
            TransferStartRequest { from: MachineRef::Local(LocalLit), to, paths, dest_dir: Some(Some(dest_dir)) };
        let origin = TransferOrigin {
            kind: TransferOriginKind::Agent,
            agent_id: Some(agent_id.to_owned()),
            agent_name: Some(agent_name.to_owned()),
        };
        self.start_transfer(start, origin).await
    }

    pub async fn pause(&self, id: &str) -> Result<TransferRecord, Error> {
        let t = self.get(id).await?;
        if t.status == TransferStatus::Queued {
            self.hold(t);
            self.change(id, false, |t| t.status = TransferStatus::Paused);
        } else {
            self.tell(id, Stop::Pause);
        }
        self.get(id).await
    }

    pub async fn resume(&self, id: &str) -> Result<TransferRecord, Error> {
        let t = self.get(id).await?;
        if !is_resumable(t.status) {
            return Ok(t);
        }
        self.hold(t);
        self.change(id, false, |t| {
            t.status = TransferStatus::Queued;
            t.error = None;
            t.finished_at = None;
        });
        self.schedule();
        self.get(id).await
    }

    pub async fn cancel(&self, id: &str) -> Result<TransferRecord, Error> {
        let t = self.get(id).await?;
        if self.tell(id, Stop::Cancel) || (is_finished(t.status) && t.status != TransferStatus::Failed) {
            return self.get(id).await;
        }
        self.drop_staging(&t);
        self.hold(t);
        self.finish(id, |t| t.status = TransferStatus::Cancelled);
        self.get(id).await
    }

    pub async fn decide(
        &self,
        id: &str,
        decisions: IndexMap<String, TransferDecision>,
    ) -> Result<TransferRecord, Error> {
        let t = self.get(id).await?;
        self.hold(t);
        self.change(id, false, |t| {
            for (name, decision) in decisions {
                if t.conflicts.iter().any(|c| c.name == name) {
                    t.decisions.insert(name, decision);
                }
            }
        });
        if let Some(live) = self.state().live.get(id)
            && live.record.conflicts.iter().all(|c| live.record.decisions.contains_key(&c.name))
        {
            live.decided.notify_one();
        }
        self.get(id).await
    }

    pub async fn clear_finished(&self) -> Result<Vec<String>, Error> {
        let finished: Vec<String> =
            self.list().await?.into_iter().filter(|t| is_finished(t.status)).map(|t| t.id.0).collect();
        if finished.is_empty() {
            return Ok(finished);
        }
        {
            let mut state = self.state();
            state.live.retain(|id, _| !finished.contains(id));
            state.removals.extend(finished.iter().cloned());
            let change = TransferChangeEvent { transfer: None, removed: Some(finished.clone()) };
            self.deps.bus.publish(&TRANSFER_CHANGE, &change);
        }
        self.save.notify_one();
        Ok(finished)
    }

    /// Holds a record in memory so it can be changed; one already held stays.
    fn hold(&self, record: TransferRecord) {
        let mut state = self.state();
        if !state.live.contains_key(&record.id.0) {
            let live = Live {
                record,
                dirty: false,
                last_publish: 0,
                last_save: 0,
                stop: None,
                decided: Arc::new(Notify::new()),
            };
            state.live.insert(live.record.id.0.clone(), live);
        }
    }

    /// Changes a held record and announces it. Progress (`quiet`) is
    /// announced and saved at a pace; anything else at once. The event leaves
    /// under the state's lock, so changes are heard in the order they were made.
    fn change(&self, id: &str, quiet: bool, change: impl FnOnce(&mut TransferRecord)) {
        let now = self.deps.clock.now_ms();
        let mut state = self.state();
        let Some(live) = state.live.get_mut(id) else { return };
        change(&mut live.record);
        if !quiet || now - live.last_save >= SAVE_EVERY_MS {
            live.dirty = true;
            live.last_save = now;
            self.save.notify_one();
        }
        if !quiet || now - live.last_publish >= PUBLISH_EVERY_MS {
            live.last_publish = now;
            let change = TransferChangeEvent { transfer: Some(live.record.clone()), removed: None };
            self.deps.bus.publish(&TRANSFER_CHANGE, &change);
        }
    }

    fn finish(&self, id: &str, change: impl FnOnce(&mut TransferRecord)) {
        let now = self.deps.clock.now_ms();
        self.change(id, false, |t| {
            change(t);
            t.rate = Num(0.0);
            t.finished_at = Some(Num(now as f64));
        });
    }

    /// Tells a transfer's run to stop; false when it has none.
    fn tell(&self, id: &str, stop: Stop) -> bool {
        match self.state().live.get(id).and_then(|live| live.stop.as_ref()) {
            Some(running) => running.send(Some(stop)).is_ok(),
            None => false,
        }
    }

    /// Removes what a transfer staged at its destination, in the background.
    fn drop_staging(&self, t: &TransferRecord) {
        let (dest, id, dest_dir) = (self.endpoint(&t.to), t.id.0.clone(), t.dest_dir.clone());
        tokio::spawn(async move {
            let _ = dest.abort(&id, &dest_dir).await;
        });
    }

    fn banner(&self, t: &TransferRecord, title: &str, body: String) {
        let banner = json!({
            "title": title,
            "body": body,
            "workerId": t.origin.agent_id.as_deref().unwrap_or(""),
            "route": "transfers",
            "ts": self.deps.clock.now_ms(),
        });
        self.deps.bus.publish(&NOTIFICATION_FIRE, &banner);
    }

    /// One running transfer per paired computer; the rest wait their turn.
    fn schedule(&self) {
        let Some(service) = self.this.upgrade() else { return };
        let mut starting = Vec::new();
        {
            let mut state = self.state();
            let mut busy: Vec<String> =
                state.live.values().filter(|l| l.stop.is_some()).map(|l| remote_of(&l.record).to_owned()).collect();
            let mut queued: Vec<(f64, String, String)> = state
                .live
                .values()
                .filter(|l| l.stop.is_none() && l.record.status == TransferStatus::Queued)
                .map(|l| (l.record.created_at.as_f64(), l.record.id.0.clone(), remote_of(&l.record).to_owned()))
                .collect();
            queued.sort_by(|a, b| a.0.total_cmp(&b.0));
            for (_, id, remote) in queued {
                if busy.contains(&remote) {
                    continue;
                }
                busy.push(remote);
                let (stop, stopped) = watch::channel(None);
                if let Some(live) = state.live.get_mut(&id) {
                    live.stop = Some(stop);
                    starting.push((id, stopped));
                }
            }
        }
        for (id, stopped) in starting {
            tokio::spawn(service.clone().execute(id, stopped));
        }
    }

    async fn execute(self: Arc<Self>, id: String, mut stopped: watch::Receiver<Option<Stop>>) {
        let now = self.deps.clock.now_ms();
        let route = self.route_of_id(&id);
        self.change(&id, false, |t| {
            t.status = TransferStatus::Scanning;
            t.started_at = t.started_at.or(Some(Num(now as f64)));
            t.rate = Num(0.0);
            t.route = route;
        });
        let Some(t0) = self.state().live.get(&id).map(|live| live.record.clone()) else { return };
        let dest = self.endpoint(&t0.to);
        let routed = {
            let (service, id) = (self.clone(), id.clone());
            Arc::new(move || service.route_of_id(&id))
        };
        let deps = RunDeps {
            source: self.endpoint(&t0.from),
            dest,
            clock: self.deps.clock.clone(),
            sleeper: self.deps.sleeper.clone(),
            route: routed,
            events: Arc::new(Reporter { service: self.clone(), id: id.clone() }),
            outage_ms: DEFAULT_OUTAGE_MS,
        };
        let input = RunInput { id: id.clone(), sources: t0.sources.clone(), dest_dir: t0.dest_dir.clone() };
        let told = async {
            loop {
                if let Some(stop) = *stopped.borrow_and_update() {
                    return stop;
                }
                if stopped.changed().await.is_err() {
                    return Stop::Shutdown;
                }
            }
        };
        let outcome = tokio::select! {
            biased;
            stop = told => Err(stop),
            result = run_transfer(deps, input) => Ok(result),
        };
        let record = |service: &Self| service.state().live.get(&id).map(|live| live.record.clone());
        match outcome {
            Ok(Ok(result)) => {
                self.finish(&id, |t| {
                    t.status = TransferStatus::Done;
                    t.placed = result.placed;
                    t.done_bytes = t.total_bytes;
                });
                if let Some(t) = record(&self) {
                    let size = format_bytes(u64::try_from(t.total_bytes).unwrap_or(0));
                    let to = self.machine_label(host_of(&t.to).unwrap_or(""));
                    self.banner(&t, &format!("Copied to {to}"), format!("{} · {size}", names(&t)));
                }
            }
            Ok(Err(e)) => {
                let error = TransferRecordError { code: e.code_name().to_owned(), message: e.message.clone() };
                if e.is_transient() {
                    self.change(&id, false, |t| {
                        t.status = TransferStatus::Interrupted;
                        t.rate = Num(0.0);
                        t.error = Some(error);
                    });
                    if let Some(t) = record(&self) {
                        let who = self.machine_label(remote_of(&t));
                        let body = format!("{who} went out of reach — resume it from the Transfer tab.");
                        self.banner(&t, "Transfer paused", body);
                    }
                } else {
                    // The staging goes; a retry starts over from a fresh scan.
                    self.drop_staging(&t0);
                    tracing::warn!(id, code = %error.code, error = %error.message, "transfer failed");
                    let message = error.message.clone();
                    self.finish(&id, |t| {
                        t.status = TransferStatus::Failed;
                        t.error = Some(error);
                    });
                    if let Some(t) = record(&self) {
                        self.banner(&t, "Transfer failed", format!("{}: {message}", names(&t)));
                    }
                }
            }
            Err(Stop::Pause) => self.change(&id, false, |t| {
                t.status = TransferStatus::Paused;
                t.rate = Num(0.0);
            }),
            Err(Stop::Shutdown) => self.change(&id, false, |t| {
                t.status = TransferStatus::Interrupted;
                t.rate = Num(0.0);
            }),
            Err(Stop::Cancel) => {
                self.drop_staging(&t0);
                self.finish(&id, |t| t.status = TransferStatus::Cancelled);
            }
        }
        if let Some(live) = self.state().live.get_mut(&id) {
            live.stop = None;
            live.dirty = true;
        }
        self.save.notify_one();
        self.ended.notify_one();
        self.schedule();
    }

    /// The focused agent `agent_id` names: its name and folder.
    pub(crate) async fn focused(&self, agent_id: &str) -> Result<(String, Option<String>), AgentTransferError> {
        let id = agent_id.to_owned();
        let worker = self.deps.store.read(move |tx| tx.workers().find(&id)).await?;
        match worker {
            Some(worker) if worker.agent_role.as_deref() == Some(FOCUSED_ROLE) => {
                Ok((worker.name.unwrap_or_else(|| agent_id.to_owned()), worker.worktree_dir.or(worker.cwd)))
            }
            _ => Err(AgentTransferError::NotFocused),
        }
    }
}

/// `path.resolve(cwd, path)`: `path` under `cwd`, with `.` and `..` applied.
fn resolve(cwd: &str, path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in cwd.split('/').chain(path.split('/')) {
        match part {
            "" | "." => {}
            ".." => drop(parts.pop()),
            part => parts.push(part),
        }
    }
    let joined = parts.join("/");
    if cwd.starts_with('/') { format!("/{joined}") } else { joined }
}

impl TransferService {
    /// A focused agent sends files of this computer to the paired one it names.
    pub async fn send(
        &self,
        agent_id: &str,
        request: AgentTransferRequest,
    ) -> Result<TransferRecord, AgentTransferError> {
        let (name, cwd) = self.focused(agent_id).await?;
        self.send_for_agent(agent_id, &name, cwd.as_deref(), request).await
    }

    /// One of the agent's own transfers, as it stands.
    pub async fn poll(&self, agent_id: &str, transfer_id: &str) -> Result<TransferRecord, AgentTransferError> {
        self.focused(agent_id).await?;
        let t = self.get(transfer_id).await?;
        if t.origin.agent_id.as_deref() == Some(agent_id) { Ok(t) } else { Err(AgentTransferError::NotYours) }
    }
}

fn refused(e: AgentTransferError) -> Refused {
    Refused::new(e.status(), e.to_string())
}

/// What the `send_to_machine` tool calls: the same answers as the worker's
/// transfer routes give the same agent.
impl AgentTransfers for TransferService {
    fn start<'a>(
        &'a self,
        worker_id: &'a str,
        machine: &'a str,
        paths: Vec<String>,
    ) -> BoxFuture<'a, Result<TransferRecord, Refused>> {
        Box::pin(async move {
            let request = AgentTransferRequest { machine: js_trim(machine).to_owned(), paths };
            if let Err(invalid) = eos_contracts::validate::check(&request) {
                return Err(Refused::new(400, invalid.to_string()));
            }
            self.send(worker_id, request).await.map_err(refused)
        })
    }

    fn get<'a>(&'a self, worker_id: &'a str, transfer_id: &'a str) -> BoxFuture<'a, Result<TransferRecord, Refused>> {
        Box::pin(async move { self.poll(worker_id, transfer_id).await.map_err(refused) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_relative_path_resolves_against_the_agents_folder() {
        assert_eq!(resolve("/work/app", "build/out.zip"), "/work/app/build/out.zip");
        assert_eq!(resolve("/work/app/", "../shared/./x"), "/work/shared/x");
        assert_eq!(resolve("/", "../x"), "/x");
        assert_eq!(resolve("relative", "x"), "relative/x");
    }
}
