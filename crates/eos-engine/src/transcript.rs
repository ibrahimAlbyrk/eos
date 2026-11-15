//! A session's conversation, read for Eos: the prompts a rewind can go back
//! to, and the recorded conversation a resumed session continues (the
//! engine's own, or one Claude Code wrote).

use eos_agent_compat::ClaudeSession;
use eos_agent_core::StoredMessage;
use eos_agent_types::{ContentBlock, Role, ToolResultContent};
use eos_contracts::RewindTarget;
use eos_domain::compaction::SUMMARY_OPEN;
use eos_domain::message_id::strip_turn_head;
use eos_domain::reaction::is_reaction_turn;
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
    if texts.is_empty() || texts.iter().any(|t| t.contains(SUMMARY_OPEN)) {
        return None;
    }
    let text = texts.join("\n");
    // A turn of nothing but the user's reactions is not something they typed.
    if is_reaction_turn(&text) {
        return None;
    }
    Some(strip_turn_head(&text).to_owned())
}

/// Whether `message` is one of the user's prompts.
pub(crate) fn is_prompt(message: &StoredMessage) -> bool {
    prompt_text(message).is_some()
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

/// A conversation Claude Code recorded, as the messages a resumed session
/// sends the model. Thinking is signed for the model that wrote it, so it is
/// kept only when the session goes on with that very model.
pub(crate) fn claude_messages(session: ClaudeSession, model: &str) -> Vec<StoredMessage> {
    let same_model = session.model.as_deref() == Some(model);
    if same_model { session.messages } else { session.without_thinking() }
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
                        name: "present".into(),
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

    #[test]
    fn a_turn_of_the_users_reactions_is_no_prompt_to_rewind_to() {
        let reacted = "<reaction emoji=\"👍\" on=\"yours\">done</reaction>";
        let mut conversation = conversation();
        conversation.push(message(Role::User, &[text(reacted)]));
        conversation.push(message(Role::User, &[text(&format!("<msg id=\"2\"/>\n{reacted}\nand next?"))]));
        let found = prompts(&conversation);
        let texts: Vec<&str> = found.iter().map(|p| p.target.text.as_str()).collect();
        assert_eq!(texts[2..], ["and next?"], "the reactions a message came with are its head");
        assert_eq!(found.len(), 3);
    }
}
