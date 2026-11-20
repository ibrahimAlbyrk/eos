//! A source's page kept (02 §3 B step 2): its new signals as `received` and
//! the source's cursor, in one write; refused while too many signals wait
//! to be routed. The first page of a new source is decided `baseline` in
//! that write: what exists already starts nothing. Each new signal is a new
//! version of its subject, announced on `signals:subject` from that write's
//! outbox, matched or not (02 §3 J.48), closed when its source says its
//! kind ends the subject.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use eos_contracts::SignalSubject;
use eos_core::Error;
use eos_core::signals::{PollPage, SignalSource};
use eos_core::store::{NewSignal, Outbox, Tx};
use eos_domain::signals::key::fits;

use crate::router::Router;
use crate::{BACKED_UP, CAUGHT_UP, SIGNALS_SUBJECT};

/// Keeps a page inside a write job: its new signals as `received`, the
/// source's cursor as the page gave it, and each new signal's subject
/// announced, closed when `closes` says so of its kind. Answers the new
/// signals.
pub(crate) fn ingest_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    source_id: &str,
    page: &PollPage,
    now: i64,
    closes: &dyn Fn(&str) -> bool,
) -> Result<Vec<i64>, Error> {
    let mut source = tx.signal_sources().find(source_id)?.ok_or_else(|| Error::not_found("source", source_id))?;
    let mut fresh = Vec::new();
    for draft in page.items.iter().filter(|draft| fits(&draft.key)) {
        let signal = NewSignal {
            source_id: source_id.to_owned(),
            key: draft.key.clone(),
            subject: draft.subject.clone(),
            version: draft.version.clone(),
            kind: draft.kind.clone(),
            occurred_at: draft.occurred_at,
            received_at: now,
            facts_json: serde_json::to_string(&draft.facts).ok(),
            item_json: draft.item.to_string(),
            depth: 0,
        };
        let Some(id) = tx.signals().ingest(&signal)? else { continue };
        fresh.push(id);
        let subject =
            SignalSubject { subject_key: signal.subject, version: signal.version, closed: closes(&signal.kind) };
        out.push(SIGNALS_SUBJECT.name(), &subject);
    }
    source.cursor_json = Some(page.cursor.to_string());
    source.last_poll_at = Some(now);
    if !fresh.is_empty() {
        source.last_signal_at = Some(now);
    }
    source.updated_at = now;
    tx.signal_sources().update(&source)?;
    tracing::info!(source_id, items = page.items.len(), fresh = fresh.len(), "a source's page was kept");
    Ok(fresh)
}

impl Router {
    /// Keeps one page for the source row `source_id` (see
    /// [`SignalsModule::ingest`](crate::SignalsModule::ingest)). A
    /// baseline page's signals are decided `baseline` for every routine
    /// held here that takes them, in the same write.
    pub(crate) async fn ingest(&self, source_id: &str, page: PollPage) -> Result<usize, Error> {
        let waiting = self.store.read(|tx| tx.signals().received_count()).await?;
        let backed_up = self.backed_up.load(Ordering::SeqCst);
        if waiting > BACKED_UP || (backed_up && waiting >= CAUGHT_UP) {
            if !backed_up {
                tracing::warn!(waiting, "signals back up: sources wait until they are routed");
            }
            self.backed_up.store(true, Ordering::SeqCst);
            self.kick.notify_one();
            return Err(Error::LimitExceeded("too many signals wait to be routed".into()));
        }
        self.backed_up.store(false, Ordering::SeqCst);
        let routines = if page.baseline { self.directory.triggers().await? } else { Vec::new() };
        let source = self.source_of(source_id).await?;
        let (source_id, routing) = (source_id.to_owned(), self.routing());
        let fresh = self
            .store
            .write(move |tx, out| {
                let closes = |kind: &str| source.as_ref().is_some_and(|source| source.closes(kind));
                let fresh = ingest_in(tx, out, &source_id, &page, routing.now, &closes)?;
                if page.baseline {
                    for id in &fresh {
                        routing.route_in(tx, out, *id, &routines, true)?;
                    }
                }
                Ok(fresh.len())
            })
            .await?;
        self.kick.notify_one();
        Ok(fresh)
    }
}

impl Router {
    /// The declared source the row `source_id` reads, if any.
    async fn source_of(&self, source_id: &str) -> Result<Option<Arc<dyn SignalSource>>, Error> {
        let lookup = source_id.to_owned();
        let row = self.store.read(move |tx| tx.signal_sources().find(&lookup)).await?;
        Ok(row.and_then(|row| row.source).and_then(|name| self.sources.get(&name)))
    }
}
