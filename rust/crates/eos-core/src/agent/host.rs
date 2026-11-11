//! What the engine asks of the rest of Eos while a session runs: its system
//! prompt, Eos's own tools, and the user's answers. (Permissions are
//! [`crate::policy::PolicyDecider`], credentials
//! [`crate::accounts::SessionCredentials`].)

use std::sync::Arc;

use eos_contracts::UnknownRecord;
use serde_json::Value;

use super::session::LaunchSpec;
use crate::BoxFuture;

/// Assembles a session's system prompt at the spawn chokepoint, from the
/// facts of the session that never change while it runs.
pub trait PromptAssembler: Send + Sync + 'static {
    /// The text that follows the engine's own system prompt; `None` when no
    /// fragment applies. `spec.system_prompt` is ignored.
    fn system_prompt(&self, spec: &LaunchSpec) -> Option<String>;
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
