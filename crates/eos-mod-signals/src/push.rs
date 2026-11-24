//! The push loop (02 §3 E.29, §4.4 "push"): events outside services posted
//! to this computer's hooks on the relay (07 §4.7), read and routed.
//!
//! While a source a routine reads has a hook and the stop switch is off,
//! the loop long-polls the inbox ([`PUSH_WAIT_MS`]) from its cursor. Each
//! event goes to the one source its hook was made for, which checks the
//! service's signature: a hint polls that source now (once however many
//! hints a batch holds for it), a push-only source's signal is kept keyed
//! by its delivery id, and the rest is refused and counted. An unknown hook
//! is refused too. So a forged or replayed event costs one poll at most.
//! The cursor and the counts are saved, then the inbox is acked: a crash
//! between reads the batch again, which polls again or finds its signals
//! kept. When the relay dropped events this computer never read, each
//! hooked source shows the gap and polls at once.
//!
//! The inbox's row in `signal_sources` (kind `push-inbox`) keeps the
//! cursor as `{seq, dropped, refused, unreadable}`. Hook bodies, headers
//! and URLs are the services' content: logs carry ids and counts.

use std::collections::HashSet;
use std::sync::Arc;

use eos_core::net::hooks::{HookBatch, HookInbox};
use eos_core::signals::{PollPage, PushEvent, PushOutcome, Scope, SignalSources, SourceError};
use eos_core::store::{Store, StoredSignalSource, Tx};
use eos_core::{Clock, Error, Ids, Sleeper};
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;

use crate::polls::Polls;
use crate::router::{Router, error_kind, halted_in};
use crate::sources::{SourceSpec, source_in};

/// How long one read of the inbox waits for an event.
pub const PUSH_WAIT_MS: u64 = 25_000;
/// How long the loop waits after the inbox could not be read, one step per
/// failure in a row, the last repeating.
pub const PUSH_BACKOFF_MS: [i64; 4] = [5_000, 30_000, 60_000, 5 * 60_000];
/// How long the loop rests while no source has a hook or the stop switch is
/// on; adding a hook wakes it.
pub const PUSH_IDLE_MS: i64 = 60_000;

/// The kind and scope of the inbox's own row.
pub(crate) const PUSH_INBOX: &str = "push-inbox";

/// Where the loop is in the inbox, and what it threw away.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct InboxCursor {
    /// Every event through this one was routed.
    pub(crate) seq: u64,
    /// The relay's count of events it dropped unread, as last seen.
    pub(crate) dropped: u64,
    /// Events no source took: an unknown hook, a bad signature.
    pub(crate) refused: u64,
    /// Entries that did not open with this computer's key.
    pub(crate) unreadable: u64,
}

pub(crate) struct Push {
    pub(crate) store: Arc<dyn Store>,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) sleeper: Arc<dyn Sleeper>,
    pub(crate) ids: Arc<dyn Ids>,
    pub(crate) sources: Arc<dyn SignalSources>,
    pub(crate) inbox: Arc<dyn HookInbox>,
    pub(crate) router: Arc<Router>,
    pub(crate) polls: Arc<Polls>,
    /// Rings when a hook was added.
    pub(crate) kick: Notify,
}

/// What one turn of the loop did.
enum Turn {
    /// It read the inbox: read again at once.
    Read,
    /// Nothing to read for.
    Idle,
}

impl Push {
    /// Reads the inbox until stopped.
    pub(crate) async fn run(self: Arc<Self>) {
        let (mut ensured, mut failures) = (false, 0usize);
        loop {
            let wait = match self.turn(&mut ensured).await {
                Ok(Turn::Read) => {
                    failures = 0;
                    continue;
                }
                Ok(Turn::Idle) => PUSH_IDLE_MS,
                Err(error) => {
                    tracing::warn!(error = error_kind(&error), failures, "the hook inbox could not be read");
                    ensured = false;
                    failures += 1;
                    PUSH_BACKOFF_MS[(failures - 1).min(PUSH_BACKOFF_MS.len() - 1)]
                }
            };
            tokio::select! {
                () = self.sleeper.sleep(wait) => {}
                () = self.kick.notified() => {}
            }
        }
    }

