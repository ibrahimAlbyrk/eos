use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use super::*;

/// Reads `value` with one key it does not know added, and writes it back
/// without that key, in the same order.
fn round_trip<T: DeserializeOwned + Serialize + Validate>(value: Value) -> T {
    let mut with_extra = value.clone();
    with_extra.as_object_mut().unwrap().insert("later".into(), json!({"x": 1}));
    let read: T = crate::parse(&with_extra).unwrap();
    assert_eq!(serde_json::to_string(&read).unwrap(), serde_json::to_string(&value).unwrap());
    read
}

fn row() -> Value {
    json!({
        "id": "github",
        "name": "GitHub",
        "summary": "Pull requests and reviews on GitHub.",
        "origin": "builtin",
        "state": "needs_setup",
        "stateCode": "client_id_missing",
        "version": "1",
        "works": "any_mac",
        "actionCount": 7,
        "usedBy": ["rt-1", "rt-2"],
        "accountLabel": "octocat",
        "form": "builtin",
    })
}

#[test]
fn a_row_reads_and_writes_back_in_camel_case_in_the_listed_order() {
    let read: CapabilityRow = round_trip(row());
    assert_eq!((read.action_count, read.used_by.len()), (7, 2));
    let bare: CapabilityRow = round_trip(json!({
        "id": "sms-messages", "name": "SMS", "summary": "Texts you.", "origin": "forge", "state": "ready",
        "works": "this_mac", "actionCount": 2, "usedBy": [], "form": "script",
    }));
    assert_eq!((bare.state_code, bare.version, bare.account_label), (None, None, None));
}

#[test]
fn a_detail_is_the_row_and_what_the_capability_is_made_of() {
    let mut detail = row();
    let rest = json!({
        "actions": [
            {"name": "post_review", "summary": "Post a review.", "class": "speak", "undo": "withdraw_review"},
            {"name": "approve_pull_request", "summary": "Approve.", "class": "irreversible"},
        ],
        "reach": {"hosts": ["api.github.com"], "apps": [], "files": []},
        "secrets": [{"name": "token", "label": "GitHub sign-in", "set": false}],
        "settings": [{"name": "phone_number", "label": "Your mobile number", "kind": "phone", "value": "+905550000000"},
                     {"name": "tone", "label": "Tone", "kind": "choice", "choices": ["warm", "plain"]}],
        "versions": [{"version": "1.0.1", "status": "installed", "createdAt": 20, "source": "rn-0a1b2c3d4e5f"},
                     {"version": "1.0.0", "status": "retired", "createdAt": 10, "source": "npm:pkg@1.0.0#sha512-x"}],
        "recentCalls": [{"action": "post_review", "outcome": "ok", "at": 30, "durationMs": 840}],
    });
    detail.as_object_mut().unwrap().extend(rest.as_object().unwrap().clone());
    let read: CapabilityDetail = round_trip(detail);
    assert_eq!(read.row.id, "github");
    assert_eq!(read.actions[0].class, crate::ActionClass::Speak);
    assert_eq!(read.actions[1].undo, None);
    let written = serde_json::to_string(&read).unwrap();
    assert!(written.starts_with(r#"{"id":"github","name":"GitHub""#), "the row's fields first: {written}");
    assert!(crate::parse::<CapabilityDetail>(&json!({"id": "x"})).is_err());
}

#[test]
fn an_item_the_topic_and_the_bodies_read_and_write_back() {
    let item: CapabilityItem = round_trip(json!({
        "key": "github:pr:acme/game#482",
        "kind": "github.pull_request",
        "title": "Fix the off-by-one",
        "url": "https://github.com/acme/game/pull/482",
        "updatedAt": 1_000,
        "data": {"repo": "acme/game", "draft": false},
    }));
    assert_eq!(item.data["repo"], "acme/game");
    round_trip::<CapabilityItem>(json!({"key": "mail:<a@b>", "kind": "mail.message", "title": "Hi",
                                        "updatedAt": 1, "data": null}));

    round_trip::<CapabilitiesChange>(json!({"id": "github", "state": "needs_sign_in", "stateCode": "http_401"}));
    round_trip::<CapabilitiesChange>(json!({"id": "sms-messages", "state": "ready", "version": "1.0.1"}));

    round_trip::<CapabilitySignIn>(
        json!({"userCode": "WDJB-MJHT", "verificationUri": "https://github.com/login/device",
                                          "expiresAt": 900_000}),
    );
    let status: CapabilitySignInStatus = round_trip(json!({"state": "signed_in", "accountLabel": "octocat"}));
    assert_eq!(status.state, CapabilitySignInState::SignedIn);
    for state in ["pending", "expired", "denied"] {
        round_trip::<CapabilitySignInStatus>(json!({"state": state}));
    }
    assert!(crate::parse::<CapabilitySignInStatus>(&json!({"state": "authorization_pending"})).is_err());

    let settings: CapabilitySettings =
        round_trip(json!({"values": {"phone_number": "+905550000000", "tone": "plain"}}));
    assert_eq!(settings.values.keys().collect::<Vec<_>>(), ["phone_number", "tone"], "in the order given");
    round_trip::<RollbackRequest>(json!({"version": "1.0.0"}));
    assert!(crate::parse::<RollbackRequest>(&json!({})).is_err());
}

#[test]
fn a_review_is_sent_as_the_input_of_its_github_action() {
    let review: PrReview = round_trip(json!({
        "repo": "acme/game",
        "number": 482,
        "commitId": "6dcb09b",
        "event": "COMMENT",
        "body": "Two notes.",
        "comments": [{"path": "src/main.rs", "line": 30, "side": "RIGHT", "body": "Why?"}],
    }));
    assert_eq!(review.comments[0].start_line, None);
    let bare: PrReview =
        round_trip(json!({"repo": "acme/game", "number": 1, "commitId": "a", "event": "APPROVE", "body": ""}));
    assert!(bare.comments.is_empty());
}
