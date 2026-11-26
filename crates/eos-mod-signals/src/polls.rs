//! The poll driver (02 §3 E.24–28): each capability source a routine held
//! here reads is polled on its own clock, beside the scheduler.
//!
//! Each scheduler pass first keeps one `signal_sources` row per source and
//! scope that an active routine held here reads; a row nobody reads any
//! more is `stopped` and keeps its cursor, and comes back from it. Then
//! every row that is due starts its poll: at most [`SHORT_SLOTS`] short
//! polls and [`LONG_SLOTS`] long ones at once, each bounded by
//! [`POLL_TIMEOUT_MS`] beyond what it may wait. A poll reads up to
//! [`PAGES_MAX`] pages, each kept with its cursor through ingest, then
//! settles the row: when to poll next, and what went wrong. A source that
//! lost its sign-in stops and tells its capability. One whose thing is gone
//! (a deleted repository, a channel that is not there) stops alone: a
//! notice tells each routine that reads it, and the capability's other
//! sources go on.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use eos_contracts::{RoutineState, Trigger};
use eos_core::capability::CapabilityHealth;
use eos_core::routine::RoutineTriggers;
use eos_core::signals::{PollRequest, Scope, SignalSources, SourceError};
use eos_core::store::{Outbox, Tx};
use eos_core::store::{Store, StoredSignalSource};
use eos_core::{Clock, Error, Ids, Sleeper};
use eos_domain::inbox::ItemKind;
use eos_domain::signals::key::capability_scope;
use eos_inbox::{NewItem, Opening, notice_in};
use serde_json::{Value, json};
use tokio::sync::{Notify, Semaphore};
use tokio::task::JoinSet;

use crate::router::Router;
use crate::sources::{SourceSpec, source_in};

/// A source is polled at most this often…
pub const POLL_MIN_MS: i64 = 30_000;
/// …and at least this often.
pub const POLL_MAX_MS: i64 = 3_600_000;
/// How often a source that does not say is polled.
const POLL_DEFAULT_MS: i64 = 60_000;
pub const SHORT_SLOTS: usize = 4;
pub const LONG_SLOTS: usize = 4;
/// How long a poll may take beyond what it may wait.
pub const POLL_TIMEOUT_MS: i64 = 30_000;
/// The pages one poll reads at most; the rest waits for the next poll.
pub const PAGES_MAX: usize = 10;
/// A poll that cannot reach its service this soon after the computer woke
/// tries again shortly and counts no failure: the network needs a moment.
pub const WAKE_GRACE_MS: i64 = 60_000;
pub const WAKE_RETRY_MS: i64 = 15_000;
/// A poll after a longer gap records what it caught up on.
pub const CATCH_UP_GAP_MS: i64 = 15 * 60_000;
/// How long a source that cannot reach its service waits, one step per
/// failure in a row, the last repeating.
pub const BACKOFF_MS: [i64; 5] = [30_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

/// The kind of a capability's source row.
const CAPABILITY: &str = "capability";
/// The states in which a source polls.
const POLLING: [&str; 3] = ["active", "backing-off", "off"];

/// How often a source is polled: what it asks for, within the bounds.
fn interval_of(declared: Option<i64>) -> i64 {
    declared.unwrap_or(POLL_DEFAULT_MS).clamp(POLL_MIN_MS, POLL_MAX_MS)
}

/// A fixed part of up to a tenth of the interval, from the source's id, so
/// sources that share an interval do not poll in step.
fn offset_of(source_id: &str, interval_ms: i64) -> i64 {
    let hash = source_id
        .bytes()
        .fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3));
    let span = u64::try_from(interval_ms / 10).unwrap_or(0) + 1;
    i64::try_from(hash % span).unwrap_or(0)
}

/// What one poll came to.
pub(crate) struct Polled {
    pub(crate) now: i64,
    /// What went wrong; `None` when every page was read.
    pub(crate) error: Option<SourceError>,
    /// The latest time the source asked not to be polled before.
    pub(crate) not_before: Option<i64>,
    /// New signals over every page.
    pub(crate) fresh: usize,
    /// Since the poll before, when it was over [`CATCH_UP_GAP_MS`].
    pub(crate) gap_ms: Option<i64>,
    /// The computer woke within [`WAKE_GRACE_MS`].
    pub(crate) just_woke: bool,
}

