//! What no reader should see: the wrappers that tell the model who is
//! speaking (`core/src/domain/sender-tag.ts`, `manager/shared/display-sanitize.ts`).
//!
//! A message delivered to an agent is wrapped in `<agent_message …>` or
//! `<system_message …>`, and an operator turn may start with `<msg id="…"/>`
//! and a `<reply_to>` block. Stored rows keep them (a resume replays them);
//! every surface that shows text strips them from a copy.

use std::borrow::Cow;
use std::sync::LazyLock;

use regress::Regex;
use serde_json::Value;

use crate::event::EventRecord;

fn regex(pattern: &str) -> Regex {
    match Regex::new(pattern) {
        Ok(re) => re,
        Err(e) => panic!("a built-in pattern does not compile: {e}"),
    }
}

/// The id marker and the reply block heading an operator turn.
static TURN_HEAD: LazyLock<Regex> =
    LazyLock::new(|| regex(r#"<msg id="[^"]*"/>\n?|<reply_to\b[^>]*/>\n?|<reply_to\b[^>]*>[\s\S]*?</reply_to>\n?"#));
static WRAPPER: LazyLock<Regex> = LazyLock::new(|| regex(r"<(agent_message|system_message)\b[^>]*>([\s\S]*?)</\1>"));
/// A reserved tag inside a wrapped body was written with its `<` escaped.
static ESCAPED_TAG: LazyLock<Regex> =
    LazyLock::new(|| regex(r"&lt;(/?(?:agent_message|system_message|msg|reply_to)\b)"));

/// `text` with every match replaced by what `with` returns for it.
fn replace_all(re: &Regex, text: &str, with: impl Fn(&regress::Match) -> String) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for m in re.find_iter(text) {
        out.push_str(&text[last..m.start()]);
        out.push_str(&with(&m));
        last = m.end();
    }
    out.push_str(&text[last..]);
    out
}

/// `text` without sender wrappers and turn headers, wherever they sit; a
/// wrapped body comes back as it was before wrapping. Text without any is
/// returned as it is.
pub fn strip_sender_tags(text: &str) -> Cow<'_, str> {
    if !["<agent_message", "<system_message", "<msg ", "<reply_to"].iter().any(|tag| text.contains(tag)) {
        return Cow::Borrowed(text);
    }
    let headless = replace_all(&TURN_HEAD, text, |_| String::new());
    let unwrapped = replace_all(&WRAPPER, &headless, |m| {
        let body = m.group(2).map_or("", |range| &headless[range]);
        // Wrapping put the body on its own lines: one newline each side.
        let body = body.strip_prefix('\n').unwrap_or(body);
        let body = body.strip_suffix('\n').unwrap_or(body);
        replace_all(&ESCAPED_TAG, body, |tag| format!("<{}", tag.group(1).map_or("", |range| &body[range])))
    });
    Cow::Owned(unwrapped)
}

/// Strips every string inside `value`.
pub fn sanitize_value(value: &mut Value) {
    match value {
        Value::String(text) => {
            if let Cow::Owned(stripped) = strip_sender_tags(text) {
                *text = stripped;
            }
        }
        Value::Array(items) => items.iter_mut().for_each(sanitize_value),
        Value::Object(fields) => fields.values_mut().for_each(sanitize_value),
        // JavaScript prints a whole number without a fraction; a payload that
        // is written again must read as today's does.
        Value::Number(n) if n.is_f64() => {
            if let Some(whole) = n.as_f64().filter(|f| f.fract() == 0.0 && f.abs() < 9.0e15) {
                *n = serde_json::Number::from(whole as i64);
            }
        }
        _ => {}
    }
}

