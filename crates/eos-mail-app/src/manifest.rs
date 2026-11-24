//! What the `mail` built-in declares: no secret (Mail holds the accounts),
//! its actions with their classes and schemas (what a mail says marked
//! untrusted), and the inbox source.

use eos_domain::capability::manifest::Manifest;
use serde_json::{Value, json};

/// The capability's id, and the channel its sends go through.
pub const ID: &str = "mail";
/// The kind of item it offers: one received mail.
pub const MESSAGE: &str = "mail.message";
/// How long back the inbox is read.
pub const WINDOW_HOURS: i64 = 48;

fn text() -> Value {
    json!({ "type": "string" })
}

/// Text someone else wrote.
fn outside() -> Value {
    json!({ "type": "string", "untrusted": true })
}

fn object(properties: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": properties, "required": required })
}

fn message_id() -> Value {
    json!({ "type": "string", "minLength": 1, "description": "The mail's Message-ID" })
}

fn summary() -> Value {
    object(
        json!({
            "messageId": outside(), "subject": outside(), "from": outside(), "receivedAt": { "type": "integer" },
            "read": { "type": "boolean" },
        }),
        &["messageId", "receivedAt"],
    )
}

fn actions() -> Value {
    let cursor = object(json!({ "seen": { "type": "array", "items": text() } }), &[]);
    let item = object(
        json!({
            "key": outside(), "event": text(), "title": outside(), "updatedAt": { "type": "integer" },
            "facts": object(json!({ "from": outside() }), &[]),
        }),
        &["key", "event"],
    );
    json!([
        { "name": "check", "summary": "See that Mail answers and has an account.", "class": "read",
          "output": object(json!({ "ok": { "type": "boolean" } }), &["ok"]) },
        { "name": "recent_mail", "summary": "List the mail that reached your inboxes lately, newest first, without its text.",
          "class": "read",
          "input": object(json!({
              "hours": { "type": "integer", "minimum": 1, "maximum": WINDOW_HOURS },
              "limit": { "type": "integer", "minimum": 1, "maximum": 100 },
          }), &[]),
          "output": object(json!({ "messages": { "type": "array", "items": summary() } }), &["messages"]) },
        { "name": "read_mail", "summary": "Read one mail of your inboxes by its Message-ID.", "class": "read",
          "input": object(json!({ "messageId": message_id() }), &["messageId"]),
          "output": object(json!({
              "found": { "type": "boolean" }, "messageId": outside(), "subject": outside(), "from": outside(),
              "to": { "type": "array", "items": outside() }, "receivedAt": { "type": "integer" }, "body": outside(),
          }), &["found"]) },
        { "name": "poll_inbox", "summary": "The mail that reached your inboxes since the cursor.", "class": "read",
          "input": object(json!({ "cursor": cursor.clone() }), &[]),
          "output": object(json!({
              "items": { "type": "array", "items": item }, "cursor": cursor, "pollAfterS": { "type": "integer" },
              "baseline": { "type": "boolean" },
          }), &["items", "cursor", "pollAfterS"]) },
        { "name": "send_mail", "summary": "Send a mail to one address through Mail. It cannot be taken back.",
          "class": "speak", "recipient": "input:/to",
          "input": object(json!({
              "to": { "type": "string", "format": "email" }, "subject": text(), "body": text(),
              "html": text(),
              "images": { "type": "array", "items": object(json!({
                  "cid": text(), "contentType": text(), "data": text(),
              }), &["cid", "contentType", "data"]) },
              "pdf": text(),
          }), &["to", "subject", "body"]),
          "output": object(json!({ "sent": { "type": "boolean" } }), &["sent"]) },
    ])
}

/// The manifest `BuiltinCapability::manifest` returns.
pub(crate) fn manifest() -> Manifest {
    let manifest = json!({
        "id": ID,
        "name": "Mail",
        "version": "1",
        "summary": "Your mail, through the Mail app on this Mac: Eos reads your inboxes and sends as you.",
        "form": "builtin",
        "works": "this_mac",
        "health": { "action": "check" },
        "actions": actions(),
        "sources": [{
            "name": "inbox", "item": MESSAGE, "action": "poll_inbox",
            "facts": { "from": "string" },
            "events": ["received"],
            "interval_s": 60, "min_interval_s": 60,
        }],
    });
    // A test holds the manifest to the built-in check; this never fails.
    serde_json::from_value(manifest).unwrap_or_else(|e| panic!("the mail manifest does not parse: {e}"))
}
