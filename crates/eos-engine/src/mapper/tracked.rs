//! The session's own tool calls that start something the mapper follows:
//! a subagent, a message that may wake one, a workflow, a command.
//!
//! The engine reports subagents and background tasks on channels of their
//! own, so their start can arrive before or after the result row of the call
//! that started them. Today's rows put the result first; an event that names
//! a call whose result is still out is held until it is recorded.

use std::collections::{HashMap, VecDeque};

use eos_contracts::UnknownRecord;
use eos_core::agent::BackgroundTaskKind;
use serde_json::Value;

/// How many calls are remembered. Older ones are forgotten: an event about
/// one is then recorded at once and a command shows with the engine's words.
const TRACKED_CALLS: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CallKind {
    Agent,
    /// A message to another agent: it wakes a subagent that had stopped.
    Wake,
    Workflow,
    Shell,
    Monitor,
}

struct Call {
    kind: CallKind,
    result_seen: bool,
    /// A wake that a subagent's new run was filed under.
    used: bool,
    title: Option<String>,
    command: Option<String>,
}

#[derive(Default)]
pub(crate) struct Calls {
    by_id: HashMap<String, Call>,
    order: VecDeque<String>,
}

fn words(input: &UnknownRecord, key: &str) -> Option<String> {
    input.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned)
}

impl Calls {
    pub(crate) fn note(&mut self, id: &str, name: &str, input: &UnknownRecord) {
        let Some(kind) = CallKind::of(name) else { return };
        let (title, command) = match kind {
            CallKind::Shell => (words(input, "description"), words(input, "command")),
            CallKind::Monitor => {
                let socket = input.get("ws").and_then(|ws| ws.get("url")).and_then(Value::as_str);
                let socket = socket.map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned);
                (words(input, "description"), words(input, "command").or(socket))
            }
            _ => (None, None),
        };
        if self.order.len() >= TRACKED_CALLS
            && let Some(oldest) = self.order.pop_front()
        {
            self.by_id.remove(&oldest);
        }
        self.order.push_back(id.to_owned());
        self.by_id.insert(id.to_owned(), Call { kind, result_seen: false, used: false, title, command });
    }

    pub(crate) fn result_seen(&mut self, id: &str) {
        if let Some(call) = self.by_id.get_mut(id) {
            call.result_seen = true;
        }
    }

    /// The call is known and its result row is not written yet.
    pub(crate) fn awaits_result(&self, id: &str) -> bool {
        self.by_id.get(id).is_some_and(|c| !c.result_seen)
    }

    /// The latest message call no subagent run was filed under yet.
    pub(crate) fn take_wake(&mut self) -> Option<String> {
        let id = self
            .order
            .iter()
            .rev()
            .find(|id| self.by_id.get(*id).is_some_and(|c| c.kind == CallKind::Wake && !c.used))?;
        let id = id.clone();
        if let Some(call) = self.by_id.get_mut(&id) {
            call.used = true;
        }
        Some(id)
    }

    /// What a background command's call said about it: its kind, its title
    /// and its command line.
    pub(crate) fn shell(&self, id: &str) -> (BackgroundTaskKind, Option<String>, Option<String>) {
        match self.by_id.get(id) {
            Some(call) if call.kind == CallKind::Monitor => {
                (BackgroundTaskKind::Monitor, call.title.clone(), call.command.clone())
            }
            Some(call) => (BackgroundTaskKind::Shell, call.title.clone(), call.command.clone()),
            None => (BackgroundTaskKind::Shell, None, None),
        }
    }
}
