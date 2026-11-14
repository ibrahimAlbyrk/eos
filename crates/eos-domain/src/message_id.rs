//! Message ids as the agent reads them: the head an operator's turn is
//! delivered with, and the message a reply points at.

use eos_contracts::{ReplyRef, ReplyRefRole};
use serde_json::Value;

use crate::envelope::escape_tag_body;

/// A leading slash command must stay the very first token (the agent's own
/// command parser only looks there), so such a turn takes no id head.
pub fn starts_with_slash_command(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next() == Some('/') && chars.next().is_some_and(|c| !c.is_whitespace())
}

/// Head of an operator turn: the id marker, then the reply block (if any).
pub fn prefix_operator_turn(body: &str, msg_id: Option<i64>, reply_block: Option<&str>) -> String {
    let mut out = String::new();
    if let Some(id) = msg_id {
        out.push_str(&format!("<msg id=\"{id}\"/>\n"));
    }
    if let Some(block) = reply_block.filter(|b| !b.is_empty()) {
        out.push_str(block);
        out.push('\n');
    }
    out.push_str(body);
    out
}

fn strip_msg_head(text: &str) -> &str {
    let Some(rest) = text.strip_prefix("<msg id=\"") else { return text };
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return text;
    }
    rest[digits..].strip_prefix("\"/>\n").unwrap_or(text)
}

fn strip_reply_head(text: &str) -> &str {
    let Some(rest) = text.strip_prefix("<reply_to") else { return text };
    // `<reply_to` must end the tag name: a space, `/` or `>` follows.
    if !rest.starts_with([' ', '/', '>']) {
        return text;
    }
    let Some(close) = rest.find('>') else { return text };
    if rest[..close].ends_with('/') {
        return rest[close + 1..].strip_prefix('\n').unwrap_or(text);
    }
    match rest[close + 1..].find("</reply_to>\n") {
        Some(end) => &rest[close + 1 + end + "</reply_to>\n".len()..],
        None => text,
    }
}

/// Removes the head [`prefix_operator_turn`] added: what the operator typed,
/// read back out of the agent's conversation.
pub fn strip_turn_head(text: &str) -> &str {
    strip_reply_head(strip_msg_head(text))
}

/// How much of a message a reply quotes when the agent still has it in its
/// context, and the most it quotes when it does not.
const EXCERPT_CHARS: usize = 160;
const WHOLE_UP_TO_CHARS: usize = 280;
const FULL_TEXT_CAP_CHARS: usize = 4000;

/// The message a reply points at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplyTarget {
    pub row_id: i64,
    pub msg_id: Option<String>,
    pub role: ReplyRefRole,
    pub text: String,
}

/// JavaScript measures and cuts strings in UTF-16 units; so do these.
fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

fn first_units(text: &str, max: usize) -> String {
    let mut taken = 0;
    text.chars()
        .take_while(|c| {
            taken += c.len_utf16();
            taken <= max
        })
        .collect()
}

/// A message on one line, cut at a word when it is long.
pub fn excerpt(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if units(&flat) <= EXCERPT_CHARS {
        return flat;
    }
    let cut = first_units(&flat, EXCERPT_CHARS);
    let at_word = cut.rfind(' ').filter(|at| units(&cut[..*at]) * 10 > EXCERPT_CHARS * 6);
    format!("{}…", at_word.map_or(cut.as_str(), |at| &cut[..at]))
}

/// The row a reply points at as a target; `None` for a row that is not a
/// message (or says nothing).
pub fn reply_target_from_row(row_id: i64, kind: &str, payload: Option<&str>) -> Option<ReplyTarget> {
    let payload: Value = serde_json::from_str(payload?).ok()?;
    let own = |role: ReplyRefRole| {
        let text = payload.get("text")?.as_str()?.to_owned();
        let msg_id = payload.get("msgId").and_then(Value::as_str).map(str::to_owned);
        (!text.trim().is_empty()).then_some(ReplyTarget { row_id, msg_id, role, text })
    };
    match kind {
        "user_message" => own(ReplyRefRole::User),
        "orchestrator_message" | "worker_report" | "peer_request" => own(ReplyRefRole::Agent),
        "report_reminder" | "permission_ask" => own(ReplyRefRole::System),
        "agent_event" => {
            if payload.get("type")?.as_str()? != "message" || payload.get("role")?.as_str()? != "assistant" {
                return None;
            }
            let said: Vec<&Value> = payload
                .get("blocks")?
                .as_array()?
                .iter()
                .filter(|b| b["type"] == "text" && b["text"].as_str().is_some_and(|t| !t.trim().is_empty()))
                .collect();
            let text = said.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n");
            let msg_id = said.iter().find_map(|b| b["msgId"].as_str()).map(str::to_owned);
            (!text.trim().is_empty()).then_some(ReplyTarget { row_id, msg_id, role: ReplyRefRole::Assistant, text })
        }
        _ => None,
    }
}