/// The row once the poll is settled: its state, error and next poll.
pub(crate) fn settled(mut row: StoredSignalSource, polled: &Polled) -> StoredSignalSource {
    let now = polled.now;
    let regular = now + row.interval_ms + offset_of(&row.id, row.interval_ms);
    row.updated_at = now;
    match &polled.error {
        None => {
            row.state = "active".into();
            row.error_kind = None;
            row.failures = 0;
            row.next_poll_at = Some(polled.not_before.map_or(regular, |at| at.max(regular)));
            if let Some(gap_ms) = polled.gap_ms {
                row.catch_up_json =
                    Some(serde_json::json!({ "at": now, "items": polled.fresh, "gapMs": gap_ms }).to_string());
            }
        }
        Some(SourceError::Unreachable | SourceError::Bad(_)) if polled.just_woke => {
            row.next_poll_at = Some(now + WAKE_RETRY_MS);
        }
        Some(SourceError::Unreachable | SourceError::Bad(_)) => {
            row.failures += 1;
            let step = usize::try_from(row.failures - 1).unwrap_or(0).min(BACKOFF_MS.len() - 1);
            row.state = "backing-off".into();
            row.error_kind = Some("unreachable".into());
            row.next_poll_at = Some(now + BACKOFF_MS[step]);
        }
        Some(SourceError::RateLimited { retry_at }) => {
            row.error_kind = Some("rate-limited".into());
            row.next_poll_at = Some((*retry_at).max(now));
        }
        Some(error @ (SourceError::Unauthorized | SourceError::Gone)) => {
            row.failures += 1;
            row.state = "needs-attention".into();
            row.error_kind = Some(if *error == SourceError::Gone { "gone" } else { "unauthorized" }.into());
            row.next_poll_at = None;
        }
        Some(SourceError::Off) => {
            row.state = "off".into();
            row.error_kind = None;
            row.next_poll_at = Some(regular);
        }
    }
    row
}

/// The subject of a routine's notice that one of its sources is gone.
const SOURCE_GONE: &str = "source-gone";

/// The day's one notice that what `routine_id` reads through a source is gone.
fn notice_gone_in(tx: &dyn Tx, out: &mut Outbox, at: &Opening<'_>, routine_id: &str) -> Result<(), Error> {
    let name = tx.routines().find(routine_id)?.map_or_else(|| "A routine".to_owned(), |routine| routine.name);
    let item = NewItem {
        kind: ItemKind::Notice,
        producer: "signals".into(),
        routine_id: Some(routine_id.to_owned()),
        run_id: None,
        subject_key: Some(SOURCE_GONE.into()),
        title: format!("{name} cannot find something it watches"),
        summary: "A repository or conversation that starts it is not there. Change what starts it; its other triggers still work.".into(),
        payload: json!({}),
        by_hand: false,
    };
    notice_in(tx, out, at, item).map(drop)
}

