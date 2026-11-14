//! Interactive terminal sessions.
//!
//! Each session is a long-lived login shell in a real PTY. Output goes out
//! on the bus as `pty:data` in batches: the first bytes after a quiet moment
//! go at once, so a prompt or an echo paints with no added latency; what
//! follows within one frame (16 ms) is joined, and a burst is cut every 8 KB.
//! The same output feeds the session's screen mirror, whose snapshot
//! `GET /pty/:id/buffer` replays on reattach; a client drops live frames
//! with `seq` at or below the snapshot's.
//!
//! A session's public state (kind, size, Claude conversation id, title) is
//! published as `pty:session` on create and whenever it changes.

use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};
use std::time::Duration;

use eos_contracts::stream::topics;
use eos_contracts::{PtyCreateRequest, PtyKind, PtyPending, PtySession};
use eos_core::terminal::{ClaudeLaunchEnv, ClaudeProgram, Pty, PtyEvents, PtySpawn, Screen, Terminals};
use eos_core::{Clock, Error, Ids};
use eos_runtime::bus::{Bus, ScopeKind, Topic};
use indexmap::IndexMap;
use serde::Serialize;

use crate::keys::step_gap;
use crate::launch::claude_command;
use crate::ordered_input::OrderedInput;
use crate::osc::{OscEvent, OscScanner};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyData {
    pub session_id: String,
    pub number: i64,
    pub seq: i64,
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyExit {
    pub session_id: String,
    pub number: i64,
    pub exit_code: i32,
}

/// A Claude pane's conversation changed: clients read it again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyConversationChange {
    pub session_id: String,
    pub claude_session_id: Option<String>,
}

pub const PTY_SESSION: Topic<PtySession> = Topic::new(topics::PTY_SESSION);
pub const PTY_EXIT: Topic<PtyExit> = Topic::new(topics::PTY_EXIT);
/// Raw output: a stream carries it only for the terminals its tab shows.
pub const PTY_DATA: Topic<PtyData> = Topic::scoped(topics::PTY_DATA, ScopeKind::Pty, |d| Some(d.session_id.as_str()));
pub const PTY_CONVERSATION: Topic<PtyConversationChange> = Topic::new(topics::PTY_CONVERSATION);

/// The window in which output after the first piece is joined: about one
/// frame at 60 fps.
const FLUSH_WINDOW: Duration = Duration::from_millis(16);
/// A batch this big goes out at once, whatever the window.
const FLUSH_BYTES: usize = 8 * 1024;
const MAX_SESSIONS: usize = 32;
/// After this many pieces of output the terminal's reader waits until the
/// event lane has delivered them: a flood is held back at its source instead
/// of piling up as queued events.
const SETTLE_EVERY: u32 = 16;

/// The dialog tool call a Claude pane last reported, and when.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct DialogCall {
    pub(crate) call: PtyPending,
    pub(crate) at: i64,
    /// The conversation it was asked in. A pane that moved on (`/clear`,
    /// `/resume`) left the dialog behind with it.
    pub(crate) conversation: Option<String>,
}

/// What changes while a session lives; one lock, so its output, its screen
/// and its public state always agree.
struct Flow {
    cols: i64,
    rows: i64,
    alive: bool,
    claude_session_id: Option<String>,
    title: Option<String>,
    dialog: Option<DialogCall>,
    scanner: OscScanner,
    /// Fed only what was published, so a snapshot corresponds exactly to `seq`.
    screen: Box<dyn Screen>,
    seq: i64,
    pending: String,
    /// The open batch window, by number; a timer that finds another number
    /// (or none) was overtaken.
    window: Option<u64>,
    windows: u64,
    unsettled: u32,
}

struct Session {
    id: String,
    number: i64,
    cwd: String,
    kind: PtyKind,
    remote: bool,
    owner: Option<String>,
    pty: OnceLock<Arc<dyn Pty>>,
    flow: Mutex<Flow>,
    /// Serializes multi-step input so two sequences never interleave.
    steps: tokio::sync::Mutex<()>,
    timers: tokio::runtime::Handle,
}

impl Session {
    fn flow(&self) -> MutexGuard<'_, Flow> {
        self.flow.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn public(&self, flow: &Flow) -> PtySession {
        PtySession {
            session_id: self.id.clone(),
            number: self.number,
            cwd: self.cwd.clone(),
            cols: flow.cols,
            rows: flow.rows,
            alive: flow.alive,
            kind: self.kind,
            claude_session_id: flow.claude_session_id.clone(),
            title: flow.title.clone(),
            remote: self.remote,
            owner: self.owner.clone(),
        }
    }

    fn pty(&self) -> Option<&Arc<dyn Pty>> {
        self.pty.get()
    }
}