/// What the agent reads of the message a turn replies to. A message it
/// still has in context and knows by id is only named; anything else is
/// quoted (whole when short or when it left the context, else an excerpt).
pub fn build_reply_block(target: &ReplyTarget, in_context: bool) -> String {
    let id = target.msg_id.as_deref().map(|id| format!(" id=\"{id}\"")).unwrap_or_default();
    if in_context && target.msg_id.is_some() && target.role != ReplyRefRole::Assistant {
        return format!("<reply_to{id}/>");
    }
    let body = if !in_context {
        if units(&target.text) <= FULL_TEXT_CAP_CHARS {
            target.text.clone()
        } else {
            format!("{}…", first_units(&target.text, FULL_TEXT_CAP_CHARS))
        }
    } else if units(&target.text) <= WHOLE_UP_TO_CHARS {
        target.text.clone()
    } else {
        excerpt(&target.text)
    };
    format!("<reply_to{id}>{}</reply_to>", escape_tag_body(&body))
}

/// What the replying message's row keeps of its target, for the chat.
pub fn reply_ref_of(target: &ReplyTarget) -> ReplyRef {
    ReplyRef { row_id: target.row_id, msg_id: target.msg_id.clone(), role: target.role, excerpt: excerpt(&target.text) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_turn_head_is_added_and_taken_off_again() {
        assert_eq!(prefix_operator_turn("hello", Some(12), None), "<msg id=\"12\"/>\nhello");
        assert_eq!(prefix_operator_turn("hello", None, None), "hello");
        let replied = prefix_operator_turn("yes", Some(3), Some("<reply_to id=\"2.1\">the plan</reply_to>"));
        assert_eq!(replied, "<msg id=\"3\"/>\n<reply_to id=\"2.1\">the plan</reply_to>\nyes");
        assert_eq!(strip_turn_head(&replied), "yes");
        assert_eq!(strip_turn_head("<msg id=\"12\"/>\nhello"), "hello");
        assert_eq!(strip_turn_head("<reply_to id=\"2\"/>\nhello"), "hello");
        assert_eq!(strip_turn_head("<reply_to>multi\nline</reply_to>\nhello"), "hello");
        assert_eq!(strip_turn_head("<msg id=\"x\"/>\nhello"), "<msg id=\"x\"/>\nhello", "not a head");
        assert_eq!(strip_turn_head("<reply_tox/>\nhello"), "<reply_tox/>\nhello");
        assert_eq!(strip_turn_head("plain"), "plain");
    }

    #[test]
    fn a_reply_names_or_quotes_its_target() {
        let user = reply_target_from_row(7, "user_message", Some(r#"{"text":"ship it <msg id=\"1\"/>","msgId":"3"}"#));
        let user = user.expect("a target");
        assert_eq!(build_reply_block(&user, true), "<reply_to id=\"3\"/>", "known by id and still in context");
        assert_eq!(build_reply_block(&user, false), "<reply_to id=\"3\">ship it &lt;msg id=\"1\"/></reply_to>");
        let assistant = reply_target_from_row(
            9,
            "agent_event",
            Some(r#"{"type":"message","role":"assistant","blocks":[{"type":"text","text":"Done.","msgId":"3.1"},{"type":"tool_call","callId":"t","name":"Read","input":{}},{"type":"text","text":"See it."}]}"#),
        )
        .expect("a target");
        assert_eq!((assistant.text.as_str(), assistant.msg_id.as_deref()), ("Done.\nSee it.", Some("3.1")));
        assert_eq!(
            build_reply_block(&assistant, true),
            "<reply_to id=\"3.1\">Done.\nSee it.</reply_to>",
            "its own words are quoted"
        );
        let long = ReplyTarget { row_id: 1, msg_id: None, role: ReplyRefRole::Agent, text: "word ".repeat(100) };
        let quoted = build_reply_block(&long, true);
        assert!(quoted.ends_with("…</reply_to>") && quoted.len() < 200, "{quoted}");
        assert_eq!(reply_ref_of(&user).excerpt, "ship it <msg id=\"1\"/>");
        assert_eq!(reply_ref_of(&long).excerpt.chars().count(), 160, "cut at a word, with an ellipsis");
        assert!(reply_target_from_row(1, "state", Some("{}")).is_none());
        assert!(reply_target_from_row(1, "user_message", Some(r#"{"text":"  "}"#)).is_none());
        assert!(reply_target_from_row(1, "agent_event", Some(r#"{"type":"turn","phase":"ended"}"#)).is_none());
    }

    #[test]
    fn a_slash_command_is_told_from_a_path() {
        assert!(starts_with_slash_command("/compact now"));
        assert!(!starts_with_slash_command("/ not a command"));
        assert!(!starts_with_slash_command("say /hi"));
        assert!(!starts_with_slash_command("/"));
    }
}
