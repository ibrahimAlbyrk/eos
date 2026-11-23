//! Code-view panes: the user's own Claude Code, read through its transcript.
//! A pane's conversation is looked at once its transcript has been quiet for
//! a minute (Claude is between turns) and once more when the pane exits.
//! Which panes exist comes from the terminals' `pty:session` and `pty:exit`
//! events; the transcript is read off the async threads.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use eos_contracts::stream::topics;
use eos_contracts::{PtyKind, PtySession};
use eos_core::terminal::{ClaudeTranscripts, TranscriptFile};
use eos_core::{Clock, Sleeper};
use eos_domain::EventRecord;
use eos_memory::Capture;
use eos_runtime::bus::{Bus, Subscription};
use serde::Deserialize;
use tokio::sync::Notify;

/// A transcript unchanged this long is between turns.
pub(crate) const QUIET_MS: i64 = 60_000;
/// How often the panes' transcripts are looked at for a change.
pub(crate) const POLL_MS: i64 = 15_000;

type SharedFile = Arc<Mutex<Box<dyn TranscriptFile>>>;

struct Pane {
    claude_session_id: String,
    file: SharedFile,
    stamp: Option<(u64, i64)>,
    changed_at: i64,
    /// Read since its last change.
    read: bool,
    /// The pane exited or moved to another conversation: read once more, then dropped.
    gone: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExitOf {
    session_id: String,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

struct Inner {
    capture: Capture,
    transcripts: Arc<dyn ClaudeTranscripts>,
    clock: Arc<dyn Clock>,
    /// By PTY session id; a pane that moved conversation keeps its old one
    /// under `<pty id>#<claude id>` until it is read.
    panes: Mutex<HashMap<String, Pane>>,
    /// The folder each Claude session seen ran in, so its moments can be
    /// read again for reflection after its pane is gone; at most
    /// [`KNOWN_MAX`] (the store keeps a moment, not a pane).
    known: Mutex<HashMap<String, String>>,
    wake: Notify,
    /// Wakes reflection when a look stored moments.
    reflect: Arc<Notify>,
}

const KNOWN_MAX: usize = 512;

pub(crate) struct CodePanes {
    inner: Arc<Inner>,
    _subscriptions: [Subscription; 2],
}

impl CodePanes {
    pub(crate) fn new(
        bus: &Bus,
        capture: Capture,
        transcripts: Arc<dyn ClaudeTranscripts>,
        clock: Arc<dyn Clock>,
        reflect: Arc<Notify>,
    ) -> Self {
        let inner = Arc::new(Inner {
            capture,
            transcripts,
            clock,
            panes: Mutex::new(HashMap::new()),
            known: Mutex::new(HashMap::new()),
            wake: Notify::new(),
            reflect,
        });
        let on_session = {
            let inner = Arc::downgrade(&inner);
            bus.on(topics::PTY_SESSION, move |event| {
                if let (Some(inner), Ok(session)) = (inner.upgrade(), event.payload_as::<PtySession>()) {
                    inner.saw(&session);
                }
            })
        };
        let on_exit = {
            let inner = Arc::downgrade(&inner);
            bus.on(topics::PTY_EXIT, move |event| {
                if let (Some(inner), Ok(exit)) = (inner.upgrade(), event.payload_as::<ExitOf>()) {
                    inner.exited(&exit.session_id);
                }
            })
        };
        Self { inner, _subscriptions: [on_session, on_exit] }
    }

    /// A Claude session's conversation as rows, read again from its
    /// transcript, and the folder it ran in; `None` when the session was not
    /// seen by this run.
    pub(crate) async fn rows(&self, claude_session_id: &str) -> Option<(Vec<EventRecord>, String)> {
        let cwd = lock(&self.inner.known).get(claude_session_id).cloned()?;
        let file: SharedFile = Arc::new(Mutex::new(self.inner.transcripts.open(&cwd, claude_session_id)));
        let rows = tokio::task::spawn_blocking(move || rows_of(&file)).await.ok().filter(|rows| !rows.is_empty())?;
        Some((rows, cwd))
    }

    /// Looks at the panes every [`POLL_MS`] while there are any, and at once
    /// when one comes or exits. Without panes it sleeps until one comes, so an
    /// idle app is not woken for nothing.
    pub(crate) fn poll(&self, sleeper: Arc<dyn Sleeper>) -> impl Future<Output = ()> + Send + 'static {
        let inner = self.inner.clone();
        async move {
            loop {
                if lock(&inner.panes).is_empty() {
                    inner.wake.notified().await;
                } else {
                    tokio::select! {
                        () = sleeper.sleep(POLL_MS) => {}
                        () = inner.wake.notified() => {}
                    }
                }
                inner.look().await;
            }
        }
    }
}

impl Inner {
    fn saw(&self, session: &PtySession) {
        if session.kind != PtyKind::Claude || !session.alive {
            return;
        }
        let Some(claude_session_id) = session.claude_session_id.clone() else { return };
        {
            let mut known = lock(&self.known);
            if known.len() >= KNOWN_MAX && !known.contains_key(&claude_session_id) {
                known.clear();
            }
            known.insert(claude_session_id.clone(), session.cwd.clone());
        }
        let mut panes = lock(&self.panes);
        if let Some(pane) = panes.get(&session.session_id) {
            if pane.claude_session_id == claude_session_id {
                return;
            }
            if let Some(mut old) = panes.remove(&session.session_id) {
                old.gone = true;
                panes.insert(format!("{}#{}", session.session_id, old.claude_session_id), old);
                self.wake.notify_one();
            }
        }
        let file = Arc::new(Mutex::new(self.transcripts.open(&session.cwd, &claude_session_id)));
        let pane =
            Pane { claude_session_id, file, stamp: None, changed_at: self.clock.now_ms(), read: true, gone: false };
        panes.insert(session.session_id.clone(), pane);
        // The poll sleeps while there are no panes.
        self.wake.notify_one();
    }