struct Registry {
    sessions: IndexMap<String, Arc<Session>>,
    /// Never reused while any session is open, so two live tabs never share
    /// a number; back to 1 when the last one closes.
    next_number: i64,
}

struct Inner {
    terminals: Arc<dyn Terminals>,
    claude: Arc<dyn ClaudeProgram>,
    claude_env: Arc<dyn ClaudeLaunchEnv>,
    bus: Bus,
    ids: Arc<dyn Ids>,
    clock: Arc<dyn Clock>,
    default_cwd: String,
    registry: Mutex<Registry>,
    ordered: OrderedInput,
}

/// What the sessions are built from.
#[allow(missing_debug_implementations)]
pub struct SessionDeps {
    pub terminals: Arc<dyn Terminals>,
    pub claude: Arc<dyn ClaudeProgram>,
    pub claude_env: Arc<dyn ClaudeLaunchEnv>,
    pub bus: Bus,
    pub ids: Arc<dyn Ids>,
    pub clock: Arc<dyn Clock>,
    /// Where a session starts when the request names no folder.
    pub default_cwd: String,
}

#[derive(Clone)]
pub(crate) struct Sessions {
    inner: Arc<Inner>,
}

/// What Claude Code missing reads as (409).
pub(crate) const CLAUDE_MISSING: &str = "Claude Code is not installed on this computer: there is no `claude` on your shell's PATH or in the usual install folders. Install it, then open the Claude pane again.";

impl Sessions {
    pub(crate) fn new(deps: SessionDeps) -> Self {
        let SessionDeps { terminals, claude, claude_env, bus, ids, clock, default_cwd } = deps;
        let registry = Mutex::new(Registry { sessions: IndexMap::new(), next_number: 1 });
        let ordered = OrderedInput::default();
        Self {
            inner: Arc::new(Inner { terminals, claude, claude_env, bus, ids, clock, default_cwd, registry, ordered }),
        }
    }