    async fn turn(&self, ensured: &mut bool) -> Result<Turn, Error> {
        let listening = self
            .store
            .read(|tx| {
                if halted_in(tx)? {
                    return Ok(false);
                }
                Ok(!hooked_in(tx)?.is_empty())
            })
            .await?;
        if !listening {
            return Ok(Turn::Idle);
        }
        if !*ensured {
            self.inbox.ensure().await?;
            *ensured = true;
        }
        let (ids, now) = (self.ids.clone(), self.clock.now_ms());
        let (row, fresh) = self.store.write(move |tx, _| source_in(tx, ids.as_ref(), inbox_spec(), now)).await?;
        let cursor = cursor_of(&row);
        let batch = self.inbox.next(cursor.seq, PUSH_WAIT_MS).await?;
        self.handle(&row.id, cursor, fresh, batch).await?;
        Ok(Turn::Read)
    }

    /// Routes one batch, saves the cursor, acks, then polls what was hinted.
    async fn handle(&self, inbox_id: &str, cursor: InboxCursor, fresh: bool, batch: HookBatch) -> Result<(), Error> {
        let (mut hinted, mut refused, mut signals): (Vec<(String, Option<String>)>, u64, usize) = (Vec::new(), 0, 0);
        for event in batch.events {
            let hook = event.hook.clone();
            let row = self
                .store
                .read(move |tx| match tx.signal_hooks().source_of(&hook)? {
                    Some(source_id) => tx.signal_sources().find(&source_id),
                    None => Ok(None),
                })
                .await?;
            let source = row.as_ref().and_then(|row| row.source.as_deref()).and_then(|name| self.sources.get(name));
            let (Some(row), Some(source)) = (row, source) else {
                refused += 1;
                continue;
            };
            let scope: Scope = serde_json::from_str(&row.scope_json).unwrap_or_default();
            let push = PushEvent { hook: event.hook, headers: event.headers, body: event.body };
            match source.accept_push(&scope, &push).await {
                Ok(PushOutcome::PollNow { focus }) => {
                    if !hinted.iter().any(|(id, _)| *id == row.id) {
                        hinted.push((row.id, focus));
                    }
                }
                Ok(PushOutcome::Signal(draft)) => {
                    let page = PollPage {
                        items: vec![*draft],
                        cursor: serde_json::json!({ "seq": event.seq }),
                        more: false,
                        baseline: false,
                        poll_after_ms: None,
                        retry_at: None,
                    };
                    // Not kept (too many wait): the batch is read again later.
                    signals += self.router.ingest(&row.id, page).await?;
                }
                Ok(PushOutcome::Refused) | Err(SourceError::Off | SourceError::Bad(_)) => refused += 1,
                // The secret could not be read: checked again with the batch.
                Err(_) => return Err(Error::Unreachable("a push could not be checked".into())),
            }
        }
        let missed = if fresh { 0 } else { batch.dropped.saturating_sub(cursor.dropped) };
        let next = InboxCursor {
            seq: batch.through.max(cursor.seq),
            dropped: batch.dropped,
            refused: cursor.refused + refused,
            unreadable: cursor.unreadable + u64::from(batch.unreadable),
        };
        let (inbox_id, now) = (inbox_id.to_owned(), self.clock.now_ms());
        let gapped = self.store.write(move |tx, _| save_in(tx, &inbox_id, next, missed, now)).await?;
        if refused > 0 || batch.unreadable > 0 || missed > 0 {
            tracing::warn!(refused, unreadable = batch.unreadable, missed, "hook events were not taken");
        }
        tracing::info!(through = next.seq, hints = hinted.len(), signals, "hook events were routed");
        if next.seq > cursor.seq {
            if let Err(error) = self.inbox.ack(next.seq).await {
                // The next ack covers these too.
                tracing::warn!(error = error_kind(&error), "the hook inbox was not acked");
            }
        }
        let hinted_ids: HashSet<String> = hinted.iter().map(|(id, _)| id.clone()).collect();
        hinted.extend(gapped.into_iter().filter(|id| !hinted_ids.contains(id)).map(|id| (id, None)));
        for (source_id, focus) in hinted {
            if let Err(error) = self.polls.poll_now(&source_id, focus).await {
                tracing::warn!(source_id, error = error_kind(&error), "a hinted source could not be polled");
            }
        }
        Ok(())
    }
}