    fn exited(&self, session_id: &str) {
        if let Some(pane) = lock(&self.panes).get_mut(session_id) {
            pane.gone = true;
            self.wake.notify_one();
        }
    }

    /// Reads every pane that went quiet after a change, or is gone.
    async fn look(&self) {
        let now = self.clock.now_ms();
        let due: Vec<(String, String, SharedFile, bool)> = {
            let mut panes = lock(&self.panes);
            let mut due = Vec::new();
            for (key, pane) in panes.iter_mut() {
                let stamp = lock(&pane.file).stamp();
                if stamp != pane.stamp {
                    pane.stamp = stamp;
                    pane.changed_at = now;
                    pane.read = false;
                }
                if pane.gone || (!pane.read && now - pane.changed_at >= QUIET_MS) {
                    pane.read = true;
                    due.push((key.clone(), pane.claude_session_id.clone(), pane.file.clone(), pane.gone));
                }
            }
            due
        };
        for (key, claude_session_id, file, gone) in due {
            let rows = tokio::task::spawn_blocking(move || rows_of(&file)).await.unwrap_or_default();
            if !rows.is_empty() {
                match self.capture.look_code(&claude_session_id, rows).await {
                    Ok(captured) if !captured.stored.is_empty() => self.reflect.notify_one(),
                    Ok(_) => {}
                    // The next change or exit tries again.
                    Err(e) => tracing::warn!(error = %e, "memory: Code-view capture failed"),
                }
            }
            if gone {
                lock(&self.panes).remove(&key);
            }
        }
    }
}

/// The transcript's rows in the shape of worker events.
fn rows_of(file: &SharedFile) -> Vec<EventRecord> {
    let Some(view) = lock(file).read() else { return Vec::new() };
    view.rows
        .iter()
        .map(|row| EventRecord {
            id: row.id,
            worker_id: String::new(),
            ts: row.ts.as_f64() as i64,
            kind: row.r#type.clone(),
            payload: row.payload.as_ref().map(|p| p.to_string()),
        })
        .collect()
}