    fn registry(&self) -> MutexGuard<'_, Registry> {
        self.inner.registry()
    }

    fn find(&self, id: &str) -> Option<Arc<Session>> {
        self.registry().sessions.get(id).cloned()
    }

    fn full(&self) -> Result<(), Error> {
        if self.registry().sessions.len() >= MAX_SESSIONS {
            return Err(Error::LimitExceeded(format!("too many terminal sessions (max {MAX_SESSIONS})")));
        }
        Ok(())
    }

    /// Starts a session. Must run inside the async runtime (its timers live there).
    pub(crate) async fn create(&self, input: PtyCreateRequest) -> Result<PtySession, Error> {
        self.full()?;
        let inner = &self.inner;
        let id = inner.ids.uuid();
        let cwd = input.cwd.clone().unwrap_or_else(|| inner.default_cwd.clone());
        let (cols, rows) = (input.cols, input.rows);
        let size = |n: i64| u16::try_from(n).unwrap_or(u16::MAX);

        // A Claude pane runs the user's own Claude Code under a conversation
        // id pinned up front, so the pane can be resumed after its PTY dies.
        let claude = match &input.claude {
            None => None,
            Some(claude) => {
                let word = inner.claude.locate().await.ok_or_else(|| Error::Conflict(CLAUDE_MISSING.to_owned()))?;
                let conversation = claude.resume.clone().unwrap_or_else(|| inner.ids.uuid());
                let command = claude_command(inner.terminals.as_ref(), &word, &conversation, claude.resume.is_some());
                Some((conversation, command))
            }
        };
        let spec = PtySpawn {
            cwd: cwd.clone(),
            cols: size(cols),
            rows: size(rows),
            command: claude.as_ref().map(|(_, command)| command.clone()).or(input.command.clone()),
            env: if claude.is_some() { inner.claude_env.env().await } else { None },
        };

        let mut registry = self.registry();
        if registry.sessions.len() >= MAX_SESSIONS {
            return Err(Error::LimitExceeded(format!("too many terminal sessions (max {MAX_SESSIONS})")));
        }
        let session = Arc::new(Session {
            id: id.clone(),
            number: registry.next_number,
            cwd,
            kind: if claude.is_some() { PtyKind::Claude } else { PtyKind::Shell },
            remote: input.remote == Some(true),
            owner: input.owner.clone(),
            pty: OnceLock::new(),
            flow: Mutex::new(Flow {
                cols,
                rows,
                alive: true,
                claude_session_id: claude.map(|(conversation, _)| conversation),
                title: None,
                dialog: None,
                scanner: OscScanner::default(),
                screen: inner.terminals.screen(size(cols), size(rows)),
                seq: 0,
                pending: String::new(),
                window: None,
                windows: 0,
                unsettled: 0,
            }),
            steps: tokio::sync::Mutex::new(()),
            timers: tokio::runtime::Handle::current(),
        });
        // Held until the session is announced: its first output waits behind this.
        let flow = session.flow();
        let sink = Sink { session: Arc::downgrade(&session), inner: Arc::downgrade(inner) };
        let pty = inner.terminals.spawn(spec, Box::new(sink))?;
        let _ = session.pty.set(pty);
        registry.next_number += 1;
        registry.sessions.insert(id, session.clone());
        let public = session.public(&flow);
        inner.bus.publish(&PTY_SESSION, &public);
        Ok(public)
    }

    pub(crate) fn list(&self) -> Vec<PtySession> {
        let sessions: Vec<Arc<Session>> = self.registry().sessions.values().cloned().collect();
        sessions.iter().map(|s| s.public(&s.flow())).collect()
    }

    pub(crate) fn get(&self, id: &str) -> Option<PtySession> {
        self.find(id).map(|s| s.public(&s.flow()))
    }

    /// The session's live terminal, or `None` when it is gone.
    fn live(&self, id: &str) -> Option<(Arc<Session>, Arc<dyn Pty>)> {
        let session = self.find(id)?;
        if !session.flow().alive {
            return None;
        }
        let pty = session.pty()?.clone();
        Some((session, pty))
    }

    pub(crate) fn input(&self, id: &str, data: &str) -> bool {
        let Some((_, pty)) = self.live(id) else { return false };
        pty.write(data.as_bytes());
        true
    }

    /// One client input stream's piece, written in `seq` order.
    pub(crate) fn input_in_order(&self, id: &str, stream: &str, seq: u64, data: &str) -> bool {
        let Some((session, _)) = self.live(id) else { return false };
        let target = Arc::downgrade(&session);
        let write = Arc::new(move |data: &str| {
            let Some(session) = target.upgrade() else { return };
            if session.flow().alive
                && let Some(pty) = session.pty()
            {
                pty.write(data.as_bytes());
            }
        });
        self.inner.ordered.accept(&format!("{id}\0{stream}"), seq, data, write);
        true
    }

    pub(crate) fn dialog_call(&self, id: &str) -> Option<DialogCall> {
        self.find(id)?.flow().dialog.clone()
    }

    /// The name of the program in the terminal's foreground.
    pub(crate) async fn foreground(&self, id: &str) -> Option<String> {
        let (_, pty) = self.live(id)?;
        tokio::task::spawn_blocking(move || pty.foreground()).await.ok().flatten()
    }

    /// Writes each step on its own with a pause after it (a TUI reads keys
    /// that arrive together as one paste). `false` when the session is gone.
    pub(crate) async fn send_steps(&self, id: &str, steps: &[String]) -> bool {
        let Some((session, pty)) = self.live(id) else { return false };
        let _turn = session.steps.lock().await;
        for step in steps {
            if !session.flow().alive {
                return false;
            }
            pty.write(step.as_bytes());
            tokio::time::sleep(step_gap(step)).await;
        }
        true
    }

    pub(crate) fn resize(&self, id: &str, cols: i64, rows: i64) -> bool {
        let Some((session, pty)) = self.live(id) else { return false };
        let size = |n: i64| u16::try_from(n).unwrap_or(u16::MAX);
        let mut flow = session.flow();
        let changed = flow.cols != cols || flow.rows != rows;
        flow.cols = cols;
        flow.rows = rows;
        pty.resize(size(cols), size(rows));
        flow.screen.resize(size(cols), size(rows));
        // A device that mirrors the session draws at the PTY's grid.
        if changed {
            self.inner.bus.publish(&PTY_SESSION, &session.public(&flow));
        }
        true
    }

    /// The screen as it is, and the `seq` it corresponds to.
    pub(crate) fn buffer(&self, id: &str) -> Option<(i64, String)> {
        let session = self.find(id)?;
        let flow = session.flow();
        Some((flow.seq, flow.screen.snapshot()))
    }

    /// Hangs the session's shell up; its exit does the rest.
    pub(crate) fn kill(&self, id: &str) -> bool {
        let Some(session) = self.find(id) else { return false };
        if let Some(pty) = session.pty() {
            pty.kill();
        }
        true
    }

    /// The app is closing: no shell outlives it. Sessions are dropped, which
    /// hangs each shell up and kills one that stays.
    pub(crate) fn shutdown(&self) {
        let sessions: Vec<Arc<Session>> = self.registry().sessions.drain(..).map(|(_, s)| s).collect();
        for session in &sessions {
            session.flow().alive = false;
        }
    }
}

