//! What the `github` built-in declares: its sign-in, its actions with their
//! classes and schemas (text from GitHub marked untrusted), the pull request
//! source, the candidates action and how a pull request is recognised.

use eos_domain::capability::manifest::Manifest;
use serde_json::{Value, json};

/// The capability's id.
pub const ID: &str = "github";
/// The secret its token is kept as (`eos-cap.github.token`).
pub const TOKEN: &str = "token";
/// The kind of item it offers.
pub const PULL_REQUEST: &str = "github.pull_request";

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

fn repo() -> Value {
    json!({ "type": "string", "minLength": 3, "description": "owner/name" })
}

fn number() -> Value {
    json!({ "type": "integer", "minimum": 1 })
}

fn pull_input() -> Value {
    object(json!({ "repo": repo(), "number": number() }), &["repo", "number"])
}

fn summary() -> Value {
    object(
        json!({
            "number": int(), "title": outside(), "author": outside(), "url": text(), "state": text(),
            "draft": flag(), "headSha": text(), "base": text(), "updatedAt": int(),
        }),
        &[],
    )
}

fn receipt() -> Value {
    object(
        json!({
            "reviewId": int(), "url": text(), "state": text(), "stale": flag(),
            "notesOnOtherLines": int(), "alreadyPosted": flag(),
        }),
        &["reviewId", "state", "stale"],
    )
}

fn actions() -> Value {
    let comment = object(
        json!({
            "path": text(), "line": number(), "side": { "type": "string", "enum": ["LEFT", "RIGHT"] },
            "startLine": number(), "body": text(),
        }),
        &["path", "line", "body"],
    );
    let event = json!({ "type": "string", "enum": ["COMMENT", "REQUEST_CHANGES"] });
    let cursor = object(json!({ "etag": text(), "since": int(), "atSince": list(int()), "drafts": list(int()) }), &[]);
    let item = object(
        json!({
            "key": text(), "version": text(), "event": text(), "title": outside(), "url": text(), "updatedAt": int(),
            "facts": object(json!({
                "repo": text(), "author": outside(), "labels": list(outside()), "paths": list(outside()),
                "draft": flag(), "base": text(), "size": int(),
            }), &[]),
        }),
        &["key", "version", "event"],
    );
    let candidate = object(
        json!({ "key": text(), "kind": text(), "title": outside(), "url": text(), "updatedAt": int() }),
        &["key", "kind", "title", "updatedAt"],
    );
    json!([
        { "name": "check", "summary": "See that the GitHub sign-in works and may read repositories.", "class": "read",
          "output": object(json!({ "ok": flag() }), &["ok"]) },
        { "name": "list_pull_requests", "summary": "List a repository's pull requests, most recently updated first.",
          "class": "read",
          "input": object(json!({
              "repo": repo(), "state": { "type": "string", "enum": ["open", "closed", "all"] },
              "limit": { "type": "integer", "minimum": 1, "maximum": 100 },
          }), &["repo"]),
          "output": object(json!({ "pullRequests": list(summary()) }), &["pullRequests"]) },
        { "name": "get_pull_request", "summary": "Read a pull request: its text, author, head, base, labels and changed files.",
          "class": "read", "input": pull_input(),
          "output": object(json!({
              "number": int(), "title": outside(), "body": outside(), "author": outside(), "url": text(),
              "state": text(), "draft": flag(), "headSha": text(), "base": text(), "labels": list(outside()),
              "files": list(outside()),
          }), &["number", "headSha"]) },
        { "name": "get_pull_request_files", "summary": "Read the files a pull request changes, with their patches.",
          "class": "read", "input": pull_input(),
          "output": object(json!({ "files": list(object(json!({
              "path": outside(), "status": text(), "additions": int(), "deletions": int(), "patch": outside(),
          }), &["path"])) }), &["files"]) },
        { "name": "post_review", "summary": "Post a review of a pull request with line comments, as one request.",
          "class": "speak", "recipient": "input:/repo", "undo": "withdraw_review",
          "input": object(json!({
              "repo": repo(), "number": number(), "commitId": text(), "event": event, "body": text(),
              "comments": list(comment),
          }), &["repo", "number", "commitId", "event", "body"]),
          "output": receipt() },
        { "name": "withdraw_review", "summary": "Take a review back: delete its line comments and replace its text.",
          "class": "speak", "recipient": "input:/repo",
          "input": object(json!({ "repo": repo(), "number": number(), "reviewId": number() }),
                          &["repo", "number", "reviewId"]),
          "output": object(json!({
              "commentsDeleted": int(), "deleted": flag(),
              "dismissal": { "type": "string", "enum": ["not_needed", "done", "failed"] },
          }), &["commentsDeleted", "deleted", "dismissal"]) },
        { "name": "approve_pull_request", "summary": "Approve a pull request. It cannot be taken back.",
          "class": "irreversible", "recipient": "input:/repo",
          "input": object(json!({ "repo": repo(), "number": number(), "commitId": text(), "body": text() }),
                          &["repo", "number", "commitId"]),
          "output": receipt() },
        { "name": "poll_pull_requests", "summary": "The pull requests of a repository that changed since the cursor.",
          "class": "read",
          "input": object(json!({ "repo": repo(), "cursor": cursor.clone() }), &["repo"]),
          "output": object(json!({
              "items": list(item), "cursor": cursor, "pollAfterS": int(), "baseline": flag(),
          }), &["items", "cursor", "pollAfterS"]) },
        { "name": "find_review", "summary": "Find the review Eos sent for a delivery, by the marker it ends with.",
          "class": "read",
          "input": object(json!({ "repo": repo(), "number": number(), "key": { "type": "string", "minLength": 1 } }),
                          &["repo", "number", "key"]),
          "output": object(json!({ "found": flag(), "reviewId": int(), "url": text(), "state": text() }), &["found"]) },
        { "name": "find_pull_requests", "summary": "Pull requests for you to pick: open ones that involve you, or a repository's.",
          "class": "read",
          "input": object(json!({
              "q": text(), "limit": { "type": "integer", "minimum": 1, "maximum": 100 }, "repo": repo(),
              "state": { "type": "string", "enum": ["open", "closed", "all"] },
          }), &["limit"]),
          "output": object(json!({ "items": list(candidate) }), &["items"]) },
    ])
}

