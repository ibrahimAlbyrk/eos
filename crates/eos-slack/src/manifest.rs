//! What the `slack` built-in declares: its sign-in secret, its actions with
//! their classes and schemas (everything Slack returns that a person wrote
//! marked untrusted), the two sources, the candidates and how a message is
//! recognised from its permalink.

use eos_domain::capability::manifest::Manifest;
use serde_json::{Value, json};

/// The capability's id, and the channel its sends go through.
pub const ID: &str = "slack";
/// The secret the token pair is kept as (`eos-cap.slack.token`).
pub const TOKEN: &str = "token";
/// The kind of item it offers: one message.
pub const MESSAGE: &str = "slack.message";
/// A channel, a group or a direct message, for Which and Goes to.
pub const CONVERSATION: &str = "slack.conversation";
/// A message is recognised by its permalink.
pub const PERMALINK: &str = r"https://[\w-]+\.slack\.com/archives/([A-Z0-9]+)/p(\d{10})(\d{6})";
/// The longest text a post takes.
pub const TEXT_MAX: usize = 4_000;

fn text() -> Value {
    json!({ "type": "string" })
}

/// Text someone else wrote.
fn outside() -> Value {
    json!({ "type": "string", "untrusted": true })
}

fn int() -> Value {
    json!({ "type": "integer" })
}

fn flag() -> Value {
    json!({ "type": "boolean" })
}

fn list(items: Value) -> Value {
    json!({ "type": "array", "items": items })
}

fn object(properties: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": properties, "required": required })
}

fn id() -> Value {
    json!({ "type": "string", "minLength": 1, "maxLength": 40 })
}

fn limit(max: u32) -> Value {
    json!({ "type": "integer", "minimum": 1, "maximum": max })
}

fn post_text() -> Value {
    json!({ "type": "string", "minLength": 1, "maxLength": TEXT_MAX })
}

fn message() -> Value {
    object(
        json!({
            "ts": text(), "user": text(), "userName": outside(), "text": outside(), "threadTs": text(),
            "replies": int(),
        }),
        &["ts"],
    )
}

fn messages() -> Value {
    object(json!({ "messages": list(message()), "cursor": text() }), &["messages"])
}

fn receipt() -> Value {
    object(json!({ "conversation": text(), "ts": text(), "permalink": text() }), &["conversation", "ts"])
}

fn item() -> Value {
    object(
        json!({
            "key": text(), "event": text(), "title": outside(), "url": text(), "updatedAt": int(),
            "facts": object(json!({
                "conversation": text(), "from": text(), "fromMe": flag(), "mentionsMe": flag(), "isDm": flag(),
                "inThread": flag(),
            }), &[]),
            "data": object(json!({ "text": outside(), "userName": outside(), "threadTs": text() }), &[]),
        }),
        &["key", "event"],
    )
}

fn cursor() -> Value {
    object(json!({ "ts": text(), "seen": list(text()), "mentions": list(text()) }), &[])
}

fn polled() -> Value {
    object(
        json!({ "items": list(item()), "cursor": cursor(), "pollAfterS": int(), "baseline": flag() }),
        &["items", "cursor", "pollAfterS"],
    )
}

fn candidate() -> Value {
    object(
        json!({ "key": text(), "kind": text(), "title": outside(), "url": text(), "updatedAt": int(), "data": json!({"type": "object"}) }),
        &["key", "kind", "title", "updatedAt"],
    )
}