impl Inner {
    fn registry(&self) -> MutexGuard<'_, Registry> {
        self.registry.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn apply_reports(&self, session: &Session, flow: &mut Flow, data: &str) {
        let mut changed = false;
        for event in flow.scanner.scan(data) {
            match event {
                OscEvent::Title(title) if title != flow.title => {
                    flow.title = title;
                    changed = true;
                }
                OscEvent::ClaudeSession(id) if flow.claude_session_id.as_deref() != Some(id.as_str()) => {
                    flow.claude_session_id = Some(id);
                    changed = true;
                }
                OscEvent::DialogTool(call) => {
                    let conversation = flow.claude_session_id.clone();
                    flow.dialog = Some(DialogCall { call, at: self.clock.now_ms(), conversation });
                    let change = PtyConversationChange {
                        session_id: session.id.clone(),
                        claude_session_id: flow.claude_session_id.clone(),
                    };
                    self.bus.publish(&PTY_CONVERSATION, &change);
                }
                _ => {}
            }
        }
        if changed {
            self.bus.publish(&PTY_SESSION, &session.public(flow));
        }
    }

    fn publish_pending(&self, session: &Session, flow: &mut Flow) {
        if flow.pending.is_empty() {
            return;
        }
        let data = std::mem::take(&mut flow.pending);
        flow.seq += 1;
        flow.screen.write(&data);
        flow.unsettled += 1;
        let frame = PtyData { session_id: session.id.clone(), number: session.number, seq: flow.seq, data };
        self.bus.publish(&PTY_DATA, &frame);
    }

    /// Opens (or re-opens) the window in which further output is joined. When
    /// it closes, what accumulated goes out as one frame; if nothing did, the
    /// next byte is a first byte again.
    fn open_window(self: &Arc<Self>, session: &Arc<Session>, flow: &mut Flow) {
        flow.windows += 1;
        let window = flow.windows;
        flow.window = Some(window);
        let (inner, session) = (Arc::downgrade(self), Arc::downgrade(session));
        let timers = match session.upgrade() {
            Some(session) => session.timers.clone(),
            None => return,
        };
        timers.spawn(async move {
            tokio::time::sleep(FLUSH_WINDOW).await;
            let (Some(inner), Some(session)) = (inner.upgrade(), session.upgrade()) else { return };
            let mut flow = session.flow();
            if flow.window == Some(window) {
                flow.window = None;
                inner.publish_pending(&session, &mut flow);
            }
        });
    }

    /// Waits until the event lane has delivered what this terminal published.
    fn settle(&self) {
        let (done, delivered) = std::sync::mpsc::channel::<()>();
        let posted = self.bus.lane().post(move || {
            let _ = done.send(());
        });
        if posted.is_ok() {
            // A lane that is stopping never runs the job; the sender is then dropped.
            let _ = delivered.recv();
        }
    }
}

/// A session's end of its terminal. It holds the session weakly: a session
/// taken off the registry lets go of its terminal, which ends the shell.
struct Sink {
    session: Weak<Session>,
    inner: Weak<Inner>,
}

impl PtyEvents for Sink {
    fn output(&mut self, text: &str) {
        let (Some(inner), Some(session)) = (self.inner.upgrade(), self.session.upgrade()) else { return };
        let settle = {
            let mut flow = session.flow();
            if !flow.alive {
                return;
            }
            inner.apply_reports(&session, &mut flow, text);
            flow.pending.push_str(text);
            if flow.pending.len() >= FLUSH_BYTES {
                inner.publish_pending(&session, &mut flow);
                inner.open_window(&session, &mut flow);
            } else if flow.window.is_none() {
                // Nothing went out lately: this goes now, and opens the window.
                inner.publish_pending(&session, &mut flow);
                inner.open_window(&session, &mut flow);
            }
            let settle = flow.unsettled >= SETTLE_EVERY;
            if settle {
                flow.unsettled = 0;
            }
            settle
        };
        if settle {
            inner.settle();
        }
    }

    fn exit(&mut self, code: i32) {
        let (Some(inner), Some(session)) = (self.inner.upgrade(), self.session.upgrade()) else { return };
        // The registry first: a session being created is announced before it can end.
        let mut registry = inner.registry();
        let mut flow = session.flow();
        if !flow.alive {
            return;
        }
        // What the window still holds goes out ahead of the exit.
        inner.publish_pending(&session, &mut flow);
        flow.alive = false;
        flow.window = None;
        registry.sessions.shift_remove(&session.id);
        if registry.sessions.is_empty() {
            registry.next_number = 1;
        }
        inner
            .bus
            .publish(&PTY_EXIT, &PtyExit { session_id: session.id.clone(), number: session.number, exit_code: code });
    }
}
