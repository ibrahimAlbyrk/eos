//! Commands Eos itself runs when the user types them (`/clear`, and the ones
//! features add: `/compact`, …), caught before a message is delivered
//! (`core/src/domain/slash-command.ts`, `commands/clear.ts`).
//!
//! A typed `/name args` whose name is registered, whose worker has a live
//! session and whose command accepts the arguments runs here and never
//! reaches the agent. Anything else is delivered as typed (the agent's own
//! commands and skills).

use std::sync::Arc;

use eos_contracts::WorkerEventType;
use eos_contracts::stream::topics::WORKER_CHANGE;
use eos_core::agent::{AgentCapabilities, AgentSession};
use eos_core::{BoxFuture, Error};
use serde_json::{Value, json};

use crate::service::Sessions;

/// What a command runs with.
pub struct SlashContext<'a> {
    pub worker_id: &'a str,
    /// What followed the command's name, trimmed.
    pub args: &'a str,
    pub session: Arc<dyn AgentSession>,
    pub sessions: &'a Sessions,
}

impl std::fmt::Debug for SlashContext<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SlashContext")
            .field("worker_id", &self.worker_id)
            .field("args", &self.args)
            .finish_non_exhaustive()
    }
}

/// What a command answers its sender: the status and the body it chose
/// (`/compact` answers 202 while it summarizes, 409 when it cannot).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandAnswer {
    pub status: u16,
    pub body: Value,
}

impl CommandAnswer {
    pub fn new(status: u16, body: Value) -> Self {
        Self { status, body }
    }

    /// 200 with `body`.
    pub fn ok(body: Value) -> Self {
        Self { status: 200, body }
    }
}

/// One command of Eos's own. A feature registers its own through its
/// module (`Module::slash_commands`, as `Arc<dyn SlashCommand>`).
pub trait SlashCommand: Send + Sync + 'static {
    /// Matched without the leading slash.
    fn name(&self) -> &'static str;
    fn aliases(&self) -> &'static [&'static str] {
        &[]
    }
    /// For the composer's menu.
    fn description(&self) -> &'static str;
    /// Whether the command runs for these arguments on a session that can
    /// do this much; `false` lets the text go to the agent as typed.
    fn accepts(&self, args: &str, capabilities: &AgentCapabilities) -> bool;
    /// Runs it; the answer is what the sender gets. A refusal the sender can
    /// read is an answer too (its own status); an `Err` is a failure.
    fn execute<'a>(&'a self, cx: SlashContext<'a>) -> BoxFuture<'a, Result<CommandAnswer, Error>>;
}

/// `/name args` → `(name, args)`.
pub(crate) fn parse(text: &str) -> Option<(&str, &str)> {
    let rest = text.trim().strip_prefix('/')?;
    let (name, args) = rest.split_once(' ').map_or((rest, ""), |(name, args)| (name, args.trim()));
    (!name.is_empty()).then_some((name, args))
}

/// `/clear`: the agent starts over with an empty conversation and the chat
/// folds what came before.
pub(crate) struct Clear;

impl SlashCommand for Clear {
    fn name(&self) -> &'static str {
        "clear"
    }

    fn description(&self) -> &'static str {
        "Clear conversation history (agent context + chat)"
    }

    fn accepts(&self, args: &str, capabilities: &AgentCapabilities) -> bool {
        args.is_empty() && capabilities.context_clear == Some(true)
    }

    fn execute<'a>(&'a self, cx: SlashContext<'a>) -> BoxFuture<'a, Result<CommandAnswer, Error>> {
        Box::pin(async move {
            let cleared = cx.session.clear_context().await.is_ok();
            let (id, now) = (cx.worker_id.to_owned(), cx.sessions.clock().now_ms());
            // A fresh conversation knows nothing of the consultations of the old one.
            cx.sessions.0.peers.cancel_by_worker(cx.worker_id);
            cx.sessions
                .store()
                .write(move |tx, out| {
                    // What was queued, the task list and the context size belonged to the old conversation.
                    tx.message_queue().clear_pending(&id)?;
                    tx.workers().set_tasks(&id, None)?;
                    tx.workers().set_context_tokens(&id, 0)?;
                    let note = json!({"via": "slash-command"});
                    let row = tx.events().append_json(&id, now, WorkerEventType::ConversationCleared, &note)?;
                    out.push(WORKER_CHANGE, &json!({"workerId": id, "rowId": row, "type": "conversation_cleared"}));
                    Ok(())
                })
                .await?;
            Ok(CommandAnswer::ok(json!({"ok": cleared, "cleared": true})))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_command_is_its_name_and_what_follows() {
        assert_eq!(parse("/clear"), Some(("clear", "")));
        assert_eq!(parse("  /compact  keep the plan  "), Some(("compact", "keep the plan")));
        assert_eq!(parse("/"), None);
        assert_eq!(parse("clear"), None);
    }
}