fn actions() -> Value {
    let kind = json!({ "type": "string", "enum": ["channel", "private", "dm", "group"] });
    json!([
        { "name": "check", "summary": "See that the Slack sign-in works.", "class": "read",
          "output": object(json!({ "ok": flag() }), &["ok"]) },
        { "name": "list_conversations", "summary": "List the channels, groups and direct messages you are in.",
          "class": "read",
          "input": object(json!({ "q": text(), "limit": limit(200) }), &[]),
          "output": object(json!({ "conversations": list(object(json!({
              "id": text(), "kind": kind, "name": outside(), "topic": outside(), "member": flag(),
          }), &["id", "kind"])) }), &["conversations"]) },
        { "name": "find_people", "summary": "Find people of your workspace by name or mail address.", "class": "read",
          "input": object(json!({ "q": { "type": "string", "minLength": 1 }, "limit": limit(50) }), &["q"]),
          "output": object(json!({ "people": list(object(json!({
              "id": text(), "name": outside(), "realName": outside(),
          }), &["id"])) }), &["people"]) },
        { "name": "read_conversation", "summary": "Read a conversation's messages, newest first.", "class": "read",
          "input": object(json!({ "conversation": id(), "since": text(), "cursor": text(), "limit": limit(100) }),
                          &["conversation"]),
          "output": messages() },
        { "name": "read_thread", "summary": "Read the replies of a thread.", "class": "read",
          "input": object(json!({ "conversation": id(), "threadTs": id(), "cursor": text(), "limit": limit(100) }),
                          &["conversation", "threadTs"]),
          "output": messages() },
        { "name": "search_messages", "summary": "Search the messages you can see.", "class": "read",
          "input": object(json!({ "q": { "type": "string", "minLength": 1 }, "limit": limit(50) }), &["q"]),
          "output": object(json!({ "matches": list(object(json!({
              "conversation": text(), "ts": text(), "user": text(), "userName": outside(), "text": outside(),
              "permalink": text(),
          }), &["conversation", "ts"])) }), &["matches"]) },
        { "name": "find_messages", "summary": "Messages for you to pick: recent ones that mention you, or a search.",
          "class": "read",
          "input": object(json!({ "q": text(), "limit": limit(50) }), &["limit"]),
          "output": object(json!({ "items": list(candidate()) }), &["items"]) },
        { "name": "poll_messages", "summary": "The messages of a conversation since the cursor.", "class": "read",
          "input": object(json!({ "conversation": id(), "cursor": cursor() }), &["conversation"]),
          "output": polled() },
        { "name": "poll_mentions", "summary": "The messages that mention you since the cursor.", "class": "read",
          "input": object(json!({ "cursor": cursor() }), &[]),
          "output": polled() },
        { "name": "find_delivery", "summary": "Find the message Eos posted for a delivery, by its marker.",
          "class": "read",
          "input": object(json!({ "conversation": id(), "threadTs": text(), "key": id(), "since": int() }),
                          &["conversation", "key"]),
          "output": object(json!({ "found": flag(), "ts": text(), "permalink": text() }), &["found"]) },
        { "name": "post_message", "summary": "Post a message as you to a channel, a group or a person.",
          "class": "speak", "recipient": "input:/to", "undo": "delete_message",
          "input": object(json!({ "to": id(), "text": post_text() }), &["to", "text"]),
          "output": receipt() },
        { "name": "reply_in_thread", "summary": "Reply as you in a message's thread.",
          "class": "speak", "recipient": "input:/conversation", "undo": "delete_message",
          "input": object(json!({ "conversation": id(), "threadTs": id(), "text": post_text() }),
                          &["conversation", "threadTs", "text"]),
          "output": receipt() },
        { "name": "tell_me", "summary": "Send yourself a direct message.", "class": "tell_user", "recipient": "user",
          "undo": "delete_message",
          "input": object(json!({ "text": post_text() }), &["text"]),
          "output": receipt() },
        { "name": "delete_message", "summary": "Delete a message you posted.", "class": "speak",
          "recipient": "input:/conversation",
          "input": object(json!({ "conversation": id(), "ts": id() }), &["conversation", "ts"]),
          "output": object(json!({ "deleted": flag() }), &["deleted"]) },
    ])
}

/// The manifest `BuiltinCapability::manifest` returns.
pub(crate) fn manifest() -> Manifest {
    let manifest = json!({
        "id": ID,
        "name": "Slack",
        "version": "1",
        "summary": "Your Slack workspace, as you: Eos reads your conversations and posts what you send.",
        "form": "builtin",
        "works": "any_mac",
        "reach": { "hosts": ["slack.com"] },
        "health": { "action": "check" },
        "secrets": [{ "name": TOKEN, "label": "Slack sign-in", "hosts": ["slack.com"] }],
        "actions": actions(),
        "sources": [
            { "name": "messages", "item": MESSAGE, "action": "poll_messages",
              "facts": { "conversation": "string", "from": "string", "fromMe": "bool", "mentionsMe": "bool",
                         "isDm": "bool", "inThread": "bool" },
              "events": ["posted"], "interval_s": 60, "min_interval_s": 30 },
            { "name": "mentions", "item": MESSAGE, "action": "poll_mentions",
              "facts": { "conversation": "string", "from": "string", "fromMe": "bool", "mentionsMe": "bool",
                         "isDm": "bool", "inThread": "bool" },
              "events": ["mentioned"], "interval_s": 60, "min_interval_s": 60 },
        ],
        "candidates": [{ "item": MESSAGE, "action": "find_messages" }],
        "items": [{ "kind": MESSAGE, "noun": "Slack message", "recognise": [PERMALINK] }],
    });
    // A test holds the manifest to the built-in check; this never fails.
    serde_json::from_value(manifest).unwrap_or_else(|e| panic!("the slack manifest does not parse: {e}"))
}