/// The manifest `BuiltinCapability::manifest` returns.
pub(crate) fn manifest() -> Manifest {
    let manifest = json!({
        "id": ID,
        "name": "GitHub",
        "version": "1",
        "summary": "Pull requests and reviews on GitHub, as the account you signed in with.",
        "form": "builtin",
        "works": "any_mac",
        "reach": { "hosts": ["api.github.com", "github.com"] },
        "health": { "action": "check" },
        "secrets": [{ "name": TOKEN, "label": "GitHub sign-in", "hosts": ["api.github.com"] }],
        "actions": actions(),
        "sources": [{
            "name": "pulls", "item": PULL_REQUEST, "action": "poll_pull_requests",
            "facts": {
                "repo": "string", "author": "string", "labels": "strings", "paths": "strings",
                "draft": "bool", "base": "string", "size": "number",
            },
            "events": ["opened", "updated", "ready", "closed"],
            "closing": ["closed"],
            "interval_s": 60, "min_interval_s": 30,
        }],
        "candidates": [{ "item": PULL_REQUEST, "action": "find_pull_requests" }],
        "items": [{
            "kind": PULL_REQUEST, "noun": "pull request",
            "recognise": [r"https://github\.com/([\w.-]+)/([\w.-]+)/pull/(\d+)", r"(?:^|\s)#(\d+)\b"],
        }],
    });
    // A test holds the manifest to the built-in check; this never fails.
    serde_json::from_value(manifest).unwrap_or_else(|e| panic!("the github manifest does not parse: {e}"))
}
