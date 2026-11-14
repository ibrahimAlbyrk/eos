//! Every claude.ai Artifact of every Claude sign-in, kept in memory.
//!
//! [`Catalog::get`] answers from memory and re-reads in the background any
//! sign-in never read or read more than a minute ago; [`Catalog::refresh`]
//! re-reads now; [`Catalog::invalidate`] re-reads shortly after an agent
//! published (a burst is one read). One read per sign-in at a time. A failed
//! read keeps the sign-in's last list and says why on its account. Every
//! change of state runs on the ordered lane with its event, so `refreshing`
//! on the bus never goes back in time.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use eos_contracts::{ArtifactAccount, ArtifactCatalog, ArtifactSummary, ArtifactsChange};
use eos_core::accounts::PlanAccess;
use eos_core::net::ArtifactSource;
use eos_core::{Clock, Sleeper};
use eos_domain::accounts::PlanLoginRecord;
use eos_domain::time::iso_from_ms;
use eos_runtime::bus::{Bus, Topic};
use eos_runtime::ordered::Ordered;
use tokio::runtime::Handle;
use tokio::sync::watch;

use crate::rules::merge_artifacts;

pub const ARTIFACTS_CHANGE: Topic<ArtifactsChange> = Topic::new(eos_contracts::ARTIFACTS_TOPIC);

const PROVIDER: &str = "anthropic";
/// A sign-in read longer ago than this is read again on the next `get`.
pub const STALE_MS: i64 = 60_000;
/// How long an invalidation waits for the rest of its burst.
pub const DEBOUNCE_MS: i64 = 1_500;
const MAX_ERROR_CHARS: usize = 200;
const FALLBACK_ERROR: &str = "Couldn't read this account's artifacts.";

/// What the catalog reads and announces with.
pub struct Parts {
    pub source: Arc<dyn ArtifactSource>,
    /// The Claude sign-ins, asked on every use: one signed out drops out.
    pub access: Arc<dyn PlanAccess>,
    pub clock: Arc<dyn Clock>,
    pub sleeper: Arc<dyn Sleeper>,
    pub lane: Ordered,
    pub bus: Bus,
}

impl std::fmt::Debug for Parts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Parts").finish_non_exhaustive()
    }
}

#[derive(Debug, Default)]
struct LoginState {
    artifacts: Vec<ArtifactSummary>,
    refreshed_at: Option<i64>,
    /// When the last read ended, failed or not: what staleness counts from,
    /// so a failing sign-in is retried once a minute, not on every `get`.
    checked_at: Option<i64>,
    error: Option<String>,
}

/// What a scheduled invalidation re-reads.
#[derive(Debug)]
enum Pending {
    All,
    Logins(BTreeSet<String>),
}

#[derive(Debug, Default)]
struct State {
    logins: HashMap<String, LoginState>,
    /// The read in flight per sign-in; its value turns true when it ended.
    in_flight: HashMap<String, watch::Receiver<bool>>,
    /// Invalidated while a read was in flight: that read may have started
    /// before the publish, so another follows it.
    again: HashSet<String>,
    pending: Option<Pending>,
}

pub struct Catalog {
    parts: Parts,
    state: Mutex<State>,
    /// Where reads run; the first async call records it.
    tasks: OnceLock<Handle>,
}

impl std::fmt::Debug for Catalog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Catalog").finish_non_exhaustive()
    }
}

/// The lane stopped: the app is shutting down.
#[derive(Debug, thiserror::Error)]
#[error("the app is shutting down")]
pub struct Stopped;

/// White space folded, at most 200 UTF-16 units, as the dashboard has always
/// been given it.
fn short_error(message: &str) -> String {
    let folded = message.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut units = 0;
    let short: String = folded
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= MAX_ERROR_CHARS
        })
        .collect();
    if short.is_empty() { FALLBACK_ERROR.to_owned() } else { short }
}

