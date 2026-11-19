use eos_contracts::{ActionClass, Issue, Issues};
use serde_json::{Value, json};

use super::check::{check, check_builtin};
use super::manifest::{Form, McpServer, Recipient, parse};
use super::schema::{self, Schema};

const VECTORS: &str = include_str!("../../../../fixtures/capabilities/manifests.json");

fn vectors() -> Value {
    serde_json::from_str(VECTORS).expect("manifests.json")
}

fn cases<'a>(vectors: &'a Value, group: &str) -> impl Iterator<Item = (&'a str, &'a str, &'a Value)> {
    vectors[group]
        .as_array()
        .expect("a group of vectors")
        .iter()
        .map(|case| (case["name"].as_str().expect("name"), case["toml"].as_str().expect("toml"), case))
}

fn issues(found: &[Issue]) -> Value {
    found.iter().map(|issue| json!({"path": issue.path.join("."), "message": issue.message})).collect()
}

#[test]
fn every_valid_manifest_reads_and_passes_the_check() {
    let vectors = vectors();
    for (name, toml, _) in cases(&vectors, "valid") {
        let manifest = parse(toml).unwrap_or_else(|e| panic!("{name}: {e}"));
        let found = if manifest.form == Form::Builtin { check_builtin(&manifest) } else { check(&manifest) };
        assert_eq!(issues(&found), json!([]), "{name}");
        let stored = serde_json::to_value(&manifest).expect("a manifest is JSON too");
        assert_eq!(serde_json::from_value::<super::manifest::Manifest>(stored).ok(), Some(manifest), "{name}");
    }
}

#[test]
fn each_invalid_manifest_gives_its_issues_in_the_order_of_its_fields() {
    let vectors = vectors();
    let mut count = 0;
    for (name, toml, case) in cases(&vectors, "invalid") {
        let manifest = parse(toml).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(issues(&check(&manifest)), case["issues"], "{name}");
        count += 1;
    }
    assert!(count >= 10);
}

#[test]
fn a_manifest_with_an_unknown_key_or_word_is_not_read() {
    let vectors = vectors();
    for (name, toml, case) in cases(&vectors, "unreadable") {
        let error = parse(toml).expect_err(name);
        let want = case["error"].as_str().expect("error");
        assert!(error.to_string().contains(want), "{name}: {error}");
    }
}

#[test]
fn the_reference_manifests_read_as_declared() {
    let vectors = vectors();
    let read = |at: usize| parse(vectors["valid"][at]["toml"].as_str().expect("toml")).expect("reads");
    let sms = read(0);
    assert_eq!((sms.id.as_str(), sms.form, sms.actions.len()), ("sms-messages", Form::Script, 2));
    let send = sms.action("send_to_me").expect("its action");
    assert_eq!((send.class, &send.recipient, send.timeout_s), (ActionClass::TellUser, &Recipient::User, 30));
    assert_eq!(sms.settings[0].name, "phone_number");

    let github = read(1);
    let post = github.action("post_review").expect("post_review");
    assert_eq!((&post.recipient, post.undo.as_str()), (&Recipient::Input("/pull".into()), "withdraw_review"));
    assert_eq!(github.action("check").map(|check| check.timeout_s), Some(30), "the default timeout");
    let source = &github.sources[0];
    assert_eq!(source.facts.keys().collect::<Vec<_>>(), ["repo", "labels", "draft", "size"], "facts in their order");
    assert_eq!(github.items[0].recognise, [r"github\.com/[^/]+/[^/]+/pull/\d+"]);

    match (read(2).server, read(3).server) {
        (Some(McpServer::Remote(remote)), Some(McpServer::Local(local))) => {
            assert_eq!(remote.header_secret.as_deref(), Some("api_key"));
            assert_eq!(local.run[0], "/opt/homebrew/bin/notes-mcp");
        }
        other => panic!("{other:?}"),
    }
}

fn compiled(schema: Value) -> Schema {
    schema::compile(&schema).expect("in the subset")
}