impl Push {
    /// Has the service of the source `source_id` push its events to a new
    /// hook of this computer's inbox, and wakes the loop. The service is
    /// told the hook's URL and a secret only this computer keeps; a hook
    /// the service did not take is revoked.
    pub(crate) async fn add(&self, source_id: &str) -> Result<StoredSignalSource, Error> {
        let lookup = source_id.to_owned();
        let row = self.store.read(move |tx| tx.signal_sources().find(&lookup)).await?;
        let row = row.ok_or_else(|| Error::not_found("source", source_id))?;
        let source = row.source.as_deref().and_then(|name| self.sources.get(name));
        let Some(source) = source.filter(|source| source.pushes()) else {
            return Err(Error::Validation("this source's service cannot push its events".into()));
        };
        let scope: Scope = serde_json::from_str(&row.scope_json).unwrap_or_default();
        self.inbox.ensure().await?;
        let hook = self.inbox.create_hook().await?;
        if let Err(error) = source.add_push(&scope, &hook).await {
            if let Err(failure) = self.inbox.revoke_hook(&hook.id).await {
                tracing::warn!(source_id, error = error_kind(&failure), "a hook the service did not take stays");
            }
            return Err(refusal(&error));
        }
        let (hook_id, row_id, now) = (hook.id.clone(), row.id.clone(), self.clock.now_ms());
        self.store.write(move |tx, _| tx.signal_hooks().insert(&hook_id, &row_id, now)).await?;
        tracing::info!(source_id, "a source pushes through a new hook");
        self.kick.notify_one();
        Ok(row)
    }
}

/// Why a service did not take a hook, as the route answers it.
fn refusal(error: &SourceError) -> Error {
    match error {
        SourceError::Unauthorized => {
            Error::PermissionDenied("the service refused the webhook: it needs admin rights on the repository".into())
        }
        SourceError::Gone => Error::not_found("what the source reads", "its scope"),
        SourceError::RateLimited { .. } => Error::LimitExceeded("the service asks to wait".into()),
        SourceError::Bad(_) => Error::Validation("the service did not take the webhook".into()),
        SourceError::Unreachable | SourceError::Off => Error::Unreachable("the service can't be reached".into()),
    }
}

fn inbox_spec() -> SourceSpec<'static> {
    SourceSpec {
        kind: PUSH_INBOX,
        source: None,
        scope_json: "{}".into(),
        scope_hash: PUSH_INBOX.into(),
        interval_ms: 0,
    }
}

fn cursor_of(row: &StoredSignalSource) -> InboxCursor {
    row.cursor_json.as_deref().and_then(|json| serde_json::from_str(json).ok()).unwrap_or_default()
}

/// The hooked sources a routine reads: not stopped.
pub(crate) fn hooked_in(tx: &dyn Tx) -> Result<Vec<StoredSignalSource>, Error> {
    let mut rows = Vec::new();
    for source_id in tx.signal_hooks().hooked()? {
        if let Some(row) = tx.signal_sources().find(&source_id)?.filter(|row| row.state != "stopped") {
            rows.push(row);
        }
    }
    Ok(rows)
}

/// Saves the inbox's cursor; after `missed` events the relay dropped, every
/// hooked source shows the gap. Answers those sources.
fn save_in(tx: &dyn Tx, inbox_id: &str, cursor: InboxCursor, missed: u64, now: i64) -> Result<Vec<String>, Error> {
    let row = tx.signal_sources().find(inbox_id)?.ok_or_else(|| Error::not_found("source", inbox_id))?;
    let gap_ms = now - row.last_poll_at.unwrap_or(now);
    let cursor_json = serde_json::to_string(&cursor).map_err(|e| Error::Storage(e.to_string()))?;
    let row = StoredSignalSource { cursor_json: Some(cursor_json), last_poll_at: Some(now), updated_at: now, ..row };
    tx.signal_sources().update(&row)?;
    if missed == 0 {
        return Ok(Vec::new());
    }
    let mut gapped = Vec::new();
    for row in hooked_in(tx)? {
        let items = i64::try_from(missed).unwrap_or(i64::MAX);
        let catch_up = serde_json::json!({ "at": now, "items": items, "gapMs": gap_ms }).to_string();
        let row = StoredSignalSource { catch_up_json: Some(catch_up), updated_at: now, ..row };
        tx.signal_sources().update(&row)?;
        gapped.push(row.id);
    }
    Ok(gapped)
}
