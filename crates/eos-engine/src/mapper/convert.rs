//! Engine values as canonical ones.

use eos_agent_core::ToolOutput;
use eos_agent_types::{ContentBlock as EngineBlock, ToolResultContent, Usage};
use eos_contracts::primitives::{BoolLit, Num};
use eos_contracts::{
    AgentEvent, AgentMessageEvent, AgentMessageEventRole, CanonicalUsage, ContentBlock, ReasoningBlock, TextBlock,
    ToolCallBlock, ToolResultBlock, TurnEvent, TurnEventPhase, UnknownRecord, UsageEvent, parse_structured_patch,
};
use indexmap::IndexMap;
use serde_json::Value;

pub(super) fn turn(phase: TurnEventPhase, reason: Option<&str>) -> AgentEvent {
    AgentEvent::Turn(TurnEvent { phase, reason: reason.map(str::to_owned) })
}

pub(super) fn assistant(blocks: Vec<ContentBlock>) -> AgentEvent {
    AgentEvent::Message(AgentMessageEvent { role: AgentMessageEventRole::Assistant, blocks, model: None })
}

pub(super) fn text_block(text: String, block_id: String) -> ContentBlock {
    ContentBlock::Text(TextBlock { text, block_id: Some(block_id), msg_id: None })
}

pub(super) fn text(text: String, block_id: String) -> AgentEvent {
    assistant(vec![text_block(text, block_id)])
}

pub(super) fn reasoning_block(text: String, block_id: String, interrupted: bool) -> ContentBlock {
    ContentBlock::Reasoning(ReasoningBlock {
        text,
        redacted: None,
        block_id: Some(block_id),
        interrupted: interrupted.then_some(true),
    })
}

/// The name the engine's subagent tool goes by; such a call folds its
/// subagent's inner tools under it in the chat.
const SUBAGENT_TOOL: &str = "Agent";

pub(super) fn tool_call(call_id: String, name: String, input: UnknownRecord) -> AgentEvent {
    let spawns_subagent = (name == SUBAGENT_TOOL).then_some(BoolLit::<true>);
    assistant(vec![ContentBlock::ToolCall(ToolCallBlock {
        call_id,
        name,
        input,
        parent_call_id: None,
        spawns_subagent,
    })])
}

/// A tool's input as a record; anything that is not a JSON object reads as empty.
pub(super) fn object_of(json: &str) -> UnknownRecord {
    serde_json::from_str::<UnknownRecord>(json).unwrap_or_default()
}

/// The text of a tool result: the string itself, or its text parts joined.
pub(super) fn result_text(content: &ToolResultContent) -> String {
    match content {
        ToolResultContent::Text(text) => text.clone(),
        ToolResultContent::Blocks(blocks) => blocks
            .iter()
            .filter_map(|b| match b {
                EngineBlock::Text { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect(),
    }
}

/// A top-level tool's result. An edit's hunks (absolute line numbers) ride
/// the result's details, which only the host sees.
pub(super) fn tool_result(call_id: &str, output: &ToolOutput) -> AgentEvent {
    let patch = output
        .details
        .as_ref()
        .and_then(|d| serde_json::from_str::<Value>(d.get()).ok())
        .and_then(|d| d.get("structuredPatch").and_then(parse_structured_patch));
    AgentEvent::Message(AgentMessageEvent {
        role: AgentMessageEventRole::Tool,
        blocks: vec![ContentBlock::ToolResult(ToolResultBlock {
            call_id: call_id.to_owned(),
            is_error: output.is_error,
            content: result_text(&output.content),
            patch,
        })],
        model: None,
    })
}

/// The tokens of a turn's requests, summed: what is billed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct TurnUsage {
    input: u64,
    output: u64,
    cache_read: u64,
    write_5m: u64,
    write_1h: u64,
}

impl TurnUsage {
    pub(super) fn add(&mut self, usage: &Usage) {
        self.input += usage.input_tokens.unwrap_or(0);
        self.output += usage.output_tokens.unwrap_or(0);
        self.cache_read += usage.cache_read_input_tokens.unwrap_or(0);
        // Cache writes are priced by lifetime: the per-tier split when the
        // API gives one, else the flat total as the short tier.
        match &usage.cache_creation {
            Some(tiers) if tiers.ephemeral_5m_input_tokens > 0 || tiers.ephemeral_1h_input_tokens > 0 => {
                self.write_5m += tiers.ephemeral_5m_input_tokens;
                self.write_1h += tiers.ephemeral_1h_input_tokens;
            }
            _ => self.write_5m += usage.cache_creation_input_tokens.unwrap_or(0),
        }
    }

    pub(super) fn take(&mut self) -> Self {
        std::mem::take(self)
    }

    /// `model: None` is the session's own model (the row's), as today's
    /// turn usage is recorded; a subagent on another model names it.
    pub(super) fn event(self, model: Option<String>) -> AgentEvent {
        let mut writes: IndexMap<String, Num> = IndexMap::new();
        if self.write_5m > 0 {
            writes.insert("5m".into(), self.write_5m.into());
        }
        if self.write_1h > 0 {
            writes.insert("1h".into(), self.write_1h.into());
        }
        AgentEvent::Usage(UsageEvent {
            usage: CanonicalUsage {
                input_tokens: self.input.into(),
                output_tokens: self.output.into(),
                cache_read_tokens: self.cache_read.into(),
                cache_write_tokens: writes,
                model: Some(model),
            },
        })
    }
}