fn failures(schema: &Schema, value: Value) -> Vec<String> {
    let mut cx = Issues::default();
    schema.check(&value, &mut cx);
    cx.into_vec().iter().map(ToString::to_string).collect()
}

#[test]
fn input_is_checked_against_its_schema_in_the_words_of_todays_tools() {
    let review = compiled(json!({
        "type": "object",
        "required": ["pull", "event"],
        "properties": {
            "pull": {"type": "string", "minLength": 1},
            "event": {"type": "string", "enum": ["COMMENT", "REQUEST_CHANGES"]},
            "url": {"type": "string", "format": "uri"},
            "to": {"type": "string", "format": "email"},
            "at": {"type": "string", "format": "date-time"},
            "comments": {"type": "array", "maxItems": 1, "items": {
                "type": "object", "required": ["line"],
                "properties": {"line": {"type": "integer", "minimum": 1}, "weight": {"type": "number", "maximum": 1.5}},
            }},
            "draft": {"type": "boolean"},
            "body": {"type": "string", "maxLength": 3, "untrusted": true},
        },
    }));
    assert!(failures(&review, json!({"pull": "acme/game#4", "event": "COMMENT", "extra": 1})).is_empty());
    assert!(
        failures(
            &review,
            json!({"pull": "p", "event": "COMMENT", "url": "https://github.com/a", "to": "a@b.co",
                   "at": "2026-11-19T10:00:00Z", "comments": [{"line": 2, "weight": 1.5}], "draft": true, "body": "çok"})
        )
        .is_empty(),
        "a body of three characters fits, however many bytes"
    );
    assert_eq!(
        failures(
            &review,
            json!({"pull": "", "event": "APPROVE", "url": "github.com", "to": "nobody", "at": "yesterday",
                   "comments": [{"line": 0.5, "weight": 2}, {}], "draft": "yes", "body": "four"})
        ),
        [
            "pull: String must contain at least 1 character(s)",
            "event: Invalid enum value. Expected 'COMMENT' | 'REQUEST_CHANGES', received 'APPROVE'",
            "url: Invalid url",
            "to: Invalid email",
            "at: Invalid datetime",
            "comments: Array must contain at most 1 element(s)",
            "comments.0.line: Expected integer, received float",
            "comments.0.line: Number must be greater than or equal to 1",
            "comments.0.weight: Number must be less than or equal to 1.5",
            "comments.1.line: Required",
            "draft: Expected boolean, received string",
            "body: String must contain at most 3 character(s)",
        ]
    );
    assert_eq!(failures(&review, json!({})), ["pull: Required", "event: Required"]);
    assert_eq!(failures(&review, json!(["x"])), [": Expected object, received array"]);

    let mut cx = Issues::default();
    review.check(&json!({"event": "COMMENT", "pull": 4}), &mut cx);
    assert_eq!(
        schema::input_error("github", "post_review", &cx.into_vec()),
        "Input validation error: Invalid arguments for github.post_review: pull: Expected string, received number"
    );
    let mut cx = Issues::default();
    review.check(&json!(null), &mut cx);
    assert_eq!(
        schema::input_error("github", "post_review", &cx.into_vec()),
        "Input validation error: Invalid arguments for github.post_review: Expected object, received null"
    );
}

#[test]
fn a_schema_keeps_which_text_is_from_outside() {
    let listed = compiled(json!({"type": "array", "items": {"type": "object", "properties": {
        "title": {"type": "string", "untrusted": true}, "number": {"type": "integer"},
    }}}));
    let schema::Kind::Array { items, .. } = &listed.kind else { panic!("{listed:?}") };
    let schema::Kind::Object { properties, .. } = &items.kind else { panic!("{items:?}") };
    assert_eq!((properties["title"].untrusted, properties["number"].untrusted, listed.untrusted), (true, false, false));
    let issues =
        schema::compile(&json!({"type": "string", "untrusted": "yes", "required": ["a"]})).expect_err("refused");
    let found: Vec<String> = issues.iter().map(ToString::to_string).collect();
    assert_eq!(
        found,
        ["required: required is outside the supported schema subset for string", "untrusted: Expected boolean"]
    );
}
