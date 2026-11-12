//! What the engine asks of the rest of Eos while a session runs: its system
//! prompt, Eos's own tools, and the user's answers. (Permissions are
//! [`crate::policy::PolicyDecider`], credentials
//! [`crate::accounts::SessionCredentials`].)

use std::sync::Arc;

use eos_contracts::{SessionFactsRole, UnknownRecord};
use serde_json::Value;

use super::session::LaunchSpec;
use crate::BoxFuture;

/// What a session is, as its system prompt depends on it: the facts that
/// never change while the session runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnFacts {
    pub worker_id: String,
    pub role: SessionFactsRole,
    pub parent_id: Option<String>,
    pub name: Option<String>,
    /// A tier, an alias or a model id, as asked for.
    pub model: String,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    pub cwd: Option<String>,
    pub worktree_dir: Option<String>,
    /// The repository a worktree was made from.
    pub worktree_from: Option<String>,
    pub branch: Option<String>,
    /// The session works in another session's worktree.
    pub attached: bool,
    pub collaborate: bool,
    pub worker_definition: Option<String>,
    pub backend_profile: Option<String>,
}

/// Assembles a session's system prompt at the spawn chokepoint.
pub trait PromptAssembler: Send + Sync + 'static {
    /// The text that follows the engine's own system prompt; `None` when no
    /// fragment applies.
    fn system_prompt(&self, facts: &SpawnFacts) -> Option<String>;
}

/// One of Eos's own tools as the model sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolDefinition {
    /// The name on the wire (`mcp__worker__read_page`).
    pub name: String,
    pub description: String,
    /// JSON Schema of the input.
    pub input_schema: Value,
    /// Kept behind tool search (found by its name, description and
    /// `search_hint`) instead of being sent with every request.
    pub deferred: bool,
    pub search_hint: Option<String>,
    /// Only the session's own agent may call it, never a subagent.
    pub main_agent_only: bool,
}

/// Who is calling a tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolCaller<'a> {
    /// The session's worker.
    pub worker_id: &'a str,
    /// The model's id for this call.
    pub call_id: &'a str,
    /// Set when a subagent of the session makes the call.
    pub subagent_id: Option<&'a str>,
}

/// An image a tool hands back beside its text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolImage {
    pub media_type: String,
    /// Base64.
    pub data: String,
}

/// What a tool hands back to the model.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ToolReply {
    pub text: String,
    pub is_error: bool,
    pub images: Vec<ToolImage>,
}

impl ToolReply {
    pub fn text(text: impl Into<String>) -> Self {
        Self { text: text.into(), is_error: false, images: Vec::new() }
    }

    pub fn error(text: impl Into<String>) -> Self {
        Self { text: text.into(), is_error: true, images: Vec::new() }
    }
}

/// A tool Eos implements. One value serves every session; who calls arrives
/// with the call. The future is dropped when the turn is interrupted.
pub trait HostTool: Send + Sync + 'static {
    fn definition(&self) -> &ToolDefinition;
    fn call<'a>(&'a self, caller: ToolCaller<'a>, input: Value) -> BoxFuture<'a, ToolReply>;
}

/// Eos's tools for a session. Sessions with equal answers should get the
/// same `Arc`s: the engine then shares one serialized tool list between them.
pub trait ToolSets: Send + Sync + 'static {
    fn for_session(&self, spec: &LaunchSpec) -> Vec<Arc<dyn HostTool>>;
}

/// The user, for a focused session's own question tool.
pub trait UserQuestions: Send + Sync + 'static {
    /// Shows `questions` (as the tool got them) and resolves with the answers
    /// by question text, or `None` when the user turned them away or the
    /// session ended first.
    fn ask<'a>(
        &'a self,
        worker_id: &'a str,
        call_id: Option<&'a str>,
        questions: Vec<UnknownRecord>,
    ) -> BoxFuture<'a, Option<UnknownRecord>>;
}

/// A message sent to a worker in the user's name by a feature (a click in a
/// visual answer).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct UserMessage {
    /// What the agent reads.
    pub text: String,
    /// What the chat shows instead of `text`.
    pub display_text: Option<String>,
    /// What the chat's reply chip is drawn from.
    pub action: Option<Value>,
}

/// Sending a worker a message as the user. Implemented by the session
/// service; a feature that needs only this holds only this.
pub trait UserMessages: Send + Sync + 'static {
    /// Delivers `message`, or queues it while the worker is busy. Fails
    /// when there is no such worker or its session cannot be reached.
    fn send<'a>(&'a self, worker_id: &'a str, message: UserMessage) -> BoxFuture<'a, Result<(), crate::Error>>;
}

/// The folders of chats that were started without one: each gets a scratch
/// folder of its own, deleted with the chat.
pub trait ScratchFolders: Send + Sync + 'static {
    /// Makes the scratch folder of worker `id` and returns its path.
    fn create<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<String, crate::Error>>;
    /// Deletes a scratch folder and what Claude Code kept about it. A folder
    /// this did not make is left alone.
    fn remove<'a>(&'a self, dir: &'a str) -> BoxFuture<'a, ()>;
    /// Every scratch folder on disk.
    fn list(&self) -> Vec<String>;
}
