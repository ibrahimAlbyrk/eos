//! Message ids as the agent reads them: the head an operator's turn is
//! delivered with (`core/src/domain/message-id.ts`).

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

#[cfg(test)]
mod tests {
    use super::*;

    // core/src/__tests__/message-id.test.ts
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
    fn a_slash_command_is_told_from_a_path() {
        assert!(starts_with_slash_command("/compact now"));
        assert!(!starts_with_slash_command("/ not a command"));
        assert!(!starts_with_slash_command("say /hi"));
        assert!(!starts_with_slash_command("/"));
    }
}