pub(crate) struct Polls {
    pub(crate) store: Arc<dyn Store>,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) sleeper: Arc<dyn Sleeper>,
    pub(crate) ids: Arc<dyn Ids>,
    pub(crate) sources: Arc<dyn SignalSources>,
    pub(crate) health: Arc<dyn CapabilityHealth>,
    pub(crate) router: Arc<Router>,
    /// The scheduler's: a settled poll may change when it should look next.
    pub(crate) kick: Arc<Notify>,
    pub(crate) short: Arc<Semaphore>,
    pub(crate) long: Arc<Semaphore>,
    /// Sources whose poll started and has not settled.
    pub(crate) polling: Mutex<HashSet<String>>,
    pub(crate) tasks: Mutex<JoinSet<()>>,
    /// When the computer last woke.
    pub(crate) woke_at: AtomicI64,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Polls {
    /// The computer woke now.
    pub(crate) fn woke(&self) {
        self.woke_at.store(self.clock.now_ms(), Ordering::SeqCst);
    }

    /// Keeps one row per source and scope `held` (the routines held here)
    /// read while active, and stops the rows none reads.
    pub(crate) async fn ensure(&self, held: &[Arc<RoutineTriggers>]) -> Result<(), Error> {
        let mut wanted: HashMap<String, (String, String, i64)> = HashMap::new();
        for routine in held.iter().filter(|routine| routine.state == RoutineState::Active) {
            for trigger in &routine.when.on {
                let Trigger::Source { source, scope, .. } = trigger else { continue };
                let (scope_json, scope_hash) = capability_scope(source, scope);
                let interval = interval_of(self.sources.get(source).and_then(|source| source.interval_ms()));
                wanted.insert(scope_hash, (source.clone(), scope_json, interval));
            }
        }
        let (ids, now) = (self.ids.clone(), self.clock.now_ms());
        self.store
            .write(move |tx, _| {
                for (scope_hash, (source, scope_json, interval_ms)) in wanted.iter() {
                    let spec = SourceSpec {
                        kind: CAPABILITY,
                        source: Some(source),
                        scope_json: scope_json.clone(),
                        scope_hash: scope_hash.clone(),
                        interval_ms: *interval_ms,
                    };
                    let (mut row, _) = source_in(tx, ids.as_ref(), spec, now)?;
                    if row.interval_ms != *interval_ms {
                        // The source's declared interval changed: the next poll keeps to it.
                        tracing::info!(source_id = %row.id, interval_ms, "a source's interval changed");
                        let due = now + interval_ms;
                        row = StoredSignalSource {
                            interval_ms: *interval_ms,
                            next_poll_at: row.next_poll_at.map(|at| at.min(due)),
                            updated_at: now,
                            ..row
                        };
                        tx.signal_sources().update(&row)?;
                    }
                    if row.state == "stopped" {
                        tracing::info!(source_id = %row.id, state = "active", "a source resumes from its cursor");
                        let row = StoredSignalSource {
                            state: "active".into(),
                            stopped_at: None,
                            next_poll_at: Some(now),
                            updated_at: now,
                            ..row
                        };
                        tx.signal_sources().update(&row)?;
                    }
                }
                for row in tx.signal_sources().all()? {
                    if row.kind == CAPABILITY && row.state != "stopped" && !wanted.contains_key(&row.scope_hash) {
                        tracing::info!(source_id = %row.id, state = "stopped", "no routine reads a source");
                        let row = StoredSignalSource {
                            state: "stopped".into(),
                            stopped_at: Some(now),
                            next_poll_at: None,
                            updated_at: now,
                            ..row
                        };
                        tx.signal_sources().update(&row)?;
                    }
                }
                Ok(())
            })
            .await
    }

    /// Starts the poll of every source that is due and not polling; answers
    /// when the next of the others is due.
    pub(crate) async fn start_due(self: &Arc<Self>) -> Result<Option<i64>, Error> {
        let rows = self.store.read(|tx| tx.signal_sources().all()).await?;
        let now = self.clock.now_ms();
        let mut next: Option<i64> = None;
        let mut tasks = locked(&self.tasks);
        while tasks.try_join_next().is_some() {}
        for row in rows.into_iter().filter(|row| row.kind == CAPABILITY && POLLING.contains(&row.state.as_str())) {
            match row.next_poll_at {
                Some(at) if at > now => next = Some(next.map_or(at, |next: i64| next.min(at))),
                _ => {
                    if locked(&self.polling).insert(row.id.clone()) {
                        tasks.spawn(self.clone().poll(row, None));
                    }
                }
            }
        }
        Ok(next)
    }

    /// Ends every poll; their rows stay as they were before it.
    pub(crate) async fn stop(&self) {
        let mut tasks = std::mem::take(&mut *locked(&self.tasks));
        tasks.shutdown().await;
        locked(&self.polling).clear();
    }

    /// A push said the source `source_id` has news: polls it now, looking
    /// at `focus` first, unless it polls already or does not poll. Answers
    /// whether a poll started.
    pub(crate) async fn poll_now(self: &Arc<Self>, source_id: &str, focus: Option<String>) -> Result<bool, Error> {
        let lookup = source_id.to_owned();
        let row = self.store.read(move |tx| tx.signal_sources().find(&lookup)).await?;
        let Some(row) = row.filter(|row| row.kind == CAPABILITY && POLLING.contains(&row.state.as_str())) else {
            return Ok(false);
        };
        if !locked(&self.polling).insert(row.id.clone()) {
            return Ok(false);
        }
        locked(&self.tasks).spawn(self.clone().poll(row, focus));
        Ok(true)
    }

    /// Polls one source, page by page, and settles its row.
    async fn poll(self: Arc<Self>, row: StoredSignalSource, focus: Option<String>) {
        let polled = self.read_pages(&row, focus).await;
        let error = polled.error.clone();
        let source_id = row.id.clone();
        let readers = if error == Some(SourceError::Gone) { self.readers(&row).await } else { Vec::new() };
        let router = self.router.clone();
        let job = move |tx: &dyn Tx, out: &mut Outbox| {
            let Some(row) = tx.signal_sources().find(&source_id)? else { return Ok(None) };
            let before = (row.state.clone(), row.error_kind.clone());
            let row = settled(row, &polled);
            tx.signal_sources().update(&row)?;
            let at = Opening {
                now: polled.now,
                ids: router.ids.as_ref(),
                zone: router.zone.as_ref(),
                control: router.control.as_ref(),
            };
            for routine_id in &readers {
                notice_gone_in(tx, out, &at, routine_id)?;
            }
            Ok(Some((before, row)))
        };
        match self.store.write(job).await {
            Ok(Some(((state, error_kind), row))) => {
                if (state, error_kind) != (row.state.clone(), row.error_kind.clone()) {
                    tracing::info!(source_id = %row.id, kind = %row.kind, state = %row.state, error_kind = row.error_kind.as_deref(), failures = row.failures, "a source's state changed");
                }
                if let Some(error @ SourceError::Unauthorized) = &error {
                    let capability =
                        row.source.as_deref().and_then(|source| source.split('.').next()).unwrap_or_default();
                    if let Err(failure) = self.health.report(capability, error).await {
                        tracing::warn!(source_id = %row.id, %failure, "a capability could not be told of its source");
                    }
                }
            }
            Ok(None) => {}
            Err(failure) => tracing::warn!(source_id = %row.id, %failure, "a poll could not be settled"),
        }
        locked(&self.polling).remove(&row.id);
        self.kick.notify_one();
    }

    /// The active routines held here whose When reads the source of `row`.
    async fn readers(&self, row: &StoredSignalSource) -> Vec<String> {
        let routines = match self.router.directory.triggers().await {
            Ok(routines) => routines,
            Err(error) => {
                tracing::warn!(source_id = %row.id, %error, "the routines that read a source could not be listed");
                return Vec::new();
            }
        };
        let reads = |trigger: &Trigger| match trigger {
            Trigger::Source { source, scope, .. } => {
                row.source.as_deref() == Some(source.as_str()) && capability_scope(source, scope).1 == row.scope_hash
            }
            _ => false,
        };
        routines
            .iter()
            .filter(|routine| routine.state == RoutineState::Active && self.router.holding.acts(&routine.id))
            .filter(|routine| routine.when.on.iter().any(reads))
            .map(|routine| routine.id.clone())
            .collect()
    }

    /// Reads up to [`PAGES_MAX`] pages, each kept through ingest; the first
    /// looks at `focus` first.
    async fn read_pages(&self, row: &StoredSignalSource, mut focus: Option<String>) -> Polled {
        let source = row.source.as_deref().and_then(|name| self.sources.get(name));
        let wait_ms = source.as_ref().map_or(0, |source| source.wait_ms());
        let slots = if wait_ms > 0 { &self.long } else { &self.short };
        let _slot = slots.clone().acquire_owned().await;
        let now = self.clock.now_ms();
        let gap_ms = row.last_poll_at.map(|last| now - last).filter(|gap| *gap > CATCH_UP_GAP_MS);
        let just_woke = now - self.woke_at.load(Ordering::SeqCst) < WAKE_GRACE_MS;
        let mut polled = Polled { now, error: None, not_before: None, fresh: 0, gap_ms, just_woke };
        let Some(source) = source else {
            polled.error = Some(SourceError::Unreachable);
            return polled;
        };
        let scope: Scope = serde_json::from_str(&row.scope_json).unwrap_or_default();
        let mut cursor: Option<Value> = row.cursor_json.as_deref().and_then(|json| serde_json::from_str(json).ok());
        let limit = POLL_TIMEOUT_MS + i64::try_from(wait_ms).unwrap_or(i64::MAX / 2);
        for _ in 0..PAGES_MAX {
            let request = PollRequest { scope: scope.clone(), cursor: cursor.clone(), wait_ms, focus: focus.take() };
            let answer = tokio::select! {
                answer = source.poll(request) => answer,
                () = self.sleeper.sleep(limit) => Err(SourceError::Unreachable),
            };
            let page = match answer {
                Ok(page) => page,
                Err(error) => {
                    polled.error = Some(error);
                    break;
                }
            };
            let asked = [page.poll_after_ms.map(|ms| now + ms), page.retry_at].into_iter().flatten().max();
            polled.not_before = polled.not_before.max(asked);
            let (more, next_cursor) = (page.more, page.cursor.clone());
            match self.router.ingest(&row.id, page).await {
                Ok(fresh) => polled.fresh += fresh,
                Err(error) => {
                    // Too many signals wait, or the page could not be kept:
                    // the next poll reads again from the cursor kept.
                    tracing::warn!(source_id = %row.id, %error, "a page was not kept");
                    break;
                }
            }
            cursor = Some(next_cursor);
            if !more {
                break;
            }
        }
        polled
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_interval_keeps_within_its_bounds_and_its_offset_within_a_tenth() {
        assert_eq!(
            (interval_of(None), interval_of(Some(5_000)), interval_of(Some(7_200_000))),
            (60_000, 30_000, 3_600_000)
        );
        let offset = offset_of("src-0a1b2c3d4e5f", 60_000);
        assert_eq!(offset, offset_of("src-0a1b2c3d4e5f", 60_000), "the same every time");
        assert!((0..=6_000).contains(&offset));
        assert_ne!(offset, offset_of("src-1b2c3d4e5f6a", 60_000), "another source polls at another moment");
    }
}