impl Catalog {
    pub fn new(parts: Parts) -> Arc<Self> {
        Arc::new(Self { parts, state: Mutex::default(), tasks: OnceLock::new() })
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn logins(&self) -> Vec<PlanLoginRecord> {
        self.parts.access.logins(PROVIDER)
    }

    /// Records the runtime the caller runs on, for reads an agent's event
    /// starts off it.
    pub fn attach(&self) {
        let _ = self.tasks();
    }

    fn tasks(&self) -> Option<Handle> {
        if let Ok(current) = Handle::try_current() {
            return Some(self.tasks.get_or_init(|| current).clone());
        }
        self.tasks.get().cloned()
    }

    /// The catalog as it is; sign-ins never read or stale are re-read in the
    /// background.
    pub async fn get(self: &Arc<Self>) -> Result<ArtifactCatalog, Stopped> {
        let me = self.clone();
        let tasks = self.tasks();
        self.parts
            .lane
            .run(move || {
                let logins = me.logins();
                let now = me.parts.clock.now_ms();
                for login in &logins {
                    let stale = {
                        let state = me.state();
                        let checked = state.logins.get(&login.id).and_then(|s| s.checked_at);
                        !state.in_flight.contains_key(&login.id) && checked.is_none_or(|at| now - at >= STALE_MS)
                    };
                    if stale {
                        me.begin(&login.id, tasks.as_ref());
                    }
                }
                me.snapshot(&logins)
            })
            .await
            .map_err(|_| Stopped)
    }

    /// Re-reads every sign-in now; answers once those reads ended.
    pub async fn refresh(self: &Arc<Self>) -> Result<ArtifactCatalog, Stopped> {
        let me = self.clone();
        let tasks = self.tasks();
        let reads = self
            .parts
            .lane
            .run(move || me.logins().iter().filter_map(|l| me.begin(&l.id, tasks.as_ref())).collect::<Vec<_>>())
            .await
            .map_err(|_| Stopped)?;
        for mut read in reads {
            // A read whose task ended without a word ended all the same.
            let _ = read.wait_for(|ended| *ended).await;
        }
        let me = self.clone();
        self.parts.lane.run(move || me.snapshot(&me.logins())).await.map_err(|_| Stopped)
    }

    /// An agent published an artifact: re-read `login_id` (every sign-in when
    /// `None`) once the burst is over.
    pub fn invalidate(self: &Arc<Self>, login_id: Option<String>) {
        let me = self.clone();
        let Some(tasks) = self.tasks() else { return };
        let posted = self.parts.lane.post(move || {
            let mut state = me.state();
            let scheduled = state.pending.is_some();
            state.pending = Some(match (state.pending.take(), login_id) {
                (Some(Pending::All), _) | (_, None) => Pending::All,
                (Some(Pending::Logins(mut ids)), Some(id)) => {
                    ids.insert(id);
                    Pending::Logins(ids)
                }
                (None, Some(id)) => Pending::Logins(BTreeSet::from([id])),
            });
            drop(state);
            if !scheduled {
                let flush = me.clone();
                tasks.spawn(async move {
                    flush.parts.sleeper.sleep(DEBOUNCE_MS).await;
                    let lane = flush.parts.lane.clone();
                    let _ = lane.post(move || flush.flush());
                });
            }
        });
        if posted.is_err() {
            tracing::debug!("artifact invalidation dropped: the app is shutting down");
        }
    }

    fn flush(self: &Arc<Self>) {
        let ids: Vec<String> = {
            let mut state = self.state();
            let Some(pending) = state.pending.take() else { return };
            let known = self.logins().into_iter().map(|l| l.id);
            let ids: Vec<String> = match pending {
                Pending::All => known.collect(),
                Pending::Logins(wanted) => known.filter(|id| wanted.contains(id)).collect(),
            };
            ids.into_iter()
                .filter(|id| {
                    let busy = state.in_flight.contains_key(id);
                    if busy {
                        state.again.insert(id.clone());
                    }
                    !busy
                })
                .collect()
        };
        let tasks = self.tasks.get().cloned();
        for id in ids {
            self.begin(&id, tasks.as_ref());
        }
    }

    /// Joins the sign-in's read in flight or starts one. On the lane.
    fn begin(self: &Arc<Self>, login_id: &str, tasks: Option<&Handle>) -> Option<watch::Receiver<bool>> {
        let mut state = self.state();
        if let Some(read) = state.in_flight.get(login_id) {
            return Some(read.clone());
        }
        let flips = state.in_flight.is_empty();
        let read = self.start(&mut state, login_id, tasks?);
        drop(state);
        if flips {
            self.emit();
        }
        Some(read)
    }

    fn start(self: &Arc<Self>, state: &mut State, login_id: &str, tasks: &Handle) -> watch::Receiver<bool> {
        let (ended, read) = watch::channel(false);
        state.in_flight.insert(login_id.to_owned(), read.clone());
        let (me, id, runner) = (self.clone(), login_id.to_owned(), tasks.clone());
        tasks.spawn(async move {
            let source = me.parts.source.clone();
            let listed = {
                let id = id.clone();
                // Its own task: a source that panics fails this read, not the catalog.
                runner.spawn(async move { source.list(&id).await }).await
            };
            let result = listed.unwrap_or_else(|_| Err(FALLBACK_ERROR.to_owned()));
            let (lane, done) = (me.parts.lane.clone(), me.clone());
            let finished = lane.run(move || done.finish(&id, result, &runner)).await;
            if finished.is_err() {
                tracing::debug!("artifact read ended after the app stopped");
            }
            let _ = ended.send(true);
        });
        read
    }

    /// A read ended. On the lane.
    fn finish(self: &Arc<Self>, login_id: &str, result: Result<Vec<ArtifactSummary>, String>, tasks: &Handle) {
        let mut state = self.state();
        state.in_flight.remove(login_id);
        let known = self.logins().iter().any(|l| l.id == login_id);
        if known {
            let now = self.parts.clock.now_ms();
            let entry = state.logins.entry(login_id.to_owned()).or_default();
            match result {
                Ok(artifacts) => {
                    *entry = LoginState { artifacts, refreshed_at: Some(now), checked_at: Some(now), error: None }
                }
                Err(e) => {
                    entry.checked_at = Some(now);
                    entry.error = Some(short_error(&e));
                }
            }
        }
        if state.again.remove(login_id) && known {
            self.start(&mut state, login_id, tasks);
        }
        drop(state);
        self.emit();
    }

    fn emit(&self) {
        let refreshing = !self.state().in_flight.is_empty();
        self.parts.bus.publish(&ARTIFACTS_CHANGE, &ArtifactsChange { refreshing });
    }

    /// Drops what sign-ins that are gone left behind.
    fn snapshot(&self, logins: &[PlanLoginRecord]) -> ArtifactCatalog {
        let mut state = self.state();
        state.logins.retain(|id, _| logins.iter().any(|l| &l.id == id));
        let accounts = logins
            .iter()
            .map(|l| {
                let s = state.logins.get(&l.id);
                ArtifactAccount {
                    login_id: l.id.clone(),
                    label: l.label.clone(),
                    email: l.email.clone().filter(|e| !e.is_empty()),
                    count: s.map_or(0, |s| s.artifacts.len()).into(),
                    refreshed_at: s.and_then(|s| s.refreshed_at).map(iso_from_ms),
                    error: s.and_then(|s| s.error.clone()),
                }
            })
            .collect();
        let artifacts =
            merge_artifacts(logins.iter().map(|l| state.logins.get(&l.id).map_or(&[][..], |s| &s.artifacts[..])));
        ArtifactCatalog { artifacts, accounts, refreshing: !state.in_flight.is_empty() }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn an_error_is_folded_capped_and_never_empty() {
        assert_eq!(short_error("  Couldn't\n read\t (HTTP 500).  "), "Couldn't read (HTTP 500).");
        assert_eq!(short_error(" \n "), FALLBACK_ERROR);
        let long = "é".repeat(150) + &"😀".repeat(100);
        let short = short_error(&long);
        assert_eq!(short.encode_utf16().count(), 200);
        assert!(short.ends_with('😀'));
    }
}
