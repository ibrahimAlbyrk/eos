//! A Claude pane's conversation, read from its Claude Code transcript.
//!
//! The file is watched from the first read until the pane exits or switches
//! conversation (`/clear`, `/resume`); every change publishes
//! `pty:conversation` so clients read again. An open question or plan comes
//! from the pane's own report (see `launch`) while the transcript does not
//! have it yet.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use eos_contracts::{PtyConversationRow, PtyKind, PtyPending, PtySession};
use eos_core::terminal::{ClaudeTranscripts, TranscriptFile};
use eos_domain::claude_transcript::TranscriptView;
use eos_runtime::bus::{Bus, Subscription};
use serde_json::Value;

use crate::sessions::{DialogCall, PTY_CONVERSATION, PTY_EXIT, PTY_SESSION, PtyConversationChange, Sessions};

/// How often a watched transcript is looked at. Polling, not a file watch:
/// the file may not exist yet (no message sent), and a poll joins Claude's
/// bursts of appends into one event.
const POLL: Duration = Duration::from_millis(500);

/// A pane's conversation as the route answers it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Conversation {
    pub(crate) claude_session_id: Option<String>,
    pub(crate) view: TranscriptView,
}

type SharedFile = Arc<Mutex<Box<dyn TranscriptFile>>>;

struct Watched {
    claude_session_id: String,
    file: SharedFile,
    /// The poll; it ends with this entry.
    poll: tokio::task::JoinHandle<()>,
}

impl Drop for Watched {
    fn drop(&mut self) {
        self.poll.abort();
    }
}

struct Inner {
    bus: Bus,
    sessions: Sessions,
    transcripts: Arc<dyn ClaudeTranscripts>,
    /// By PTY session id.
    watched: Mutex<HashMap<String, Watched>>,
}

#[derive(Clone)]
pub(crate) struct Conversations {
    inner: Arc<Inner>,
    _subscriptions: Arc<[Subscription; 2]>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

impl Conversations {
    pub(crate) fn new(bus: Bus, sessions: Sessions, transcripts: Arc<dyn ClaudeTranscripts>) -> Self {
        let inner = Arc::new(Inner { bus: bus.clone(), sessions, transcripts, watched: Mutex::new(HashMap::new()) });
        let on_exit = {
            let inner = Arc::downgrade(&inner);
            bus.on(&PTY_EXIT, move |event| {
                if let (Some(inner), Ok(exit)) = (inner.upgrade(), event.payload_as::<ExitOf>()) {
                    lock(&inner.watched).remove(&exit.session_id);
                }
            })
        };
        // The pane moved to another conversation: stop watching the old one.
        let on_session = {
            let inner = Arc::downgrade(&inner);
            bus.on(&PTY_SESSION, move |event| {
                let (Some(inner), Ok(session)) = (inner.upgrade(), event.payload_as::<PtySession>()) else { return };
                let mut watched = lock(&inner.watched);
                let moved = watched
                    .get(&session.session_id)
                    .is_some_and(|w| Some(w.claude_session_id.as_str()) != session.claude_session_id.as_deref());
                if moved {
                    watched.remove(&session.session_id);
                    drop(watched);
                    let change = PtyConversationChange {
                        session_id: session.session_id,
                        claude_session_id: session.claude_session_id,
                    };
                    inner.bus.publish(&PTY_CONVERSATION, &change);
                }
            })
        };
        Self { inner, _subscriptions: Arc::new([on_exit, on_session]) }
    }

    /// `None`: no such session, or it is not a Claude pane. Reads a file;
    /// must run inside the async runtime (the watch's poll lives there).
    pub(crate) async fn get(&self, pty_id: &str) -> Option<Conversation> {
        let session = self.inner.sessions.get(pty_id).filter(|s| s.kind == PtyKind::Claude)?;
        let Some(claude_session_id) = session.claude_session_id.clone() else {
            return Some(Conversation { claude_session_id: None, view: TranscriptView::default() });
        };
        let file = self.inner.watching(&session, &claude_session_id);
        let read = tokio::task::spawn_blocking(move || lock(&file).read()).await;
        let mut view = read.ok().flatten().unwrap_or_default();
        if view.pending.is_none() {
            view.pending = self
                .inner
                .sessions
                .dialog_call(pty_id)
                .filter(|dialog| dialog.conversation.as_deref() == Some(claude_session_id.as_str()))
                .and_then(|dialog| open_dialog(&dialog, &view.rows));
        }
        Some(Conversation { claude_session_id: Some(claude_session_id), view })
    }

    /// Stops every watch (shutdown).
    pub(crate) fn stop(&self) {
        lock(&self.inner.watched).clear();
    }

    #[cfg(test)]
    pub(crate) fn watching(&self) -> usize {
        lock(&self.inner.watched).len()
    }
}

/// `pty:exit` as it is read back here.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExitOf {
    session_id: String,
}

impl Inner {
    /// The transcript of the pane's current conversation, watched.
    fn watching(self: &Arc<Self>, session: &PtySession, claude_session_id: &str) -> SharedFile {
        let mut watched = lock(&self.watched);
        if let Some(current) = watched.get(&session.session_id).filter(|w| w.claude_session_id == claude_session_id) {
            return current.file.clone();
        }
        let file: SharedFile = Arc::new(Mutex::new(self.transcripts.open(&session.cwd, claude_session_id)));
        let change = PtyConversationChange {
            session_id: session.session_id.clone(),
            claude_session_id: Some(claude_session_id.to_owned()),
        };
        let (bus, polled) = (self.bus.clone(), file.clone());
        let poll = tokio::spawn(async move {
            let stamp = |file: SharedFile| async move {
                tokio::task::spawn_blocking(move || lock(&file).stamp()).await.ok().flatten()
            };
            let mut last = stamp(polled.clone()).await;
            loop {
                tokio::time::sleep(POLL).await;
                let now = stamp(polled.clone()).await;
                if now != last {
                    last = now;
                    bus.publish(&PTY_CONVERSATION, &change);
                }
            }
        });
        watched.insert(
            session.session_id.clone(),
            Watched { claude_session_id: claude_session_id.to_owned(), file: file.clone(), poll },
        );
        file
    }
}

/// The pane's reported dialog call, unless the transcript shows it settled:
/// its result, or a prompt or interrupt recorded after it opened.
fn open_dialog(dialog: &DialogCall, rows: &[PtyConversationRow]) -> Option<PtyPending> {
    let settled = rows.iter().any(|row| {
        let payload = row.payload.as_ref();
        let is_event = row.r#type == "agent_event";
        let field = |key: &str| payload.and_then(|p| p.get(key)).and_then(Value::as_str);
        let has_result = is_event
            && field("role") == Some("tool")
            && payload.and_then(|p| p.get("blocks")).and_then(Value::as_array).is_some_and(|blocks| {
                blocks.iter().any(|b| b.get("callId").and_then(Value::as_str) == Some(dialog.call.tool_use_id.as_str()))
            });
        let turn_input = row.r#type == "user_message" || (is_event && field("type") == Some("turn"));
        has_result || (row.ts.as_f64() >= dialog.at as f64 && turn_input)
    });
    (!settled).then(|| dialog.call.clone())
}
