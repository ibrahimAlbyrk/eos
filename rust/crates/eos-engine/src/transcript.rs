//! A session's conversation, read for Eos: what a summarizer gets, the
//! prompts a rewind can go back to, and the recorded conversation a resumed
//! session continues (the engine's own, or one Claude Code wrote).

use std::path::Path;

use eos_agent_compat::{ClaudePaths, ClaudeSession, transcript_path};
use eos_agent_core::StoredMessage;
use eos_agent_types::{ContentBlock, Role, ToolResultContent};
use eos_contracts::RewindTarget;
use eos_core::agent::TranscriptEntry;
use eos_domain::message_id::strip_turn_head;
use eos_domain::time::iso_from_ms;

/// Text the harness wrote into the conversation, not something anyone said.
pub(crate) fn is_noise(text: &str) -> bool {
    text.starts_with("[Request interrupted")
        || text.starts_with("<local-command-stdout")
        || text.starts_with("<system-reminder>")
}

pub(crate) fn result_text(content: Option<&ToolResultContent>) -> String {
    match content {
        None => String::new(),
        Some(ToolResultContent::Text(text)) => text.clone(),
        Some(ToolResultContent::Blocks(blocks)) => {
            let parts: Vec<&str> = blocks
                .iter()
                .filter_map(|b| match b {
                    ContentBlock::Text { text, .. } => Some(text.as_str()),
                    b if b.kind() == Some("image") => Some("[image]"),
                    _ => None,
                })
                .filter(|t| !t.is_empty())
                .collect();
            parts.join("\n")
        }
    }
}

/// A visual answer's input is a whole view (up to ~90 KB) a summarizer has
/// no use for; what the user saw is its title and its summary.
fn view_text(name: &str, input: &str) -> Option<String> {
    let tool = name.strip_prefix("mcp__orchestrator__").or_else(|| name.strip_prefix("mcp__worker__"))?;
    if tool != "present" && tool != "present_app" {
        return None;
    }
    let input: serde_json::Value = serde_json::from_str(input).ok()?;
    let words = |key: &str| input.get(key).and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty());
    if input.get("title").is_none_or(|t| !t.is_string()) && input.get("summary").is_none_or(|s| !s.is_string()) {
        return None;
    }
    let head = words("title").unwrap_or("untitled");
    Some(match words("summary") {
        Some(summary) => format!("[view] {head} — {summary}"),
        None => format!("[view] {head}"),
    })
}

/// The conversation as a summarizer reads it (thinking dropped).
pub(crate) fn entries(messages: &[StoredMessage]) -> Vec<TranscriptEntry> {
    let mut out = Vec::new();
    for message in messages {
        let Ok(blocks) = message.blocks() else { continue };
        match message.role() {
            Role::User => {
                for block in blocks {
                    match block {
                        ContentBlock::Text { text, .. } if !text.trim().is_empty() && !is_noise(&text) => {
                            out.push(TranscriptEntry::User { text });
                        }
                        ContentBlock::ToolResult { content, is_error, .. } => {
                            out.push(TranscriptEntry::ToolResult { text: result_text(content.as_ref()), is_error });
                        }
                        _ => {}
                    }
                }
            }
            Role::Assistant => {
                for block in blocks {
                    match block {
                        ContentBlock::Text { text, .. } if !text.trim().is_empty() => {
                            out.push(TranscriptEntry::Assistant { text });
                        }
                        ContentBlock::ToolUse { name, input, .. } => {
                            let input = view_text(&name, input.get()).unwrap_or_else(|| input.get().to_owned());
                            out.push(TranscriptEntry::ToolCall { name, input });
                        }
                        _ => {}
                    }
                }
            }
            Role::System => {}
        }
    }
    out
}

/// What the user typed in `message`, if it is one of their prompts: not a
/// tool result, not a note of the harness, not a compaction's seed.
fn prompt_text(message: &StoredMessage) -> Option<String> {
    if message.role() != Role::User || message.is_meta() {
        return None;
    }
    let blocks = message.blocks().ok()?;
    let texts: Vec<&str> = blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Text { text, .. } if !text.trim().is_empty() && !is_noise(text) => Some(text.as_str()),
            _ => None,
        })
        .collect();
    if texts.is_empty() {
        return None;
    }
    Some(strip_turn_head(&texts.join("\n")).to_owned())
}

/// A typed command shows as the user typed it.
fn display_for(text: &str) -> String {
    let tag = |name: &str| {
        let open = format!("<{name}>");
        let start = text.find(&open)? + open.len();
        let end = text[start..].find(&format!("</{name}>"))?;
        let inner = &text[start..start + end];
        (!inner.contains('<')).then(|| inner.trim().to_owned())
    };
    match tag("command-name").filter(|n| !n.is_empty()) {
        None => text.to_owned(),
        Some(name) => match tag("command-args").filter(|a| !a.is_empty()) {
            Some(args) => format!("{name} {args}"),
            None => name,
        },
    }
}

/// A rewind target with where its prompt sits in the conversation.
pub(crate) struct Prompt {
    /// The messages before it: what a rewind to it keeps.
    pub(crate) keep: usize,
    pub(crate) target: RewindTarget,
}

