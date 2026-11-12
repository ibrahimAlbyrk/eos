//! `/compact [focus]`: summarize the conversation and continue from the
//! summary (`core/src/domain/commands/compact.ts`). The summarizer can take
//! minutes, so the command only starts the run; its progress reaches the
//! dashboard through the `compaction_*` rows. On a session that cannot be
//! compacted the text goes to the agent as typed.

use eos_core::agent::AgentCapabilities;
use eos_core::{BoxFuture, Error};
use eos_sessions::{SlashCommand, SlashContext};
use serde_json::{Value, json};

use crate::service::CompactionService;

pub(crate) struct Compact(pub(crate) CompactionService);

impl SlashCommand for Compact {
    fn name(&self) -> &'static str {
        "compact"
    }

    fn description(&self) -> &'static str {
        "Summarize the conversation into a fresh context (text after the command steers the summary)"
    }

    fn accepts(&self, _args: &str, capabilities: &AgentCapabilities) -> bool {
        capabilities.context_compaction == Some(true)
    }

    fn execute<'a>(&'a self, cx: SlashContext<'a>) -> BoxFuture<'a, Result<Value, Error>> {
        Box::pin(async move {
            match self.0.start(cx.worker_id, cx.args).await {
                Ok(()) => Ok(json!({"ok": true, "compacting": true})),
                Err(why) => Err(Error::Conflict(why)),
            }
        })
    }
}
