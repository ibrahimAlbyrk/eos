//! The user's own Claude Code in a Code-mode pane (04 G34): its hooks run `eos memory hook`,
//! which asks here. The session's start gets the pack, a prompt a reminder when it matches, a
//! Bash, Edit, Write or Read about to run and a tool that failed a reminder when what was
//! learned speaks to it. The answer is the text for Claude Code's `additionalContext`.
//!
//! A pane is keyed by Claude's session id; its notes are never delivered twice in an epoch, as
//! in every chat. Nothing goes while the Reminders switch is off or the user withholds the
//! profile from Claude.

use std::sync::Arc;

use eos_core::BoxFuture;
use eos_core::store::Store;
use eos_core::terminal::PaneHooks;
use eos_domain::experience::cues;
use eos_domain::experience::render::ERROR_SEEN;
use eos_memory::deliver::How;
use eos_memory::{Cues, Situation};
use serde_json::Value;

use super::{Place, RECALL_LIMIT, Reminders, tool_call_moment};

/// The key of a pane's conversation among the chats.
pub(super) const PANE: &str = "pane:";
/// The backend kind a pane runs: the user's own Claude Code.
const PANE_KIND: &str = "claude";

impl Reminders {
    /// What a pane's hook `event` hands Claude Code for `input` (the hook's own input), if
    /// anything.
    pub(crate) async fn pane(&self, event: &str, input: &Value) -> Option<String> {
        let session = input["session_id"].as_str().filter(|s| !s.is_empty())?;
        let key = format!("{PANE}{session}");
        let on = self.store.read(|tx| Ok(eos_memory::settings::read_in(tx)?.reminders)).await;
        if !on.unwrap_or(false) || self.profile.get().sharing.withhold_from.iter().any(|k| k == PANE_KIND) {
            return None;
        }
        let root = input["cwd"].as_str().map(str::to_owned);
        let project = match root.as_deref() {
            Some(path) => Some(self.project_keys.to_key(path).await),
            None => None,
        };
        let place = Place { situation: Situation { routine: None, project, work_kind: None }, root, run: None };
        let moment = match event {
            "SessionStart" => return self.turn_notes_at(&key, &place, None, true).await.pop(),
            "UserPromptSubmit" => return self.turn_notes_at(&key, &place, input["prompt"].as_str(), false).await.pop(),
            "PreToolUse" => tool_call_moment(input["tool_name"].as_str()?, &input["tool_input"], place.root.as_deref()),
            "PostToolUseFailure" => {
                input["error"].as_str().and_then(cues::from_error).map(|cue| (ERROR_SEEN, vec![cue]))
            }
            _ => None,
        };
        let (header, hooks) = moment?;
        let recalled = self.recall.recall(&place.situation, &Cues { hooks, query: None }, RECALL_LIMIT).await.ok()?;
        let pack = self.pick(&key, header, &recalled)?;
        self.deliver(&key, &place, How::Reminder, &pack.note_ids).await;
        Some(pack.text)
    }
}

/// Whether a new pane gets the hooks: the app ships the command, and the Reminders switch is
/// on when the pane starts (D27).
pub struct PaneMemoryHooks {
    /// What a hook runs (`'<Eos.app>/Contents/Helpers/eos' memory hook`); `None` without it.
    pub command: Option<String>,
    pub store: Arc<dyn Store>,
}

impl std::fmt::Debug for PaneMemoryHooks {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PaneMemoryHooks").field("command", &self.command.is_some()).finish_non_exhaustive()
    }
}

impl PaneHooks for PaneMemoryHooks {
    fn memory_command(&self) -> BoxFuture<'_, Option<String>> {
        Box::pin(async move {
            let command = self.command.clone()?;
            let on = self.store.read(|tx| Ok(eos_memory::settings::read_in(tx)?.reminders)).await;
            on.unwrap_or(false).then_some(command)
        })
    }
}