/// A stored payload (JSON text) as a reader may see it, or `None` when it is
/// fine as stored — nearly every row, which is then never parsed.
pub fn sanitize_payload(payload: &str) -> Option<String> {
    if !["agent_message", "system_message", "<msg ", "reply_to"].iter().any(|tag| payload.contains(tag)) {
        return None;
    }
    match serde_json::from_str::<Value>(payload) {
        Ok(mut value) => {
            sanitize_value(&mut value);
            serde_json::to_string(&value).ok()
        }
        Err(_) => Some(strip_sender_tags(payload).into_owned()),
    }
}

/// The row for display. The stored row is never changed.
pub fn sanitize_event(mut event: EventRecord) -> EventRecord {
    if let Some(clean) = event.payload.as_deref().and_then(sanitize_payload) {
        event.payload = Some(clean);
    }
    event
}

#[cfg(test)]
mod tests {
    use super::*;

    // core/src/__tests__/sender-tag.test.ts (stripSenderTags)
    #[test]
    fn wrappers_come_off_wherever_they_sit() {
        let strip = |text: &str| strip_sender_tags(text).into_owned();
        assert_eq!(strip("plain text"), "plain text");
        assert!(matches!(strip_sender_tags("plain <b>text</b>"), Cow::Borrowed(_)));
        assert_eq!(strip("<agent_message from=\"orch\" from-id=\"o-1\">\nDo it.\n</agent_message>"), "Do it.");
        assert_eq!(
            strip("before <system_message kind=\"report_reminder\">\nReport.\n</system_message> after"),
            "before Report. after"
        );
        assert_eq!(
            strip(
                "<agent_message from=\"a\">\none\n</agent_message>\n<system_message kind=\"k\">\ntwo\n</system_message>"
            ),
            "one\ntwo"
        );
        // A quoted wrapper inside a body was escaped on the way in and comes back literal.
        assert_eq!(
            strip(
                "<agent_message from=\"w\">\nI got &lt;system_message kind=\"x\">hi&lt;/system_message>\n</agent_message>"
            ),
            "I got <system_message kind=\"x\">hi</system_message>"
        );
        assert_eq!(strip("<msg id=\"m-0001\"/>\nHello"), "Hello");
        assert_eq!(
            strip("<msg id=\"m-2\"/>\n<reply_to id=\"m-1\" role=\"assistant\">\nquoted\n</reply_to>\nMy answer"),
            "My answer"
        );
        assert_eq!(strip("<reply_to id=\"m-1\"/>\nShort"), "Short");
        assert_eq!(strip("<agent_message from=\"a\">\nnever closed"), "<agent_message from=\"a\">\nnever closed");
    }

    // manager/shared/__tests__/display-sanitize.test.ts
    #[test]
    fn a_payload_is_rewritten_only_when_it_holds_a_wrapper() {
        assert_eq!(sanitize_payload(r#"{"text":"hello","n":1.5}"#), None);
        assert_eq!(
            sanitize_payload(r#"{"kind":"message_received","text":"<agent_message from=\"o\">\nGo.\n</agent_message>","n":2.0,"list":["<msg id=\"m-1\"/>\nHi",3]}"#).as_deref(),
            Some(r#"{"kind":"message_received","text":"Go.","n":2,"list":["Hi",3]}"#),
            "key order kept, strings stripped at any depth"
        );
        assert_eq!(sanitize_payload("not json <msg id=\"m-1\"/>\nHi").as_deref(), Some("not json Hi"));
        // The words alone do not make a wrapper: the payload is parsed and comes back unchanged in meaning.
        assert_eq!(
            sanitize_payload(r#"{"text":"the reply_to field"}"#).as_deref(),
            Some(r#"{"text":"the reply_to field"}"#)
        );

        let event = EventRecord {
            id: 1,
            worker_id: "w".into(),
            ts: 2,
            kind: "user_message".into(),
            payload: Some(r#"{"text":"<msg id=\"m-1\"/>\nHi"}"#.into()),
        };
        assert_eq!(sanitize_event(event).payload.as_deref(), Some(r#"{"text":"Hi"}"#));
    }
}
