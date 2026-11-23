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

#[test]
fn rows_keep_their_recorded_order_and_drop_unknown_keys() {
    round_trip::<SurfaceRow>(json!({
        "id": "sf-0a1b2c3d4e5f", "routineId": "rt-1", "level": "view", "place": "needs_you", "role": "result",
        "title": "Overnight mail", "currentVersion": 2, "needsRedesign": ["stories[0].title"],
        "createdAt": 1, "updatedAt": 2}));
    round_trip::<SurfaceIssueRow>(json!({
        "id": "si-0a1b2c3d4e5f", "surfaceId": "sf-0a1b2c3d4e5f", "seq": 4, "runId": "rn-1", "kind": "view",
        "status": "ready", "rev": 1, "trial": false, "kept": false, "createdAt": 1, "updatedAt": 1}));
    round_trip::<ActionRecord>(json!({
        "id": "da-0a1b2c3d4e5f", "clientId": "c-1", "actionId": "routine.run_again", "issueId": "si-1",
        "routineId": "rt-1", "origin": "dashboard", "class": "write_local", "args": {}, "decision": "run",
        "status": "done", "createdAt": 1, "finishedAt": 2}));
}

#[test]
fn answers_are_tagged_by_status() {
    let held = ActionAnswer::Held { record_id: "da-1".into(), item_id: "nd-1".into() };
    assert_eq!(serde_json::to_value(&held).unwrap(), json!({"status": "held", "recordId": "da-1", "itemId": "nd-1"}));
    let refused: ActionAnswer = crate::parse(&json!({"status": "refused", "reason": "This is a dev run"})).unwrap();
    assert_eq!(refused, ActionAnswer::Refused { record_id: None, reason: "This is a dev run".into() });
}

#[test]
fn a_run_request_carries_no_arguments_and_needs_a_target() {
    let ok: ActionRunRequest =
        crate::parse(&json!({"issueId": "si-1", "actionId": "again", "clientId": "c-1", "args": {"to": "x"}})).unwrap();
    assert_eq!(ok.action_id.as_deref(), Some("again"));
    assert!(crate::parse::<ActionRunRequest>(&json!({"clientId": "c-1"})).is_err());
    assert!(crate::parse::<ActionRunRequest>(&json!({"button": "b", "clientId": "c-1"})).is_err());
    assert!(crate::parse::<ActionRunRequest>(&json!({"actionId": "a", "clientId": " "})).is_err());
}

#[test]
fn surface_settings_take_only_their_steps() {
    assert_eq!(
        round_trip::<SurfaceSettings>(json!({"textScale": 100, "contrast": "normal", "plain": false})),
        SurfaceSettings::default()
    );
    assert!(crate::parse::<SurfaceSettings>(&json!({"textScale": 120, "contrast": "normal", "plain": false})).is_err());
    assert!(crate::parse::<SurfaceSettings>(&json!({"textScale": 100, "contrast": "loud", "plain": false})).is_err());
}