/// The user's prompts, oldest first. A target's id is its position in the
/// conversation (`m<index>`), which holds until the conversation is cut.
pub(crate) fn prompts(messages: &[StoredMessage]) -> Vec<Prompt> {
    let found: Vec<(usize, String, String)> = messages
        .iter()
        .enumerate()
        .filter_map(|(i, m)| {
            let ts = m.recorded_ms().and_then(|ms| i64::try_from(ms).ok()).map(iso_from_ms).unwrap_or_default();
            prompt_text(m).map(|text| (i, text, ts))
        })
        .collect();
    let count = found.len();
    found
        .into_iter()
        .enumerate()
        .map(|(n, (keep, text, ts))| Prompt {
            keep,
            target: RewindTarget {
                uuid: format!("m{keep}"),
                display: display_for(&text),
                text,
                ts,
                up_count: i64::try_from(count - n).unwrap_or(i64::MAX),
            },
        })
        .collect()
}

/// A conversation Claude Code recorded for `session_id` in `cwd`, as the
/// messages a resumed session sends the model; `None` when there is none.
/// Thinking is signed for the model that wrote it, so it is kept only when
/// the session goes on with that very model.
pub(crate) fn claude_history(
    paths: &ClaudePaths,
    cwd: &Path,
    session_id: &str,
    model: &str,
) -> Option<Vec<StoredMessage>> {
    let path = transcript_path(paths, cwd, session_id);
    let session = ClaudeSession::read(&path).ok()?;
    if session.messages.is_empty() {
        return None;
    }
    let same_model = session.model.as_deref() == Some(model);
    Some(if same_model { session.messages } else { session.without_thinking() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::value::RawValue;

    fn text(text: &str) -> ContentBlock {
        ContentBlock::Text { text: text.into(), citations: None }
    }

    fn message(role: Role, blocks: &[ContentBlock]) -> StoredMessage {
        StoredMessage::new(role, blocks).expect("a message")
    }

    fn conversation() -> Vec<StoredMessage> {
        let input = |json: &str| RawValue::from_string(json.into()).expect("json");
        vec![
            message(
                Role::User,
                &[text("<system-reminder>context</system-reminder>"), text("<msg id=\"1\"/>\nfix the bug")],
            ),
            message(
                Role::Assistant,
                &[
                    ContentBlock::Thinking { thinking: "hmm".into(), signature: "s".into() },
                    text("on it"),
                    ContentBlock::ToolUse {
                        id: "t1".into(),
                        name: "Read".into(),
                        input: input(r#"{"file_path":"/x"}"#),
                    },
                    ContentBlock::ToolUse {
                        id: "t2".into(),
                        name: "mcp__worker__present".into(),
                        input: input(r#"{"title":"Places","summary":"three cafes","ui":"<Card/>"}"#),
                    },
                ],
            ),
            message(
                Role::User,
                &[
                    ContentBlock::ToolResult {
                        tool_use_id: "t1".into(),
                        content: Some(ToolResultContent::Text("data".into())),
                        is_error: false,
                    },
                    ContentBlock::ToolResult { tool_use_id: "t2".into(), content: None, is_error: true },
                ],
            ),
            message(Role::Assistant, &[text("done")]),
            message(Role::User, &[text("<command-name>/review</command-name><command-args>the parser</command-args>")]),
            message(Role::User, &[text("[Request interrupted by user]")]),
        ]
    }

    // core/src/__tests__/claude-transcript-view.test.ts, on the engine's messages
    #[test]
    fn a_conversation_reads_as_entries_without_thinking_or_harness_notes() {
        assert_eq!(
            entries(&conversation()),
            [
                TranscriptEntry::User { text: "<msg id=\"1\"/>\nfix the bug".into() },
                TranscriptEntry::Assistant { text: "on it".into() },
                TranscriptEntry::ToolCall { name: "Read".into(), input: r#"{"file_path":"/x"}"#.into() },
                TranscriptEntry::ToolCall {
                    name: "mcp__worker__present".into(),
                    input: "[view] Places — three cafes".into()
                },
                TranscriptEntry::ToolResult { text: "data".into(), is_error: false },
                TranscriptEntry::ToolResult { text: String::new(), is_error: true },
                TranscriptEntry::Assistant { text: "done".into() },
                TranscriptEntry::User {
                    text: "<command-name>/review</command-name><command-args>the parser</command-args>".into()
                },
            ]
        );
    }

    #[test]
    fn rewind_targets_are_the_users_prompts() {
        let found = prompts(&conversation());
        let seen: Vec<(usize, &str, &str, i64)> = found
            .iter()
            .map(|p| (p.keep, p.target.text.as_str(), p.target.display.as_str(), p.target.up_count))
            .collect();
        assert_eq!(
            seen,
            [
                (0, "fix the bug", "fix the bug", 2),
                (
                    4,
                    "<command-name>/review</command-name><command-args>the parser</command-args>",
                    "/review the parser",
                    1
                )
            ]
        );
        assert_eq!(found[1].target.uuid, "m4");
    }
}
